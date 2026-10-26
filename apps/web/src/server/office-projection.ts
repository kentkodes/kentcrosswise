// Connected-office public projection read adapter (docs/office/LIVE-CONTRACT.md "Versioned read
// interface", "Consistency, ordering and privacy changes", ordered unit 2). Reads only the
// sanitized v_office_* views of migration 0006 as web_public. Snapshot, event page, replay and
// watermark come from ONE SQL statement, so they share one database snapshot (READ COMMITTED
// takes one snapshot per statement; the caller's BEGIN READ ONLY alone would not promise that
// for several statements). Not wired to a route or page yet.
import {
  OFFICE_LIMITS,
  compareOfficePositions,
  parseOfficeEnvelope,
  type AvailableOffice,
  type OfficeEnvelope,
  type OfficeEvent,
  type OfficeExecution,
  type OfficeGap,
  type OfficeHistory,
  type OfficePosition,
  type OfficeRelation,
  type OfficeTask,
} from "../office-contract";
import { dbErrorLabel, withDb, type Queryable } from "./db";

export const OFFICE_PAGE_DEFAULT = 50;
export const OFFICE_REPLAY_SIZE = 20;

/** bootstrap: snapshot + latest-20 replay; state: snapshot only; incremental: page after a cursor. */
export type OfficeRequest =
  | { mode: "bootstrap" }
  // privacy_epoch: the client's accepted epoch; an older one gets the privacy_changed response
  // with invalidations on this state refresh too.
  | { mode: "state"; privacy_epoch?: string }
  // rebind: the client applied the invalidations of an earlier privacy_changed response and
  // continues from the same position under the current epoch.
  | { mode: "incremental"; cursor: string; limit?: number; rebind?: boolean };

/** A malformed request (cursor or page size). Raised before any database access. */
export class OfficeRequestError extends Error {
  override name = "OfficeRequestError";
  constructor(readonly code: "cursor" | "limit" | "epoch") {
    super(`invalid office request (${code})`);
  }
}

// ---------------------------------------------------------------- cursor
// Opaque base64url of "o1.<generation uuid>.<epoch>.<revision>.<ordinal>.<watermark revision>.<watermark ordinal>".
// Not signed: it carries only public projection values, and the server re-checks every part
// against the current state (generation, epoch, position <= watermark <= current watermark).
const CURSOR_TAG = "o1";
const UUID4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const COUNTER = "(?:0|[1-9][0-9]{0,18})";
const CURSOR_BODY = new RegExp(`^${CURSOR_TAG}\\.(${UUID4})\\.(${COUNTER})\\.(${COUNTER})\\.([0-9]{1,5})\\.(${COUNTER})\\.([0-9]{1,5})$`);
const BIGINT_MAX = 9223372036854775807n;

export interface OfficeCursor {
  generation: `gen_${string}`;
  privacy_epoch: string;
  position: OfficePosition;
  watermark: OfficePosition;
}

export function encodeOfficeCursor(c: OfficeCursor): string {
  const body = [CURSOR_TAG, c.generation.slice(4), c.privacy_epoch, c.position.revision, c.position.ordinal, c.watermark.revision, c.watermark.ordinal];
  return `cur_${Buffer.from(body.join("."), "utf8").toString("base64url")}`;
}

function position(revision: string, ordinal: string): OfficePosition {
  const result = { revision, ordinal: Number(ordinal) };
  if (BigInt(revision) > BIGINT_MAX || result.ordinal > OFFICE_LIMITS.ordinal || (revision === "0" && result.ordinal !== 0)) {
    throw new OfficeRequestError("cursor");
  }
  return result;
}

