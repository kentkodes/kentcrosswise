// The relay's database access, behind a small interface so tests can use a fake or PGlite.

/** Minimal SQL surface (fits `@kcw/db` SqlClient, node-postgres via fromPg, PGlite via fromPglite). */
export interface SqlQuery {
  query<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: R[] }>;
}

export interface RelayStore {
  /** Records a delivery in `inbound_events`. Returns false if it was already recorded (a duplicate). */
  claimDelivery(deliveryId: string, source: string): Promise<boolean>;
  /** Removes a claim after the queue send failed, so GitHub's redelivery is not dropped as a duplicate. */
  releaseDelivery(deliveryId: string): Promise<void>;
  /** `tasks.id` of the task with this PR, or null. */
  findTaskByPr(prNumber: number): Promise<number | null>;
  /** `tasks.id` of the task with this GitHub issue, or null. */
  findTaskByIssue(issueNumber: number): Promise<number | null>;
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
  };
}
