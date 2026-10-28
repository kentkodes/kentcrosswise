// The relay's database access, behind a small interface so tests can use a fake or PGlite.
import type { AgentRunRole } from "./normalize";
import type { ActionsMinutes } from "./usage";

/** Minimal SQL surface (fits `@kcw/db` SqlClient, node-postgres via fromPg, PGlite via fromPglite). */
export interface SqlQuery {
  query<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: R[] }>;
}

/** An agent_dispatches row (migration 0010): the task and role the orchestrator dispatched a run for. */
export interface DispatchLink {
  task_id: number;
  role: AgentRunRole;
}

const ROLES: readonly string[] = ["developer", "qa", "docs", "scraper"];

export interface RelayStore {
  /** Records a delivery in `inbound_events`. Returns false if it was already recorded (a duplicate). */
  claimDelivery(deliveryId: string, source: string): Promise<boolean>;
  /** Removes a claim after the queue send failed, so GitHub's redelivery is not dropped as a duplicate. */
  releaseDelivery(deliveryId: string): Promise<void>;
  /** `tasks.id` of the task with this PR, or null. */
  findTaskByPr(prNumber: number): Promise<number | null>;
  /** `tasks.id` of the task with this GitHub issue, or null. */
  findTaskByIssue(issueNumber: number): Promise<number | null>;
  /** The agent_dispatches link of this run id, or null (reads only run_id, task_id and role: relay_rw's grant). */
  findDispatch(runId: number): Promise<DispatchLink | null>;
  /**
   * Records a completed run's Actions minutes (cost 0) unless its dedupe key is already there.
   * `taskId` is linked only if that task exists. Returns false for a duplicate.
   */
  recordActionsMinutes(usage: ActionsMinutes, taskId: number | null): Promise<boolean>;
}

/** `inbound_events.source` for GitHub webhook deliveries. */
export const GITHUB_SOURCE = "github";

async function newestTask(db: SqlQuery, column: "pr_number" | "github_issue", n: number): Promise<number | null> {
  // Newest first: a PR or issue number belongs to one task, but a retried task row could repeat it.
  const { rows } = await db.query<{ id: string | number }>(
    `SELECT id FROM tasks WHERE ${column} = $1 ORDER BY id DESC LIMIT 1`,
    [n],
  );
  const id = rows[0] ? Number(rows[0].id) : NaN; // bigint arrives as a string from node-postgres
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function sqlRelayStore(db: SqlQuery): RelayStore {
  return {
    async claimDelivery(deliveryId, source) {
      const { rows } = await db.query(
        "INSERT INTO inbound_events (delivery_id, source) VALUES ($1, $2) ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id",
        [deliveryId, source],
      );
      return rows.length === 1;
    },
    async releaseDelivery(deliveryId) {
      await db.query("DELETE FROM inbound_events WHERE delivery_id = $1", [deliveryId]);
    },
    findTaskByPr: (n) => newestTask(db, "pr_number", n),
    findTaskByIssue: (n) => newestTask(db, "github_issue", n),
    async findDispatch(runId) {
      const { rows } = await db.query<{ task_id: string | number; role: string }>(
        "SELECT task_id, role FROM agent_dispatches WHERE run_id = $1",
        [runId],
      );
      const r = rows[0];
      if (!r) return null;
      const taskId = Number(r.task_id); // bigint arrives as a string from node-postgres
      // The table's constraints guarantee both; anything else is not a usable link.
      if (!Number.isSafeInteger(taskId) || taskId < 1 || !ROLES.includes(r.role)) return null;
      return { task_id: taskId, role: r.role as AgentRunRole };
    },
    async recordActionsMinutes(u, taskId) {
      // A task-like branch name does not prove the task row exists: link it only if it does.
      const { rows } = await db.query(
        `INSERT INTO usage_events (ts, kind, agent, minutes, cost_usd, task_id, dedupe_key)
         SELECT $1::timestamptz, 'actions_minutes', $2, $3, 0, (SELECT id FROM tasks WHERE id = $4::bigint), $5
         ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
        [u.ts, u.agent, u.minutes, taskId, u.dedupeKey],
      );
      return rows.length === 1;
    },
  };
}
