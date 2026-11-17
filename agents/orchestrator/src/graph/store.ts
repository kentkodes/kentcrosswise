// The task graph's database access, as orch_rw (DESIGN §3.2, §3.4): tasks, agent_events,
// approvals (+ inbox items, migration 0003), usage_events, system_flags, contact names. Events and
// approvals carry effect keys, and a report is written in one transaction (AR2 slice 3, 0013).
// Child starts are outbox messages written with the state change that releases them (AR4, 0020).
import type { AgentName, EventType, Usage } from "@kcw/core/events";
import { callEventStatement, type CallEvent, type CallTag } from "@kcw/core/models";
import { loadContactNames, type ContactNames } from "@kcw/core/sanitize";
import type pg from "pg";
import { OperationConflictError, type OperationKind } from "./operations";
import type { AgentRunRole, Decision, WaitingOn } from "./types";
import type { EvidenceRow, ValidityRows } from "./validity";

export type TaskStatus = "queued" | "planning" | "in_progress" | "waiting" | "merged" | "done" | "failed" | "cancelled";

export interface TaskRecord {
  id: number;
  status: TaskStatus;
  /** Private. */
  owner_text: string;
  is_private: boolean;
  github_issue: number | null;
  /** Set for a subtask (a child row the planner created). */
  parent_id: number | null;
  /** AR4: sibling subtasks that must be merged before this one starts (empty for other tasks). */
  prerequisites: number[];
  /** AR4: the merge commit on main of this task's own pull request; null if not merged or GitHub returned none. */
  merge_sha: string | null;
}

export interface ChildTask {
  id: number;
  status: TaskStatus;
  prerequisites: number[];
}

export interface TaskUpdate {
  status?: TaskStatus;
  waiting_on?: WaitingOn | null;
  agent?: AgentName | null;
  public_title?: string | null;
  github_issue?: number;
  pr_number?: number;
  branch?: string;
  head_sha?: string;
  attempts?: number;
  /** AR6: cleared when the task leaves a wait for an execution reservation. */
  execution_wait?: "developer" | "qa" | "docs" | null;
}

export type ApprovalKind = "critical_pr" | "issue_text";

export interface ApprovalRecord {
  task_id: number | null;
  kind: string;
  status: "pending" | Decision;
}

export interface RunObservation {
  runId: number; attempt: number; taskId: number; role: "developer" | "qa" | "docs" | "scraper";
  action: "requested" | "completed"; timestamp: string | null; conclusion: string | null;
}
/**
 * agent_dispatches already links this run id to another task or role (RUN-ID-MAPPING-SPEC §2).
 * The message is the fixed code only.
 */
export class DispatchLinkConflictError extends Error {
  override name = "DispatchLinkConflictError";
  readonly code = "dispatch_link_conflict";
  constructor() {
    super("dispatch_link_conflict");
  }
}

/** One github_operations row (migration 0012). `result` is private plan text for kind `plan`. */
export interface OperationRecord {
  effectKey: string;
  kind: OperationKind;
  requestHash: string;
  state: "intent" | "done";
  result: unknown;
  /** ISO time the intent was written (from the machine clock). */
  createdAt: string;
}