/** Strict decode: canonical encoding only; throws OfficeRequestError("cursor"). */
export function decodeOfficeCursor(token: unknown): OfficeCursor {
  if (typeof token !== "string" || token.length > OFFICE_LIMITS.cursor || !/^cur_[A-Za-z0-9_-]{16,508}$/.test(token)) {
    throw new OfficeRequestError("cursor");
  }
  const body = Buffer.from(token.slice(4), "base64url").toString("utf8");
  const m = CURSOR_BODY.exec(body);
  if (!m) throw new OfficeRequestError("cursor");
  const [, generation, epoch, rev, ord, wrev, word] = m as unknown as [string, string, string, string, string, string, string];
  if (BigInt(epoch) > BIGINT_MAX) throw new OfficeRequestError("cursor");
  const cursor: OfficeCursor = {
    generation: `gen_${generation}`,
    privacy_epoch: epoch,
    position: position(rev, ord),
    watermark: position(wrev, word),
  };
  if (compareOfficePositions(cursor.position, cursor.watermark) > 0 || encodeOfficeCursor(cursor) !== token) {
    throw new OfficeRequestError("cursor");
  }
  return cursor;
}

// ---------------------------------------------------------------- the one statement
// $1/$2 position after which the page starts, $3 page rows to fetch (0 = none), $4 include the
// latest-20 replay, $5 list redactions after this privacy epoch (NULL = none; at most
// OFFICE_LIMITS.invalidations + 1 are read, more means "restart"). Invalidated tasks join the
// snapshot with their CURRENT row, so the client can relabel them.
// Snapshot tasks = active tasks + tasks of returned events + their parents (relation targets),
// so every reference in the response resolves inside the same response.
const READ_SQL = `
WITH st AS (SELECT * FROM v_office_state),
inv AS (
  SELECT DISTINCT i.task_ref, i.kind FROM v_office_invalidations i
  WHERE $5::bigint IS NOT NULL AND i.privacy_epoch > $5::bigint
  LIMIT ${OFFICE_LIMITS.invalidations + 1}
),
page AS (
  SELECT e.* FROM v_office_events e
  WHERE $3::int > 0 AND (e.revision, e.ordinal) > ($1::bigint, $2::int)
  ORDER BY e.revision, e.ordinal LIMIT $3::int
),
replay AS (
  SELECT e.* FROM v_office_events e WHERE $4::boolean
  ORDER BY e.revision DESC, e.ordinal DESC LIMIT ${OFFICE_REPLAY_SIZE}
),
base AS (
  SELECT t.ref FROM v_office_tasks t WHERE t.active
  UNION SELECT p.task_ref FROM page p WHERE p.task_ref IS NOT NULL
  UNION SELECT r.task_ref FROM replay r WHERE r.task_ref IS NOT NULL
  UNION SELECT i.task_ref FROM inv i
),
inc AS (
  SELECT b.ref FROM base b
  UNION SELECT t.parent_ref FROM v_office_tasks t JOIN base b ON b.ref = t.ref WHERE t.parent_ref IS NOT NULL
),
tasks AS (SELECT t.* FROM v_office_tasks t JOIN inc ON inc.ref = t.ref),
execs AS (
  SELECT x.* FROM v_office_executions x
  WHERE x.ref IN (SELECT execution_ref FROM tasks UNION SELECT execution_ref FROM page UNION SELECT execution_ref FROM replay)
),
rels AS (
  SELECT c.ref AS task_ref, c.parent_ref AS related_task_ref, c.parent_kind AS kind, p.visibility, p.description
  FROM tasks c JOIN tasks p ON p.ref = c.parent_ref
  WHERE c.ref IN (SELECT ref FROM base)
)
SELECT jsonb_build_object(
  'observed_at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'state', (SELECT jsonb_build_object(
      'generation', s.generation, 'revision', s.revision::text, 'privacy_epoch', s.privacy_epoch::text,
      'watermark_ordinal', s.watermark_ordinal, 'oldest_revision', s.oldest_revision::text, 'oldest_ordinal', s.oldest_ordinal,
      'paused', s.paused, 'paused_observed_at', s.paused_observed_at,
      'execution_observations', s.execution_observations, 'deployment_events', s.deployment_events,
      'routing_events', s.routing_events) FROM st s),
  'page', (SELECT COALESCE(jsonb_agg(to_jsonb(p) || jsonb_build_object('revision', p.revision::text) ORDER BY p.revision, p.ordinal), '[]') FROM page p),
  'replay', (SELECT COALESCE(jsonb_agg(to_jsonb(r) || jsonb_build_object('revision', r.revision::text) ORDER BY r.revision, r.ordinal), '[]') FROM replay r),
  'tasks', (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.ref), '[]') FROM tasks t),
  'executions', (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.ref), '[]') FROM execs x),
  'relations', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.task_ref, r.related_task_ref), '[]') FROM rels r),
  'invalidations', (SELECT COALESCE(jsonb_agg(jsonb_build_object('task_ref', i.task_ref, 'kind', i.kind) ORDER BY i.task_ref), '[]') FROM inv i)
) AS office`;

