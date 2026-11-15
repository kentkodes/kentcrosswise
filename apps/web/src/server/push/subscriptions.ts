// Push subscription rows (table push_subscriptions) for the /notifications page. Runs as web_rw through the
// caller's Queryable. Only endpoints on the push service allowlist are stored.
import type { Queryable } from "../db";
import { type PushPayload, type PushResult, type PushSubscriptionRecord, isAllowedPushEndpoint, parseSubscriptionKeys } from "./send";
import type { VapidKeys } from "./vapid";

export type SaveResult = "saved" | "invalid";

/** Validates the browser's subscription JSON (endpoint + p256dh/auth keys) and upserts it by endpoint. */
export async function saveSubscription(db: Queryable, input: unknown): Promise<SaveResult> {
  if (typeof input !== "object" || input === null) return "invalid";
  const { endpoint, keys } = input as { endpoint?: unknown; keys?: unknown };
  if (!isAllowedPushEndpoint(endpoint)) return "invalid";
  const parsed = parseSubscriptionKeys(keys);
  if (!parsed) return "invalid";
  await db.query(
    `INSERT INTO push_subscriptions (endpoint, keys) VALUES ($1, $2::jsonb)
     ON CONFLICT (endpoint) DO UPDATE SET keys = EXCLUDED.keys`,
    [endpoint, JSON.stringify(parsed)],
  );
  return "saved";
}

export async function deleteSubscription(db: Queryable, endpoint: unknown): Promise<void> {
  if (typeof endpoint !== "string") return;
  await db.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
}

export async function countSubscriptions(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM push_subscriptions`);
  return rows[0]?.n ?? 0;
}

export const TEST_PAYLOAD: PushPayload = { title: "Kentcrosswise", body: "Test notification", url: "/hub" };

export type TestOutcome = "sent" | "none" | "failed";

/** Sends the generic test notification to every subscription now; dead ones (404/410) are removed. */
export async function sendTestPush(
  db: Queryable,
  keys: VapidKeys,
  send: (sub: PushSubscriptionRecord, payload: PushPayload, keys: VapidKeys) => Promise<PushResult>,
): Promise<TestOutcome> {
  const { rows } = await db.query<{ id: string; endpoint: string; keys: PushSubscriptionRecord["keys"] }>(
    `SELECT id, endpoint, keys FROM push_subscriptions ORDER BY created_at, id`,
  );
  if (rows.length === 0) return "none";
  let sent = 0;
  const gone: string[] = [];
  for (const row of rows) {
    const result = await send({ endpoint: row.endpoint, keys: row.keys }, TEST_PAYLOAD, keys);
    if (result === "sent") sent++;
    else if (result === "gone") gone.push(row.id);
  }
  if (gone.length > 0) await db.query(`DELETE FROM push_subscriptions WHERE id = ANY($1::uuid[])`, [gone]);
  return sent > 0 ? "sent" : gone.length === rows.length ? "none" : "failed";
}