export interface TaskStore {
  recordRun(run: RunObservation): Promise<void>;
  /**
   * Links a dispatched agent run to its task (agent_dispatches, migration 0010) so the relay can map
   * the run's `requested` delivery before GitHub evaluates its run-name. Idempotent for the same
   * link; throws DispatchLinkConflictError if the run id is already linked to another task or role.
   */
  recordDispatch(runId: number, taskId: number, role: AgentRunRole): Promise<void>;
  getTask(id: number): Promise<TaskRecord | null>;
  /** system_flags.agents_paused (Q2). */
  isPaused(): Promise<boolean>;
  /**
   * D20: moves a queued task to `planning` if fewer than `limit` other tasks are in flight
   * (planning, in_progress, waiting). Serialized across threads by an advisory lock. A task that
   * is already in flight keeps its slot (true). A parent task with children does not count: its
   * children hold the slots (§11 Q12).
   */
  claimSlot(id: number, limit: number): Promise<boolean>;
  /**
   * AR6: the active execution reservation of a worker run: `status = 'waiting'` with `waiting_on` dev (Developer,
   * Docs) or qa. Same lock and transaction shape as claimSlot. A task that holds one keeps it (true); otherwise,
   * if fewer than `limit` other tasks (not parents) hold one, the task takes it and its `execution_wait` is
   * cleared (true); at the limit `execution_wait` is set to the role and the answer is false.
   */
  claimExecution(id: number, role: "developer" | "qa" | "docs", limit: number): Promise<boolean>;
  updateTask(id: number, fields: TaskUpdate): Promise<void>;
  /**
   * Adds an event. With an `effectKey` (migration 0013) a second call with the same key writes
   * nothing (a re-run step does not repeat its events).
   */
  addEvent(taskId: number, agent: AgentName, type: EventType, detail?: Record<string, unknown>, effectKey?: string): Promise<void>;
  /**
   * AR2 slice 3: one agent report in ONE transaction: its receipt (orchestrator_receipts, key = the
   * report identity), every usage line (usage_events.dedupe_key) and its event, or nothing. False if
   * the receipt already existed: the report was applied before and nothing is written.
   */
  recordReport(report: ReportWrite): Promise<boolean>;
  /** Unkeyed usage rows: the planner's own model calls (lambda.ts; call identities are AR3). */
  addUsage(taskId: number, agent: AgentName, usage: readonly Usage[]): Promise<void>;
  /**
   * An approval plus its inbox item, in one transaction. Returns the approval id. With an
   * `effectKey` (migration 0013) an approval already written under that key is returned instead and
   * no second approval or inbox item is created.
   */
  createApproval(input: { taskId: number; kind: ApprovalKind; reasons: string[]; inboxTitle: string; effectKey?: string }): Promise<string>;
  getApproval(id: string): Promise<ApprovalRecord | null>;
  /** Closes a pending approval the thread no longer waits on (e.g. the PR head changed). */
  supersedeApproval(id: string, note: string): Promise<void>;
  loadContacts(): Promise<ContactNames[]>;
  /**
   * §4.2 step 2: one child `tasks` row per subtask (queued, thread `task-<id>`, source and
   * is_private copied from the parent, `prerequisites` = the child ids of `after[i]`), in one
   * transaction with the outbox start message of every child without prerequisites (AR4). If the
   * parent already has children (a retried step), returns those instead (their start messages are
   * enqueued again, which writes nothing new). Ids in subtask order.
   */
  createSubtasks(parentId: number, ownerTexts: readonly string[], after: readonly (readonly number[])[]): Promise<number[]>;
  getChildren(parentId: number): Promise<ChildTask[]>;
  /**
   * AR4: the task is merged (status `merged`, no wait) and `merge_sha` is its own merge commit (a
   * sha already recorded is kept; null when GitHub returned none). In the same transaction, every
   * queued sibling whose prerequisites are now all merged gets its outbox start message. Serialized
   * per parent (row lock), so two siblings merging at once cannot both miss a common dependent.
   * Returns the released ids; a repeated call enqueues nothing new.
   */
  mergeTask(id: number, mergeSha: string | null): Promise<number[]>;
  /** AR4: cancels these tasks if they are still queued (the blocked subtasks of a parked parent). */
  cancelQueued(ids: readonly number[]): Promise<void>;
  /**
   * §4.2 step 8: the docs task of a merged task (a child row: queued, source `github`, is_private
   * copied, fixed owner text naming the PR, thread `task-<id>`; the docs start sets the branch). A merged
   * task has no other children (a split parent never merges, a subtask never splits), so an
   * existing child is the docs task of a retried step and is returned instead.
   */
  createDocsTask(mergedId: number, pr: number, publicTitle: string | null): Promise<number>;
  /**
   * AR2 slice 2a: writes the operation's intent (state `intent`) unless the key already has a record,
   * and returns the record that is there. `created` is true only for the call that wrote it. An
   * existing record with another request hash throws OperationConflictError.
   */
  beginOperation(input: { effectKey: string; taskId: number; kind: OperationKind; requestHash: string; createdAt: string }): Promise<{ record: OperationRecord; created: boolean }>;
  /** Stores the operation's result (state `done`), or a partial result while it stays `intent`. */
  updateOperation(effectKey: string, state: "intent" | "done", result: unknown): Promise<void>;
  /** AR5b (0021): the contract revision's row (the sanitized public contract); a second call writes nothing. */
  recordRevision(input: RevisionWrite): Promise<void>;
  /**
   * AR5b: a replan in ONE transaction: revision `from` gets `superseded_at`, its open attempts end
   * as `superseded`, its QA evidence gets `superseded_at`, and revision `next` is inserted. Every
   * statement only touches rows still open, so a re-run changes nothing.
   */
  supersedeRevision(taskId: number, from: number, next: RevisionWrite): Promise<void>;
  /** AR5b: the attempt of a dispatch, written with its intent; a second call for the key writes nothing. */
  recordAttempt(input: AttemptWrite): Promise<void>;
  /**
   * AR5b: fills the attempt's run id, start, end and outcome. Each field is set once (a value already
   * there is kept). `contractHash` guards `startedAt`: it applies only when the attempt carries that
   * hash (a start report of another revision does not start it; undefined = no hash, as for docs).
   * A key without a row (a dispatch before this slice deployed) changes nothing.
   */
  updateAttempt(effectKey: string, fields: AttemptUpdate): Promise<void>;
  /** AR5b: CI or QA evidence for a head; a second call for the key writes nothing. */
  recordEvidence(input: EvidenceWrite): Promise<void>;
  /** AR5b: the rows the validity rule reads (graph/validity.ts): revisions, QA attempts of `revision`, evidence of `head`. */
  loadValidity(taskId: number, revision: number | null, head: string): Promise<ValidityRows>;
}