// Row shapes as the views return them (jsonb keys = view columns).
interface StateRow {
  generation: `gen_${string}`; revision: string; privacy_epoch: string; watermark_ordinal: number;
  oldest_revision: string | null; oldest_ordinal: number | null; paused: boolean | null; paused_observed_at: string | null;
  execution_observations: boolean; deployment_events: boolean; routing_events: boolean;
}
interface EventRow {
  ref: OfficeEvent["ref"]; revision: string; ordinal: number; recorded_at: string; role: OfficeEvent["role"]; type: OfficeEvent["type"];
  task_ref: OfficeEvent["task_ref"]; execution_ref: OfficeEvent["execution_ref"]; visibility: OfficeEvent["visibility"]; description: string;
}
interface TaskRow extends OfficeTask { parent_ref: string | null; parent_kind: string | null; active: boolean }
interface ExecRow {
  ref: OfficeExecution["ref"]; task_ref: OfficeExecution["task_ref"]; role: OfficeExecution["role"];
  station: NonNullable<OfficeExecution["assignment"]>["station"] | null; seat: number | null;
  phase: OfficeExecution["phase"]; outcome: OfficeExecution["outcome"];
  observation_source: NonNullable<OfficeExecution["observation"]>["source"] | null; observed_at: string | null;
  reported_activity: OfficeExecution["reported_activity"]; reported_at: string | null;
}
interface ReadRow {
  observed_at: string; state: StateRow; page: EventRow[]; replay: EventRow[]; tasks: TaskRow[];
  executions: ExecRow[]; relations: OfficeRelation[]; invalidations: { task_ref: OfficeTask["ref"]; kind: "redact" | "relabel" }[];
}

// Explicit field-by-field copies: only allowlisted fields leave this module.
const toEvent = (e: EventRow): OfficeEvent => ({
  ref: e.ref, position: { revision: e.revision, ordinal: e.ordinal }, recorded_at: e.recorded_at, role: e.role, type: e.type,
  task_ref: e.task_ref, execution_ref: e.execution_ref, visibility: e.visibility, description: e.description,
});
const toTask = (t: TaskRow): OfficeTask => ({
  ref: t.ref, visibility: t.visibility, description: t.description, kind: t.kind, state: t.state,
  waiting_on: t.waiting_on, paused: t.paused, role: t.role, execution_ref: t.execution_ref,
});
const toExecution = (x: ExecRow): OfficeExecution => ({
  ref: x.ref, task_ref: x.task_ref, role: x.role,
  assignment: x.station === null ? null : { station: x.station, seat: x.seat },
  phase: x.phase, outcome: x.outcome,
  observation: x.observation_source === null || x.observed_at === null ? null : { source: x.observation_source, observed_at: x.observed_at },
  reported_activity: x.reported_activity, reported_at: x.reported_at,
});
const toRelation = (r: OfficeRelation): OfficeRelation => ({
  task_ref: r.task_ref, related_task_ref: r.related_task_ref, kind: r.kind, visibility: r.visibility, description: r.description,
});
const bounded = <T>(items: T[], max: number): T[] | null => (items.length > max ? null : items);

