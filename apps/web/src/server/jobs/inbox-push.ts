// inbox-push: one generic notification per subscription when open inbox items have not been announced yet.
// The text never carries inbox content (wave 2 design, section 5). Runs on the sweeper's quarter hours.
// Import graph rule: no next, next-auth, `@/` alias or ../auth (this module is bundled into the OpenNext wrapper).
import { withDb, type Queryable } from "../db";
import { loadVapidKeys } from "../push/keys";
import { type PushPayload, type PushResult, type PushSubscriptionRecord, sendPush } from "../push/send";
import type { VapidKeys } from "../push/vapid";
import type { JobHandler } from "./index";

/** Every subscription failed with something other than 404/410 (the hub-jobs alarm counts the throw). */
export class PushDeliveryError extends Error {
  override name = "PushDeliveryError";
}

export interface InboxPushDeps {
  run: <T>(fn: (db: Queryable) => Promise<T>) => Promise<T>;
  loadKeys: () => Promise<VapidKeys | null>;
  send: (sub: PushSubscriptionRecord, payload: PushPayload, keys: VapidKeys) => Promise<PushResult>;
}

const defaultDeps: InboxPushDeps = {
  run: (fn) => withDb("web_rw", fn),
  loadKeys: () => loadVapidKeys(),
  send: (sub, payload, keys) => sendPush(sub, payload, keys),
};

export function inboxPushPayload(count: number): PushPayload {
  return { title: "Kentcrosswise", body: `${count} new ${count === 1 ? "item" : "items"} in your inbox`, url: "/inbox" };
}

export async function runInboxPush(deps: InboxPushDeps): Promise<{ code: string; counts: Record<string, number> }> {
  const off = (counts: Record<string, number> = {}) => ({ code: "off", counts });
  const keys = await deps.loadKeys();
  if (!keys) return off();

  const pending = await deps.run(async (db) => {
    const { rows } = await db.query<{ n: number; at: string }>(
      `SELECT count(*)::int AS n, now()::text AS at FROM inbox_items WHERE status = 'open' AND notified_at IS NULL`,
    );
    return rows[0]!;
  });
  if (pending.n === 0) return off({ items: 0 });

  const subs = await deps.run(async (db) => {
    const { rows } = await db.query<{ id: string; endpoint: string; keys: unknown }>(
      `SELECT id, endpoint, keys FROM push_subscriptions ORDER BY created_at, id`,
    );
    return rows;
  });
  if (subs.length === 0) return off({ items: pending.n });

  const payload = inboxPushPayload(pending.n);
  let sent = 0;
  let failed = 0;
  const gone: string[] = [];
  for (const row of subs) {
    const result = await deps.send({ endpoint: row.endpoint, keys: row.keys as PushSubscriptionRecord["keys"] }, payload, keys);
    if (result === "sent") sent++;
    else if (result === "gone") gone.push(row.id);
    else failed++;
  }
  if (gone.length > 0) {
    console.log("[push] subscription_gone");
    await deps.run((db) => db.query(`DELETE FROM push_subscriptions WHERE id = ANY($1::uuid[])`, [gone]));
  }
  if (failed > 0) console.error("[push] send_failed");
  if (sent === 0) {
    if (failed > 0) throw new PushDeliveryError("send_failed");
    return off({ items: pending.n, gone: gone.length });
  }
  // Items created after the count stay un-notified for the next run.
  await deps.run((db) =>
    db.query(`UPDATE inbox_items SET notified_at = now() WHERE status = 'open' AND notified_at IS NULL AND created_at <= $1`, [pending.at]),
  );
  return { code: "ok", counts: { items: pending.n, sent, failed, gone: gone.length } };
}

export const inboxPush: JobHandler = () => runInboxPush(defaultDeps);