/** One task_revisions row to write. */
export interface RevisionWrite {
  taskId: number;
  revision: number;
  contractHash: string;
  contract: unknown;
}

export interface AttemptWrite {
  /** The dispatch key `task-<id>/dispatch/<n>`. */
  effectKey: string;
  taskId: number;
  /** Null for a docs task. */
  revision: number | null;
  role: "developer" | "qa" | "docs";
  op: number;
  contractHash: string | null;
  baseSha: string | null;
  createdAt: string;
}

export interface AttemptUpdate {
  runId?: number;
  /** Needs `startContract` to equal the attempt's hash (null: the attempt has none). */
  startedAt?: string;
  startContract?: string | null;
  endedAt?: string;
  outcome?: "succeeded" | "failed" | "superseded" | "lost";
}

export interface EvidenceWrite {
  effectKey: string;
  taskId: number;
  revision: number | null;
  kind: "ci" | "qa";
  headSha: string;
  outcome: "success" | "failure" | "approved" | "changes_requested";
  attemptKey: string | null;
  createdAt: string;
}

/** What `recordReport` writes: usage lines carry their `usage_events.dedupe_key`. */
export interface ReportWrite {
  receiptKey: string;
  taskId: number;
  agent: AgentName;
  usage: readonly (Usage & { dedupeKey: string })[];
  /** Null: the report has no lifecycle effect (usage-only, stale, or from an obsolete run). */
  event: { type: EventType; detail: Record<string, unknown>; effectKey: string } | null;
}

/** Statuses that hold an in-flight slot (D20). */
export const IN_FLIGHT_STATUSES: readonly TaskStatus[] = ["planning", "in_progress", "waiting"];

/** Any constant works; it only has to be the same for every orchestrator instance. */
const SLOT_LOCK_KEY = 0x6b6377; // "kcw"

const UPDATABLE = [
  "status",
  "waiting_on",
  "agent",
  "public_title",
  "github_issue",
  "pr_number",
  "branch",
  "head_sha",
  "attempts",
  "execution_wait",
] as const satisfies readonly (keyof TaskUpdate)[];

const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

/** One agent_events row; a keyed row is written once (migration 0013). */
async function insertEvent(
  db: Pick<pg.Pool, "query">,
  e: { taskId: number; agent: AgentName; type: EventType; detail: Record<string, unknown>; effectKey: string | null },
): Promise<void> {
  await db.query(
    "INSERT INTO agent_events (task_id, agent, event_type, detail, effect_key) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (effect_key) DO NOTHING",
    [e.taskId, e.agent, e.type, JSON.stringify(e.detail), e.effectKey],
  );
}

/**
 * AR4: the `task.created` outbox message of each child (group = its thread), at most once per child
 * (message key `task-<id>/start`); the sweeper's outbox part sends it.
 */
async function enqueueStarts(db: Pick<pg.PoolClient, "query">, ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return;
  await db.query(
    `INSERT INTO orchestrator_outbox (message_key, group_id, body)
     SELECT 'task-' || c.id || '/start', 'task-' || c.id,
            json_build_object('type', 'task.created', 'task_id', c.id, 'message_key', 'task-' || c.id || '/start')::text
       FROM tasks c WHERE c.id = ANY($1::bigint[]) ORDER BY c.id
     ON CONFLICT (message_key) DO NOTHING`,
    [ids],
  );
}