const COUNTER_RE = /^(?:0|[1-9][0-9]{0,18})$/;

function checkRequest(request: OfficeRequest): { cursor: OfficeCursor | null; limit: number; epoch: string | null } {
  if (request.mode === "state") {
    const epoch: unknown = request.privacy_epoch ?? null;
    if (epoch !== null && (typeof epoch !== "string" || !COUNTER_RE.test(epoch) || BigInt(epoch) > BIGINT_MAX)) throw new OfficeRequestError("epoch");
    return { cursor: null, limit: 0, epoch };
  }
  if (request.mode !== "incremental") return { cursor: null, limit: 0, epoch: null };
  const limit = request.limit ?? OFFICE_PAGE_DEFAULT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > OFFICE_LIMITS.page) throw new OfficeRequestError("limit");
  const cursor = decodeOfficeCursor(request.cursor);
  return { cursor, limit, epoch: cursor.privacy_epoch };
}

/**
 * One projection read as an AvailableOffice envelope. Malformed cursors throw OfficeRequestError
 * before the query; incompatible ones (other generation, older privacy epoch, a position beyond
 * the current watermark) return an explicit gap/recovery response instead of events.
 * Privacy: an older client epoch (cursor or state request) gets every description withdrawn
 * since then as an invalidation (redact if private now, relabel if public now), with the
 * task's current row in the snapshot; more than
 * OFFICE_LIMITS.invalidations, or a task inventory over its limit, gets an explicit restart.
 */
