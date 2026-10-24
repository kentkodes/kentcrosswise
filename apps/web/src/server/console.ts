// Boss console and inbox data (P2-14, DESIGN §4.2, §4.3, Q2). Runs as web_rw. Owner pages only:
// these rows include private text (owner_text) and must never reach a public route.
import type { Queryable } from "./db";
import type { Decision } from "./orchestrator-queue";

export const MAX_TASK_TEXT = 4000;

export type FlagKey = "agents_paused" | "pipelines_paused";
export const FLAG_KEYS: readonly FlagKey[] = ["agents_paused", "pipelines_paused"];
export const isFlagKey = (v: unknown): v is FlagKey => FLAG_KEYS.includes(v as FlagKey);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
export const isDecision = (v: unknown): v is Decision => v === "approved" || v === "rejected";

/** Parses a positive task id from form input; undefined if invalid. */
export function parseTaskId(v: unknown): number | undefined {
  if (typeof v !== "string" || !/^\d{1,15}$/.test(v)) return undefined;
  const n = Number(v);
  return n >= 1 ? n : undefined;
}

export class InputError extends Error {
  override name = "InputError";
}

// ---------------------------------------------------------------- tasks

/**
 * A docs task (DESIGN §4.2 step 8): the orchestrator's child row of a merged task, source `github`.
 * Its parent is the merged task it documents, not a split parent.
 */
const IS_DOCS_TASK = "(source = 'github' AND parent_id IS NOT NULL)";

export interface TaskRow {
  id: number;
  parentId: number | null;
  /** A docs task: `parentId` is the merged task it documents. */
  isDocs: boolean;
  createdAt: string;
  updatedAt: string;
  status: string;
  waitingOn: string | null;
  isPrivate: boolean;
  publicTitle: string | null;
  ownerText: string;
  prNumber: number | null;
  attempts: number;
}

export interface EventRow {
  id: number;
  ts: string;
  taskId: number;
  agent: string;
  type: string;
}

/** Inserts a console task (status queued, thread task-<id>) and returns its id. */
export async function createTask(db: Queryable, input: { ownerText: string; isPrivate: boolean }): Promise<number> {
  const text = input.ownerText.trim();
  if (text === "") throw new InputError("The task text is empty.");
  if (text.length > MAX_TASK_TEXT) throw new InputError(`The task text is longer than ${MAX_TASK_TEXT} characters.`);
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO tasks (source, owner_text, is_private) VALUES ('console', $1, $2) RETURNING id",
    [text, input.isPrivate],
  );
  const id = Number(rows[0]!.id);
  await db.query("UPDATE tasks SET thread_id = 'task-' || id WHERE id = $1", [id]);
  return id;
}

const iso = (v: Date | string) => new Date(v).toISOString();