export class PgTaskStore implements TaskStore {
  constructor(private readonly pool: pg.Pool) {}

  async recordRun(run: RunObservation): Promise<void> {
    const stamp = run.timestamp === null ? NaN : Date.parse(run.timestamp);
    // Invalid/old/future GitHub clocks cannot poison the projection timestamp check.
    const timestamp = Number.isFinite(stamp) && stamp >= Date.UTC(2000, 0, 1) ? new Date(stamp).toISOString() : null;
    await this.pool.query(
      `INSERT INTO agent_runs(run_id,run_attempt,task_id,role,requested_at,completed_at,conclusion)
       VALUES($1,$2,$3,$4,CASE WHEN $5='requested' THEN least(COALESCE($6::timestamptz,now()),now()) END,
         CASE WHEN $5='completed' THEN least(COALESCE($6::timestamptz,now()),now()) END,
         CASE WHEN $5='completed' THEN COALESCE($7,'unknown') END)
       ON CONFLICT(run_id,run_attempt) DO UPDATE SET completed_at=EXCLUDED.completed_at,conclusion=EXCLUDED.conclusion
       WHERE agent_runs.completed_at IS NULL AND EXCLUDED.completed_at IS NOT NULL
         AND agent_runs.task_id=EXCLUDED.task_id AND agent_runs.role=EXCLUDED.role`,
      [run.runId, run.attempt, run.taskId, run.role, run.action, timestamp, run.conclusion],
    );
  }

  async recordDispatch(runId: number, taskId: number, role: AgentRunRole): Promise<void> {
    await this.pool.query(
      "INSERT INTO agent_dispatches (run_id, task_id, role) VALUES ($1, $2, $3) ON CONFLICT (run_id) DO NOTHING",
      [runId, taskId, role],
    );
    // Read back: a row that was already there must be this same link.
    const { rows } = await this.pool.query<{ task_id: string | number; role: string }>(
      "SELECT task_id, role FROM agent_dispatches WHERE run_id = $1",
      [runId],
    );
    const row = rows[0];
    if (!row || Number(row.task_id) !== taskId || row.role !== role) throw new DispatchLinkConflictError();
  }

  async getTask(id: number): Promise<TaskRecord | null> {
    const { rows } = await this.pool.query<{
      id: string;
      status: TaskStatus;
      owner_text: string;
      is_private: boolean;
      github_issue: number | null;
      parent_id: string | null;
      prerequisites: (string | number)[];
      merge_sha: string | null;
    }>("SELECT id, status, owner_text, is_private, github_issue, parent_id, prerequisites, merge_sha FROM tasks WHERE id = $1", [id]);
    const r = rows[0];
    return r
      ? {
          id: Number(r.id),
          status: r.status,
          owner_text: r.owner_text,
          is_private: r.is_private,
          github_issue: r.github_issue,
          parent_id: num(r.parent_id),
          prerequisites: r.prerequisites.map(Number),
          merge_sha: r.merge_sha,
        }
      : null;
  }

  async isPaused(): Promise<boolean> {
    const { rows } = await this.pool.query<{ value: unknown }>("SELECT value FROM system_flags WHERE key = 'agents_paused'");
    return rows[0]?.value === true;
  }

