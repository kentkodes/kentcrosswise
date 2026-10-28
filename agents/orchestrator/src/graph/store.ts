// The task graph's database access, as orch_rw (DESIGN §3.2, §3.4): tasks, agent_events,
// approvals (+ inbox items, migration 0003), usage_events, system_flags, contact names.
import type { AgentName, EventType, Usage } from "@kcw/core/events";
import { loadContactNames, type ContactNames } from "@kcw/core/sanitize";
import type pg from "pg";
import type { AgentRunRole, Decision, WaitingOn } from "./types";

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
}

export interface ChildTask {
  id: number;
  status: TaskStatus;
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
  updateTask(id: number, fields: TaskUpdate): Promise<void>;
  addEvent(taskId: number, agent: AgentName, type: EventType, detail?: Record<string, unknown>): Promise<void>;
  addUsage(taskId: number, agent: AgentName, usage: readonly Usage[]): Promise<void>;
  /** An approval plus its inbox item, in one transaction. Returns the approval id. */
  createApproval(input: { taskId: number; kind: ApprovalKind; reasons: string[]; inboxTitle: string }): Promise<string>;
  getApproval(id: string): Promise<ApprovalRecord | null>;
  /** Closes a pending approval the thread no longer waits on (e.g. the PR head changed). */
  supersedeApproval(id: string, note: string): Promise<void>;
  loadContacts(): Promise<ContactNames[]>;
  /**
   * §4.2 step 2: one child `tasks` row per subtask (queued, thread `task-<id>`, source and
   * is_private copied from the parent), in one transaction. If the parent already has children
   * (a retried step), returns those instead. Ids in subtask order.
   */
  createSubtasks(parentId: number, ownerTexts: readonly string[]): Promise<number[]>;
  getChildren(parentId: number): Promise<ChildTask[]>;
  /**
   * §4.2 step 8: the docs task of a merged task (a child row: queued, source `github`, is_private
   * copied, fixed owner text naming the PR, thread `task-<id>`; the docs start sets the branch). A merged
   * task has no other children (a split parent never merges, a subtask never splits), so an
   * existing child is the docs task of a retried step and is returned instead.
   */
  createDocsTask(mergedId: number, pr: number, publicTitle: string | null): Promise<number>;
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
] as const satisfies readonly (keyof TaskUpdate)[];

const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

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
    }>("SELECT id, status, owner_text, is_private, github_issue, parent_id FROM tasks WHERE id = $1", [id]);
    const r = rows[0];
    return r
      ? {
          id: Number(r.id),
          status: r.status,
          owner_text: r.owner_text,
          is_private: r.is_private,
          github_issue: r.github_issue,
          parent_id: num(r.parent_id),
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

  async addEvent(taskId: number, agent: AgentName, type: EventType, detail: Record<string, unknown> = {}): Promise<void> {
    await this.pool.query("INSERT INTO agent_events (task_id, agent, event_type, detail) VALUES ($1, $2, $3, $4)", [
      taskId,
      agent,
      type,
      JSON.stringify(detail),
    ]);
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

  async createApproval(input: { taskId: number; kind: ApprovalKind; reasons: string[]; inboxTitle: string }): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ id: string }>(
        "INSERT INTO approvals (task_id, kind, reasons) VALUES ($1, $2, $3) RETURNING id",
        [input.taskId, input.kind, input.reasons],
      );
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

  async createSubtasks(parentId: number, ownerTexts: readonly string[]): Promise<number[]> {
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
      }
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
    const { rows } = await this.pool.query<{ id: string; status: TaskStatus }>(
      "SELECT id, status FROM tasks WHERE parent_id = $1 ORDER BY id",
      [parentId],
    );
    return rows.map((r) => ({ id: Number(r.id), status: r.status }));
  }

  loadContacts(): Promise<ContactNames[]> {
    return loadContactNames({ query: <R>(sql: string) => this.pool.query(sql) as unknown as Promise<{ rows: R[] }> });
  }
}
