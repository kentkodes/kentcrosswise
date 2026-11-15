// Entry routing (H3). DeepSeek picks the kind of each captured entry. A low-confidence pick goes to the
// owner's inbox, and the owner can reassign any entry (a changed route is stored as a correction). Owner pages
// only; runs as web_rw. It writes the entry's route and outcome (error code, attempts, last attempt time),
// the derived record (derived.ts), usage_events and inbox_items. Logs carry codes and error classes, never
// entry text or provider messages.
import {
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
  DeepseekProvider,
  callEventStatement,
  type CallEvent,
  type ModelProvider,
  type UsageRecord,
} from "@kcw/core/models";
import { getSecret, SecretKeyMissingError } from "@kcw/secrets";
import { ROUTE_LABELS, type RouteError, type RouteKind } from "./capture";
import { withDb, type Queryable } from "./db";
import { linkCrmNote } from "./contacts";
import { applyRoute } from "./derived";
import { capReachedUsd, monthToDateRange, spendDecisionLine, usageSummary } from "./usage";

/** Entries the model is less sure of than this go to the owner's inbox (0.59 goes, 0.6 is routed). */
export const ROUTE_THRESHOLD = 0.6;

/** The owner waits on the capture, so the model call gets one timeout and at most one retry. */
const ROUTE_TIMEOUT_MS = 8000;
const ROUTE_RETRIES = 1;

/** Names the router secret, kcw/prod/router: the DeepSeek key, readable by the web server only (env holds the name only, D9). Unset means routing is off (preview and local). */
export const MODELS_SECRET_ENV = "KCW_MODELS_SECRET";
const API_KEY = "deepseek_api_key";
const BASE_URL_KEY = "deepseek_base_url";
const MODEL_KEY = "deepseek_model";

const KINDS = Object.keys(ROUTE_LABELS) as RouteKind[];

export const ROUTER_INSTRUCTIONS = [
  "Choose the one label that best describes the entry the owner wrote:",
  "crm_note: about a specific person (something they said, did, or a plan with them).",
  "diary: feelings, or how the day went.",
  "todo: something to do.",
  "idea: an idea or a project thought.",
  "agent_request: asks the site's agents to build or change something on this website.",
].join("\n");

export type Env = Readonly<Record<string, string | undefined>>;