export async function listTasks(db: Queryable, limit = 50): Promise<TaskRow[]> {
  const { rows } = await db.query<{
    id: string;
    parent_id: string | null;
    is_docs: boolean;
    created_at: Date;
    updated_at: Date;
    status: string;
    waiting_on: string | null;
    is_private: boolean;
    public_title: string | null;
    owner_text: string;
    pr_number: number | null;
    attempts: number;
  }>(
    `SELECT id, parent_id, ${IS_DOCS_TASK} AS is_docs, created_at, updated_at, status, waiting_on, is_private,
            public_title, owner_text, pr_number, attempts
       FROM tasks ORDER BY id DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    parentId: r.parent_id === null ? null : Number(r.parent_id),
    isDocs: r.is_docs,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    status: r.status,
    waitingOn: r.waiting_on,
    isPrivate: r.is_private,
    publicTitle: r.public_title,
    ownerText: r.owner_text,
    prNumber: r.pr_number,
    attempts: r.attempts,
  }));
}

/** The latest `perTask` events of each task, oldest first. */
export async function listEvents(db: Queryable, taskIds: readonly number[], perTask = 20): Promise<EventRow[]> {
  if (taskIds.length === 0) return [];
  const { rows } = await db.query<{ id: string; ts: Date; task_id: string; agent: string; event_type: string }>(
    `SELECT id, ts, task_id, agent, event_type FROM (
       SELECT e.*, row_number() OVER (PARTITION BY task_id ORDER BY id DESC) AS n
         FROM agent_events e WHERE task_id = ANY($1::bigint[])
     ) x WHERE n <= $2 ORDER BY id`,
    [taskIds, perTask],
  );
  return rows.map((r) => ({ id: Number(r.id), ts: iso(r.ts), taskId: Number(r.task_id), agent: r.agent, type: r.event_type }));
}

/**
 * A task whose task.created message may be (re)sent: only while it is still queued, and never a
 * docs task (the orchestrator starts those itself; a task.created would plan it as owner work).
 */
export async function queuedTaskExists(db: Queryable, id: number): Promise<boolean> {
  const { rows } = await db.query(`SELECT 1 FROM tasks WHERE id = $1 AND status = 'queued' AND NOT ${IS_DOCS_TASK}`, [id]);
  return rows.length > 0;
}

// ---------------------------------------------------------------- flags (Q2)

export type Flags = Record<FlagKey, boolean>;

export async function getFlags(db: Queryable): Promise<Flags> {
  const { rows } = await db.query<{ key: string; value: unknown }>(
    "SELECT key, value FROM system_flags WHERE key = ANY($1::text[])",
    [FLAG_KEYS],
  );
  const flags: Flags = { agents_paused: false, pipelines_paused: false };
  for (const r of rows) if (isFlagKey(r.key)) flags[r.key] = r.value === true;
  return flags;
}

export async function setFlag(db: Queryable, key: FlagKey, value: boolean): Promise<void> {
  if (!isFlagKey(key)) throw new InputError("Unknown switch.");
  await db.query(
    `INSERT INTO system_flags (key, value, updated_at) VALUES ($1, to_jsonb($2::boolean), now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
}

// ---------------------------------------------------------------- approvals (inbox)

export interface ApprovalRow {
  id: string;
  taskId: number | null;
  kind: string;
  reasons: string[];
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  decidedAt: string | null;
  note: string | null;
  taskText: string | null;
  prNumber: number | null;
}

export async function listApprovals(db: Queryable, decidedLimit = 20): Promise<{ pending: ApprovalRow[]; decided: ApprovalRow[] }> {
  const { rows } = await db.query<{
    id: string;
    task_id: string | null;
    kind: string;
    reasons: string[];
    status: ApprovalRow["status"];
    created_at: Date;
    decided_at: Date | null;
    note: string | null;
    owner_text: string | null;
    pr_number: number | null;
  }>(
    `(SELECT a.*, t.owner_text, t.pr_number FROM approvals a LEFT JOIN tasks t ON t.id = a.task_id
       WHERE a.status = 'pending' ORDER BY a.created_at, a.id)
     UNION ALL
     (SELECT a.*, t.owner_text, t.pr_number FROM approvals a LEFT JOIN tasks t ON t.id = a.task_id
       WHERE a.status <> 'pending' ORDER BY a.decided_at DESC, a.id LIMIT $1)`,
    [decidedLimit],
  );
  const all = rows.map(
    (r): ApprovalRow => ({
      id: r.id,
      taskId: r.task_id === null ? null : Number(r.task_id),
      kind: r.kind,
      reasons: r.reasons,
      status: r.status,
      createdAt: iso(r.created_at),
      decidedAt: r.decided_at === null ? null : iso(r.decided_at),
      note: r.note,
      taskText: r.owner_text,
      prNumber: r.pr_number,
    }),
  );
  return { pending: all.filter((a) => a.status === "pending"), decided: all.filter((a) => a.status !== "pending") };
}

export type DecideResult = { decided: true; taskId: number | null } | { decided: false };

/**
 * Records the owner's decision if the approval is still pending (a second click or a stale page is
 * a no-op) and closes its inbox item.
 */
export async function decideApproval(
  db: Queryable,
  input: { id: string; decision: Decision; note?: string },
): Promise<DecideResult> {
  if (!isUuid(input.id)) throw new InputError("Unknown approval.");
  if (!isDecision(input.decision)) throw new InputError("Unknown decision.");
  const note = input.note?.trim() ? input.note.trim().slice(0, 1000) : null;
  const { rows } = await db.query<{ task_id: string | null }>(
    `UPDATE approvals SET status = $2, decided_at = now(), note = $3
      WHERE id = $1 AND status = 'pending' RETURNING task_id`,
    [input.id, input.decision, note],
  );
  if (rows.length === 0) return { decided: false };
  await db.query(
    `UPDATE inbox_items SET status = 'done', resolved_at = now()
      WHERE ref_table = 'approvals' AND ref_id = $1 AND status = 'open'`,
    [input.id],
  );
  const taskId = rows[0]!.task_id;
  return { decided: true, taskId: taskId === null ? null : Number(taskId) };
}

/** A decided approval (for resending its message); undefined if pending or unknown. */
export async function decidedApproval(db: Queryable, id: string): Promise<{ taskId: number | null; decision: Decision } | undefined> {
  if (!isUuid(id)) return undefined;
  const { rows } = await db.query<{ task_id: string | null; status: string }>(
    "SELECT task_id, status FROM approvals WHERE id = $1 AND status <> 'pending'",
    [id],
  );
  const r = rows[0];
  if (!r || !isDecision(r.status)) return undefined;
  return { taskId: r.task_id === null ? null : Number(r.task_id), decision: r.status };
}