  async claimSlot(id: number, limit: number): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [SLOT_LOCK_KEY]);
      const { rows: own } = await client.query<{ status: TaskStatus }>("SELECT status FROM tasks WHERE id = $1", [id]);
      const status = own[0]?.status;
      let claimed = false;
      if (status !== undefined && IN_FLIGHT_STATUSES.includes(status)) {
        claimed = true;
      } else if (status === "queued") {
        const { rows } = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM tasks t
           WHERE t.status = ANY($1::text[]) AND t.id <> $2
             AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = t.id)`,
          [IN_FLIGHT_STATUSES, id],
        );
        if ((rows[0]?.n ?? 0) < limit) {
          await client.query("UPDATE tasks SET status = 'planning', updated_at = now() WHERE id = $1", [id]);
          claimed = true;
        }
      }
      await client.query("COMMIT");
      return claimed;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async claimExecution(id: number, role: "developer" | "qa" | "docs", limit: number): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [SLOT_LOCK_KEY]);
      const { rows: own } = await client.query<{ status: TaskStatus; waiting_on: string | null }>("SELECT status, waiting_on FROM tasks WHERE id = $1", [id]);
      const status = own[0]?.status;
      let claimed = false;
      if (status === "waiting" && (own[0]?.waiting_on === "dev" || own[0]?.waiting_on === "qa")) {
        claimed = true; // already reserved: a redispatch within the reservation needs no second one
      } else if (status !== undefined && IN_FLIGHT_STATUSES.includes(status)) {
        const { rows } = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM tasks t
           WHERE t.status = 'waiting' AND t.waiting_on IN ('dev', 'qa') AND t.id <> $1
             AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = t.id)`,
          [id],
        );
        if ((rows[0]?.n ?? 0) < limit) {
          await client.query("UPDATE tasks SET status = 'waiting', waiting_on = $2, execution_wait = NULL, updated_at = now() WHERE id = $1", [id, role === "qa" ? "qa" : "dev"]);
          claimed = true;
        } else {
          await client.query("UPDATE tasks SET execution_wait = $2 WHERE id = $1", [id, role]);
        }
      }
      await client.query("COMMIT");
      return claimed;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async updateTask(id: number, fields: TaskUpdate): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const key of UPDATABLE) {
      if (fields[key] === undefined) continue;
      values.push(fields[key]);
      sets.push(`${key} = $${values.length}`);
    }
    if (sets.length === 0) return;
    await this.pool.query(`UPDATE tasks SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, values);
  }

  async addEvent(taskId: number, agent: AgentName, type: EventType, detail: Record<string, unknown> = {}, effectKey?: string): Promise<void> {
    await insertEvent(this.pool, { taskId, agent, type, detail, effectKey: effectKey ?? null });
  }

  async addUsage(taskId: number, agent: AgentName, usage: readonly Usage[]): Promise<void> {
    // cost_usd stays null: the usage panel prices rows from model_prices (never hardcoded here).
    for (const u of usage) {
      if (u.kind === "model") {
        await this.pool.query(
          `INSERT INTO usage_events (kind, agent, provider, model, input_tokens, output_tokens, task_id)
           VALUES ('model', $1, $2, $3, $4, $5, $6)`,
          [agent, u.provider, u.model, u.input_tokens, u.output_tokens, taskId],
        );
      } else {
        await this.pool.query("INSERT INTO usage_events (kind, agent, minutes, task_id) VALUES ('actions_minutes', $1, $2, $3)", [
          agent,
          u.minutes,
          taskId,
        ]);
      }
    }
  }

  /**
   * AR3: one call event of an in-process model call (the planner's), as a usage_events call record
   * (migration 0019, SQL in @kcw/core/models ledger.ts). `defaults` fill tag fields the call left unset.
   */
  async recordCall(agent: AgentName, event: CallEvent, defaults: CallTag = {}): Promise<void> {
    const s = callEventStatement(agent, event, defaults);
    await this.pool.query(s.text, s.values);
  }

  async recordReport(r: ReportWrite): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const receipt = await client.query(
        "INSERT INTO orchestrator_receipts (message_key) VALUES ($1) ON CONFLICT (message_key) DO NOTHING RETURNING message_key",
        [r.receiptKey],
      );
      if (receipt.rows.length === 0) {
        await client.query("ROLLBACK");
        return false;
      }
      // cost_usd stays null: the usage panel prices rows from model_prices (never hardcoded here).
      for (const u of r.usage) {
        if (u.kind === "model") {
          await client.query(
            `INSERT INTO usage_events (kind, agent, provider, model, input_tokens, output_tokens, task_id, dedupe_key, purpose)
             VALUES ('model', $1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (dedupe_key) DO NOTHING`,
            [r.agent, u.provider, u.model, u.input_tokens, u.output_tokens, r.taskId, u.dedupeKey, reportPurpose(u.dedupeKey)],
          );
        } else {
          await client.query(
            `INSERT INTO usage_events (kind, agent, minutes, task_id, dedupe_key)
             VALUES ('actions_minutes', $1, $2, $3, $4) ON CONFLICT (dedupe_key) DO NOTHING`,
            [r.agent, u.minutes, r.taskId, u.dedupeKey],
          );
        }
      }
      if (r.event) await insertEvent(client, { taskId: r.taskId, agent: r.agent, ...r.event });
      await client.query("COMMIT");
      return true;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async createApproval(input: { taskId: number; kind: ApprovalKind; reasons: string[]; inboxTitle: string; effectKey?: string }): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ id: string }>(
        "INSERT INTO approvals (task_id, kind, reasons, effect_key) VALUES ($1, $2, $3, $4) ON CONFLICT (effect_key) DO NOTHING RETURNING id",
        [input.taskId, input.kind, input.reasons, input.effectKey ?? null],
      );
      if (rows.length === 0) {
        // Written by an earlier run of this step: reuse it (its inbox item is already there).
        const existing = await client.query<{ id: string }>("SELECT id FROM approvals WHERE effect_key = $1", [input.effectKey]);
        await client.query("COMMIT");
        return existing.rows[0]!.id;
      }
      const id = rows[0]!.id;
      await client.query(
        "INSERT INTO inbox_items (kind, ref_table, ref_id, title) VALUES ('approval', 'approvals', $1, $2)",
        [id, input.inboxTitle],
      );
      await client.query("COMMIT");
      return id;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async getApproval(id: string): Promise<ApprovalRecord | null> {
    const { rows } = await this.pool.query<{ task_id: string | null; kind: string; status: ApprovalRecord["status"] }>(
      "SELECT task_id, kind, status FROM approvals WHERE id = $1",
      [id],
    );
    const r = rows[0];
    return r ? { task_id: num(r.task_id), kind: r.kind, status: r.status } : null;
  }

  async supersedeApproval(id: string, note: string): Promise<void> {
    await this.pool.query(
      "UPDATE approvals SET status = 'rejected', decided_at = now(), note = $2 WHERE id = $1 AND status = 'pending'",
      [id, note],
    );
  }

  async createSubtasks(parentId: number, ownerTexts: readonly string[], after: readonly (readonly number[])[]): Promise<number[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // The row lock serializes a retried step with itself.
      await client.query("SELECT 1 FROM tasks WHERE id = $1 FOR UPDATE", [parentId]);
      const { rows: existing } = await client.query<{ id: string }>("SELECT id FROM tasks WHERE parent_id = $1 ORDER BY id", [parentId]);
      const ids = existing.map((r) => Number(r.id));
      if (ids.length === 0) {
        for (const text of ownerTexts) {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO tasks (parent_id, source, owner_text, is_private)
             SELECT id, source, $2, is_private FROM tasks WHERE id = $1
             RETURNING id`,
            [parentId, text],
          );
          ids.push(Number(rows[0]!.id));
        }
        await client.query("UPDATE tasks SET thread_id = 'task-' || id WHERE id = ANY($1::bigint[])", [ids]);
        for (const [i, id] of ids.entries()) {
          const prerequisites = (after[i] ?? []).map((p) => ids[p]!);
          if (prerequisites.length > 0) await client.query("UPDATE tasks SET prerequisites = $2::bigint[] WHERE id = $1", [id, prerequisites]);
        }
      }
      const { rows: ready } = await client.query<{ id: string }>(
        "SELECT id FROM tasks WHERE parent_id = $1 AND cardinality(prerequisites) = 0 ORDER BY id",
        [parentId],
      );
      await enqueueStarts(client, ready.map((r) => Number(r.id)));
      await client.query("COMMIT");
      return ids;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async createDocsTask(mergedId: number, pr: number, publicTitle: string | null): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // The row lock serializes a retried merge step with itself.
      await client.query("SELECT 1 FROM tasks WHERE id = $1 FOR UPDATE", [mergedId]);
      const { rows: existing } = await client.query<{ id: string }>("SELECT id FROM tasks WHERE parent_id = $1 ORDER BY id LIMIT 1", [mergedId]);
      let id = existing[0] ? Number(existing[0].id) : null;
      if (id === null) {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO tasks (parent_id, source, owner_text, public_title, is_private)
           SELECT id, 'github', $2, $3, is_private FROM tasks WHERE id = $1
           RETURNING id`,
          [mergedId, `Docs-keeper update after PR #${pr}.`, publicTitle],
        );
        id = Number(rows[0]!.id);
        await client.query("UPDATE tasks SET thread_id = 'task-' || id WHERE id = $1", [id]);
      }
      await client.query("COMMIT");
      return id;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async getChildren(parentId: number): Promise<ChildTask[]> {
    const { rows } = await this.pool.query<{ id: string; status: TaskStatus; prerequisites: (string | number)[] }>(
      "SELECT id, status, prerequisites FROM tasks WHERE parent_id = $1 ORDER BY id",
      [parentId],
    );
    return rows.map((r) => ({ id: Number(r.id), status: r.status, prerequisites: r.prerequisites.map(Number) }));
  }

  async mergeTask(id: number, mergeSha: string | null): Promise<number[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: own } = await client.query<{ parent_id: string | null }>("SELECT parent_id FROM tasks WHERE id = $1", [id]);
      const parent = num(own[0]?.parent_id ?? null);
      // Siblings that merge at once take turns, so the later one sees the earlier one merged.
      if (parent !== null) await client.query("SELECT 1 FROM tasks WHERE id = $1 FOR UPDATE", [parent]);
      await client.query(
        "UPDATE tasks SET status = 'merged', waiting_on = NULL, agent = NULL, merge_sha = COALESCE(merge_sha, $2), updated_at = now() WHERE id = $1",
        [id, mergeSha],
      );
      let released: number[] = [];
      if (parent !== null) {
        const { rows } = await client.query<{ id: string }>(
          `SELECT c.id FROM tasks c
            WHERE c.parent_id = $2 AND c.status = 'queued' AND $1 = ANY(c.prerequisites)
              AND NOT EXISTS (SELECT 1 FROM tasks p WHERE p.id = ANY(c.prerequisites) AND p.status <> 'merged')`,
          [id, parent],
        );
        released = rows.map((r) => Number(r.id)).sort((a, b) => a - b);
        await enqueueStarts(client, released);
      }
      await client.query("COMMIT");
      return released;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async cancelQueued(ids: readonly number[]): Promise<void> {
    await this.pool.query("UPDATE tasks SET status = 'cancelled', waiting_on = NULL, updated_at = now() WHERE id = ANY($1::bigint[]) AND status = 'queued'", [ids]);
  }

  async beginOperation(input: { effectKey: string; taskId: number; kind: OperationKind; requestHash: string; createdAt: string }): Promise<{ record: OperationRecord; created: boolean }> {
    const ins = await this.pool.query<{ effect_key: string }>(
      `INSERT INTO github_operations (effect_key, task_id, kind, request_hash, state, created_at)
       VALUES ($1, $2, $3, $4, 'intent', $5) ON CONFLICT (effect_key) DO NOTHING RETURNING effect_key`,
      [input.effectKey, input.taskId, input.kind, input.requestHash, input.createdAt],
    );
    const { rows } = await this.pool.query<{ effect_key: string; kind: OperationKind; request_hash: string; state: "intent" | "done"; result: unknown; created_at: Date | string }>(
      "SELECT effect_key, kind, request_hash, state, result, created_at FROM github_operations WHERE effect_key = $1",
      [input.effectKey],
    );
    const r = rows[0];
    if (!r) throw new Error("operation record missing after insert");
    if (r.request_hash !== input.requestHash || r.kind !== input.kind) throw new OperationConflictError(input.effectKey);
    return {
      record: { effectKey: r.effect_key, kind: r.kind, requestHash: r.request_hash, state: r.state, result: r.result, createdAt: new Date(r.created_at).toISOString() },
      created: ins.rows.length === 1,
    };
  }

  async updateOperation(effectKey: string, state: "intent" | "done", result: unknown): Promise<void> {
    await this.pool.query("UPDATE github_operations SET state = $2, result = $3, updated_at = now() WHERE effect_key = $1", [
      effectKey,
      state,
      JSON.stringify(result),
    ]);
  }

  async recordRevision(r: RevisionWrite): Promise<void> {
    await this.pool.query(
      "INSERT INTO task_revisions (task_id, revision, contract_hash, contract) VALUES ($1, $2, $3, $4) ON CONFLICT (task_id, revision) DO NOTHING",
      [r.taskId, r.revision, r.contractHash, JSON.stringify(r.contract)],
    );
  }

  async supersedeRevision(taskId: number, from: number, next: RevisionWrite): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE task_revisions SET superseded_at = now() WHERE task_id = $1 AND revision = $2 AND superseded_at IS NULL", [taskId, from]);
      await client.query(
        "UPDATE task_attempts SET outcome = 'superseded', ended_at = now() WHERE task_id = $1 AND revision = $2 AND outcome IS NULL",
        [taskId, from],
      );
      await client.query(
        "UPDATE task_evidence SET superseded_at = now() WHERE task_id = $1 AND revision = $2 AND kind = 'qa' AND superseded_at IS NULL",
        [taskId, from],
      );
      await client.query(
        "INSERT INTO task_revisions (task_id, revision, contract_hash, contract) VALUES ($1, $2, $3, $4) ON CONFLICT (task_id, revision) DO NOTHING",
        [next.taskId, next.revision, next.contractHash, JSON.stringify(next.contract)],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async recordAttempt(a: AttemptWrite): Promise<void> {
    await this.pool.query(
      `INSERT INTO task_attempts (effect_key, task_id, revision, role, op, contract_hash, base_sha, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (effect_key) DO NOTHING`,
      [a.effectKey, a.taskId, a.revision, a.role, a.op, a.contractHash, a.baseSha, a.createdAt],
    );
  }

  async updateAttempt(effectKey: string, f: AttemptUpdate): Promise<void> {
    await this.pool.query(
      `UPDATE task_attempts SET
         run_id = COALESCE(run_id, $2),
         started_at = CASE WHEN $3::timestamptz IS NOT NULL AND contract_hash IS NOT DISTINCT FROM $4 THEN COALESCE(started_at, $3::timestamptz) ELSE started_at END,
         ended_at = COALESCE(ended_at, $5::timestamptz),
         outcome = COALESCE(outcome, $6)
       WHERE effect_key = $1`,
      [effectKey, f.runId ?? null, f.startedAt ?? null, f.startContract ?? null, f.endedAt ?? null, f.outcome ?? null],
    );
  }

  async recordEvidence(e: EvidenceWrite): Promise<void> {
    await this.pool.query(
      `INSERT INTO task_evidence (effect_key, task_id, revision, kind, head_sha, outcome, attempt_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (effect_key) DO NOTHING`,
      [e.effectKey, e.taskId, e.revision, e.kind, e.headSha, e.outcome, e.attemptKey, e.createdAt],
    );
  }

  async loadValidity(taskId: number, revision: number | null, head: string): Promise<ValidityRows> {
    const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());
    const revisions = await this.pool.query<{ revision: number; superseded_at: Date | string | null }>(
      "SELECT revision, superseded_at FROM task_revisions WHERE task_id = $1 ORDER BY revision",
      [taskId],
    );
    const attempts = await this.pool.query<{ effect_key: string; revision: number | null; op: number; started_at: Date | string | null }>(
      "SELECT effect_key, revision, op, started_at FROM task_attempts WHERE task_id = $1 AND role = 'qa' AND revision IS NOT DISTINCT FROM $2 ORDER BY op",
      [taskId, revision],
    );
    const evidence = await this.pool.query<{
      kind: "ci" | "qa";
      revision: number | null;
      head_sha: string;
      outcome: EvidenceRow["outcome"];
      attempt_key: string | null;
      superseded_at: Date | string | null;
    }>("SELECT kind, revision, head_sha, outcome, attempt_key, superseded_at FROM task_evidence WHERE task_id = $1 AND head_sha = $2 ORDER BY created_at", [taskId, head]);
    return {
      revisions: revisions.rows.map((r) => ({ revision: Number(r.revision), superseded_at: iso(r.superseded_at) })),
      attempts: attempts.rows.map((r) => ({ effect_key: r.effect_key, revision: r.revision === null ? null : Number(r.revision), op: Number(r.op), started_at: iso(r.started_at) })),
      evidence: evidence.rows.map((r) => ({
        kind: r.kind,
        revision: r.revision === null ? null : Number(r.revision),
        head_sha: r.head_sha,
        outcome: r.outcome,
        attempt_key: r.attempt_key,
        superseded_at: iso(r.superseded_at),
      })),
    };
  }

  loadContacts(): Promise<ContactNames[]> {
    return loadContactNames({ query: <R>(sql: string) => this.pool.query(sql) as unknown as Promise<{ rows: R[] }> });
  }
}

/** AR3: a report usage line's purpose is the job that made the call (`report:<run>:<attempt>:<work|review>:<index>`). */
export function reportPurpose(dedupeKey: string): "work" | "review" | null {
  const m = /^report:\d+:\d+:(work|review):\d+$/.exec(dedupeKey);
  return m ? (m[1] as "work" | "review") : null;
}