export function isRouteKind(v: unknown): v is RouteKind {
  return typeof v === "string" && Object.hasOwn(ROUTE_LABELS, v);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isEntryId(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

/** Routing is on when the models secret is named in the environment (production only). */
export function routingEnabled(env: Env): boolean {
  return Boolean(env[MODELS_SECRET_ENV]);
}

/**
 * The DeepSeek provider for this environment, or undefined when routing is off. The API key is read when the
 * provider first needs it (through getSecret); the optional base URL and model are read here, as in the
 * categorize script. A failing read throws; callers turn that into a failed route, never a failed capture.
 */
export async function routerFromEnv(env: Env): Promise<ModelProvider | undefined> {
  const name = env[MODELS_SECRET_ENV];
  if (!name) return undefined;
  const read = (key: string) => getSecret(name, key);
  const optional = (key: string) =>
    read(key).then(
      (v) => v.trim(),
      (err: unknown) => {
        if (err instanceof SecretKeyMissingError) return "";
        throw err;
      },
    );
  const [baseUrl, model] = await Promise.all([optional(BASE_URL_KEY), optional(MODEL_KEY)]);
  return new DeepseekProvider({
    apiKey: () => read(API_KEY),
    baseUrl: baseUrl || DEFAULT_DEEPSEEK_BASE_URL,
    model: model || DEFAULT_DEEPSEEK_MODEL,
    timeoutMs: ROUTE_TIMEOUT_MS,
    retry: { retries: ROUTE_RETRIES },
    // AR3: every request (each retry attempt) is a call record, written with its own withDb call
    // (never inside a routing transaction: the pool has one connection).
    onCall: (e) => withDb("web_rw", (db) => recordRouterCall(db, e)),
  });
}

/** One call event of the router provider (routing and mood scoring) as a usage_events call record (agent router, AR3). */
export async function recordRouterCall(db: Queryable, e: CallEvent): Promise<void> {
  const s = callEventStatement("router", e);
  await db.query(s.text, s.values);
}

/** Legacy: one model call as a usage_events row (kind model, agent router), kept for callers of `onUsage`. New code uses recordRouterCall. */
export async function recordRouterUsage(db: Queryable, u: UsageRecord): Promise<void> {
  await db.query(
    "INSERT INTO usage_events (kind, agent, provider, model, input_tokens, output_tokens) VALUES ('model', 'router', $1, $2, $3, $4)",
    [u.provider, u.model, u.inputTokens, u.outputTokens],
  );
}

/** Runs a function in one web_rw transaction. Routing never calls the model inside one (the pool has one connection). */
export type DbRun = <T>(fn: (db: Queryable) => Promise<T>) => Promise<T>;
export const routerDb: DbRun = (fn) => withDb("web_rw", fn);

/** The derived row a route created (null/absent when none: agent_request, or it already existed). */
export type DerivedRow = { kind: RouteKind; id: string };

export type RouteOutcome =
  | { code: "routed"; kind: RouteKind; derived?: DerivedRow | null }
  | { code: "needs_owner"; kind: RouteKind }
  | { code: "already" | "cap" | "off" | "error" };

/**
 * applyRoute plus contact linking for a new CRM note, in the caller's transaction. The link step runs in a
 * savepoint: if it fails, only the link is rolled back (the route and the note are kept, the note stays unlinked)
 * and the error class is logged.
 */
export async function applyRouteLinked(
  db: Queryable,
  entryId: string,
  from: RouteKind | null,
  to: RouteKind,
): Promise<DerivedRow | null> {
  const created = await applyRoute(db, entryId, from, to);
  if (created?.kind === "crm_note") {
    await db.query("SAVEPOINT link_note");
    try {
      await linkCrmNote(db, created.id);
      await db.query("RELEASE SAVEPOINT link_note");
    } catch (err) {
      console.error(`[router] link-${errorClass(err)}`);
      await db.query("ROLLBACK TO SAVEPOINT link_note");
      await db.query("RELEASE SAVEPOINT link_note");
    }
  }
  return created;
}

/** The first 60 characters of the text on one line, with an ellipsis when cut. */
export function routingTitle(text: string): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return `Routing: ${chars.slice(0, 60).join("")}${chars.length > 60 ? "…" : ""}`;
}

/**
 * Routes one entry. Reads the entry and the monthly spend first (skipped when it is routed or the cap is reached),
 * calls the model with no transaction open, then writes the route, the inbox item and nothing else in one transaction.
 * The write only applies while the entry is still unrouted, so an owner's choice made during the call is kept.
 * Provider errors are logged by class and return "error": the entry stays pending.
 */
export async function routeEntry(run: DbRun, entryId: string, provider: ModelProvider): Promise<RouteOutcome> {
  const before = await run(async (db) => {
    const { rows } = await db.query<{ route_kind: string | null; raw_text: string }>(
      "SELECT route_kind, raw_text FROM entries WHERE id = $1",
      [entryId],
    );
    const row = rows[0];
    if (!row) return { state: "error" as const };
    if (row.route_kind !== null) return { state: "already" as const };
    const spent = await usageSummary(db, monthToDateRange());
    if (capReachedUsd(spent.total.costUsd)) {
      console.error(`[router] ${spendDecisionLine(spent)}`);
      return { state: "cap" as const };
    }
    return { state: "ready" as const, text: row.raw_text };
  });
  if (before.state === "cap") await recordFailure(run, entryId, "spend_cap");
  if (before.state !== "ready") return { code: before.state };

  let answer: Awaited<ReturnType<ModelProvider["classify"]>>;
  try {
    answer = await provider.classify(before.text, KINDS, {
      instructions: ROUTER_INSTRUCTIONS,
      call: { purpose: "route", subject: { kind: "entry", id: entryId } },
    });
  } catch (err) {
    console.error(`[router] ${errorClass(err)}`);
    await recordFailure(run, entryId, "provider_error");
    return { code: "error" };
  }
  if (!isRouteKind(answer.label)) {
    console.error("[router] label-not-in-set");
    await recordFailure(run, entryId, "invalid_label");
    return { code: "error" };
  }
  const kind = answer.label;
  const needsOwner = answer.confidence < ROUTE_THRESHOLD;

  const written = await run(async (db) => {
    const upd = await db.query<{ id: string }>(
      `UPDATE entries SET route_kind = $2, route_confidence = $3, route_model = $4, routed_by = 'model', status = $5,
            route_error = NULL, route_attempts = route_attempts + 1, route_attempted_at = now()
        WHERE id = $1 AND route_kind IS NULL RETURNING id`,
      [entryId, kind, answer.confidence, answer.model, needsOwner ? "needs_owner" : "routed"],
    );
    if (upd.rows.length === 0) return { written: false as const };
    let derived: DerivedRow | null = null;
    if (!needsOwner) derived = await applyRouteLinked(db, entryId, null, kind);
    if (needsOwner) {
      await db.query(
        "INSERT INTO inbox_items (kind, ref_table, ref_id, title) VALUES ('routing', 'entries', $1, $2)",
        [entryId, routingTitle(before.text)],
      );
    }
    return { written: true as const, derived };
  });
  if (!written.written) return { code: "already" };
  return needsOwner ? { code: "needs_owner", kind } : { code: "routed", kind, derived: written.derived };
}

/** Stores a failed attempt: the fixed code, one more attempt, now. Only while the entry is still unrouted. */
async function recordFailure(run: DbRun, entryId: string, code: RouteError): Promise<void> {
  try {
    await run((db) =>
      db.query(
        "UPDATE entries SET route_error = $2, route_attempts = route_attempts + 1, route_attempted_at = now() WHERE id = $1 AND route_kind IS NULL",
        [entryId, code],
      ),
    );
  } catch (err) {
    console.error(`[router] record-${errorClass(err)}`);
  }
}

/**
 * The owner moves an entry to another kind. A correction is stored only when the entry had a route and it changes;
 * the open routing inbox item for the entry is closed. Returns "not-found" for an unknown entry.
 */
export async function reassignEntry(db: Queryable, entryId: string, to: RouteKind): Promise<"ok" | "not-found"> {
  return (await reassignEntryDerived(db, entryId, to)).result;
}

/** reassignEntry that also returns the derived row it created (for scoring a new diary row after commit). */
export async function reassignEntryDerived(
  db: Queryable,
  entryId: string,
  to: RouteKind,
): Promise<{ result: "ok" | "not-found"; derived: DerivedRow | null }> {
  const { rows } = await db.query<{ route_kind: RouteKind | null; status: string | null }>(
    "SELECT route_kind, status FROM entries WHERE id = $1 FOR UPDATE",
    [entryId],
  );
  const row = rows[0];
  if (!row) return { result: "not-found", derived: null };
  // Saving the unchanged kind of a routed entry changes nothing (a derived row the owner deleted stays deleted).
  if (row.status === "routed" && row.route_kind === to) return { result: "ok", derived: null };
  await db.query(
    "UPDATE entries SET route_kind = $2, routed_by = 'owner', status = 'routed', route_error = NULL WHERE id = $1",
    [entryId, to],
  );
  // A "needs you" entry has a guess but no derived row yet; a routed one has a row of its current kind.
  const derived = await applyRouteLinked(db, entryId, row.status === "needs_owner" ? null : row.route_kind, to);
  if (row.route_kind !== null && row.route_kind !== to) {
    await db.query("INSERT INTO route_corrections (entry_id, from_kind, to_kind) VALUES ($1, $2, $3)", [entryId, row.route_kind, to]);
  }
  await db.query(
    "UPDATE inbox_items SET status = 'done', resolved_at = now() WHERE kind = 'routing' AND ref_table = 'entries' AND ref_id = $1 AND status = 'open'",
    [entryId],
  );
  return { result: "ok", derived };
}

export interface RoutingItem {
  entryId: string;
  rawText: string;
  createdAt: string;
  /** The model's guess (the entry's route while the item is open). */
  guess: RouteKind | null;
  confidence: number | null;
}

/** Open routing items, oldest first, with their entries. */
export async function listRoutingInbox(db: Queryable): Promise<RoutingItem[]> {
  const { rows } = await db.query<{
    entry_id: string;
    raw_text: string;
    created_at: Date | string;
    route_kind: RouteKind | null;
    route_confidence: number | null;
  }>(
    `SELECT e.id AS entry_id, e.raw_text, e.created_at, e.route_kind, e.route_confidence
       FROM inbox_items i
       JOIN entries e ON e.id::text = i.ref_id
      WHERE i.kind = 'routing' AND i.ref_table = 'entries' AND i.status = 'open'
      ORDER BY i.created_at, i.id`,
  );
  return rows.map((r) => ({
    entryId: r.entry_id,
    rawText: r.raw_text,
    createdAt: new Date(r.created_at).toISOString(),
    guess: r.route_kind,
    confidence: r.route_confidence === null ? null : Number(r.route_confidence),
  }));
}

/** Only the error class goes to the log (never a message: it may carry text or a host). */
function errorClass(err: unknown): string {
  return err instanceof Error ? err.name : "error";
}