export async function readOfficeProjection(db: Queryable, request: OfficeRequest): Promise<AvailableOffice> {
  const { cursor, limit, epoch } = checkRequest(request);
  const { rows } = await db.query<{ office: ReadRow }>(READ_SQL, [
    cursor?.position.revision ?? "0",
    cursor?.position.ordinal ?? 0,
    cursor ? limit + 1 : 0,
    request.mode === "bootstrap",
    epoch,
  ]);
  const row = rows[0]!.office;
  const s = row.state;
  const watermark: OfficePosition = { revision: s.revision, ordinal: s.watermark_ordinal };
  const oldest: OfficePosition | null = s.oldest_revision === null ? null : { revision: s.oldest_revision, ordinal: s.oldest_ordinal ?? 0 };
  const tasks = bounded(row.tasks.map(toTask), OFFICE_LIMITS.tasks);
  const base: Omit<AvailableOffice, "events" | "history"> = {
    version: 1, available: true, generation: s.generation, privacy_epoch: s.privacy_epoch, observed_at: row.observed_at, revision: s.revision,
    snapshot: {
      tasks,
      executions: bounded(row.executions.map(toExecution), OFFICE_LIMITS.executions),
      related_tasks: tasks === null ? null : bounded(row.relations.map(toRelation), OFFICE_LIMITS.relations),
      pause: { paused: s.paused, observed_at: s.paused === null ? null : s.paused_observed_at },
    },
    capabilities: { execution_observations: s.execution_observations, deployment_events: s.deployment_events, routing_events: s.routing_events },
  };
  const history = (h: Partial<OfficeHistory>): OfficeHistory => ({
    mode: request.mode, generation: s.generation, privacy_epoch: s.privacy_epoch, from: null, through: null, cursor: null,
    watermark, oldest_available: oldest, has_more: false, completeness: "complete", replay: null, gap: null, invalidations: [], ...h,
  });
  const cursorAt = (at: OfficePosition) => encodeOfficeCursor({ generation: s.generation, privacy_epoch: s.privacy_epoch, position: at, watermark });
  const gap = (reason: OfficeGap["reason"], from: OfficePosition | null, recovery: OfficeGap["recovery"], extra: Partial<OfficeHistory> = {}): AvailableOffice => ({
    ...base, events: [],
    history: history({ from, completeness: "gap", gap: { reason, from, through: null, recovery }, ...extra }),
  });

  if (request.mode === "bootstrap") {
    const replay = row.replay.map(toEvent);
    const first = replay[0]?.position ?? null;
    return {
      ...base, events: [],
      history: history({
        through: watermark, cursor: cursorAt(watermark),
        // Complete = the window reaches the generation's first journal entry (no backfill of
        // pre-0006 agent_events exists; history is per projection generation).
        replay: { events: replay, from: first, through: replay.at(-1)?.position ?? null, completeness: first === null || (oldest !== null && compareOfficePositions(first, oldest) === 0) ? "complete" : "partial" },
      }),
    };
  }

  if (cursor && cursor.generation !== s.generation) return gap("generation_changed", null, "restart");
  if ((cursor && compareOfficePositions(cursor.watermark, watermark) > 0) || (epoch !== null && BigInt(epoch) > BigInt(s.privacy_epoch))) {
    return gap("cursor_unavailable", null, "restart");
  }
  const stale = epoch !== null && BigInt(epoch) < BigInt(s.privacy_epoch);
  const from = cursor?.position ?? null;
  // Too many withdrawals to list, or no task inventory to carry the replacement labels: the
  // client must restart from a fresh bootstrap rather than receive an unparseable envelope.
  if (stale && (row.invalidations.length > OFFICE_LIMITS.invalidations || tasks === null)) return gap("privacy_changed", from, "restart");
  const invalidations = stale ? row.invalidations.map((i) => ({ task_ref: i.task_ref, kind: i.kind })) : [];
  if (stale && !(request.mode === "incremental" && request.rebind === true)) return gap("privacy_changed", from, "rebind", { invalidations });
  if (request.mode === "state") return { ...base, events: [], history: history({}) };

  const c = cursor!;
  const page = row.page.slice(0, limit).map(toEvent);
  const through = page.at(-1)?.position ?? c.position;
  const hasMore = row.page.length > limit;
  return {
    ...base, events: page,
    history: history({
      from: c.position, through, cursor: cursorAt(through), has_more: hasMore,
      completeness: hasMore ? "partial" : "complete", invalidations,
    }),
  };
}

export const OFFICE_READ_TIMEOUT_SQL = "SET LOCAL statement_timeout = '3s'";

const UNAVAILABLE: OfficeEnvelope = {
  version: 1, available: false, generation: null, privacy_epoch: null, observed_at: null, revision: null,
  snapshot: null, events: [], history: null, capabilities: null,
};

/**
 * The envelope for a future GET /api/public/office. Request errors propagate (a 400 for the
 * route); a missing or failing database, or output that fails the unit-1 parser, becomes the
 * content-free unavailable envelope with one log line (error class / SQLSTATE / parser code only).
 */
export async function loadOfficeProjection(
  request: OfficeRequest,
  run: <T>(fn: (db: Queryable) => Promise<T>) => Promise<T> = (fn) => withDb("web_public", fn, { readOnly: true }),
): Promise<OfficeEnvelope> {
  checkRequest(request);
  let envelope: AvailableOffice;
  try {
    envelope = await run(async (db) => {
      // Bound the anonymous public read inside its own web_public transaction (P2-1); a timeout
      // (57014) becomes the unavailable envelope below. SET LOCAL ends with this transaction.
      await db.query(OFFICE_READ_TIMEOUT_SQL);
      return readOfficeProjection(db, request);
    });
  } catch (err) {
    console.error(`[office] ${dbErrorLabel(err)}`);
    return { ...UNAVAILABLE, events: [] };
  }
  const checked = parseOfficeEnvelope(envelope);
  if (!checked.ok) {
    console.error(`[office] invalid projection (${checked.code})`);
    return { ...UNAVAILABLE, events: [] };
  }
  return checked.value;
}
