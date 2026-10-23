// The task graph's database access, as orch_rw (DESIGN §3.2, §3.4): tasks, agent_events,
// approvals (+ inbox items, migration 0003), usage_events, system_flags, contact names.
import type { AgentName, EventType, Usage } from "@kcw/core/events";
import { loadContactNames, type ContactNames } from "@kcw/core/sanitize";
import type pg from "pg";
import type { Decision, WaitingOn } from "./types";

export type TaskStatus = "queued" | "planning" | "in_progress" | "waiting" | "merged" | "done" | "failed" | "cancelled";

export interface TaskRecord {
  id: number;
  status: TaskStatus;
  /** Private. */
  owner_text: string;
  is_private: boolean;
  github_issue: number | null;
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

export interface TaskStore {
  getTask(id: number): Promise<TaskRecord | null>;
  /** system_flags.agents_paused (Q2). */
  isPaused(): Promise<boolean>;
  /**
   * D20: moves a queued task to `planning` if fewer than `limit` other tasks are in flight
   * (planning, in_progress, waiting). Serialized across threads by an advisory lock. A task that
   * is already in flight keeps its slot (true).
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

  async getTask(id: number): Promise<TaskRecord | null> {
    const { rows } = await this.pool.query<{
      id: string;
      status: TaskStatus;
      owner_text: string;
      is_private: boolean;
      github_issue: number | null;
    }>("SELECT id, status, owner_text, is_private, github_issue FROM tasks WHERE id = $1", [id]);
    const r = rows[0];
    return r ? { id: Number(r.id), status: r.status, owner_text: r.owner_text, is_private: r.is_private, github_issue: r.github_issue } : null;
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
          "SELECT count(*)::int AS n FROM tasks WHERE status = ANY($1::text[]) AND id <> $2",
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

  loadContacts(): Promise<ContactNames[]> {
    return loadContactNames({ query: <R>(sql: string) => this.pool.query(sql) as unknown as Promise<{ rows: R[] }> });
  }
}
