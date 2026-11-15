import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SecretKeyMissingError } from "@kcw/secrets";
import { runAs } from "../src/server/db";
import { type InboxPushDeps, PushDeliveryError, runInboxPush } from "../src/server/jobs/inbox-push";
import { loadVapidKeys } from "../src/server/push/keys";
import type { PushResult } from "../src/server/push/send";
import { freshDb, pglitePool } from "./pglite";

const KEYS = { publicKey: "pub", privateKey: "priv" };
let pg: PGlite;
beforeAll(async () => {
  pg = await freshDb();
}, 60_000);
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec("DELETE FROM inbox_items; DELETE FROM push_subscriptions;");
});

async function addSub(endpoint: string) {
  await pg.query(`INSERT INTO push_subscriptions (endpoint, keys) VALUES ($1, '{"p256dh":"a","auth":"b"}')`, [endpoint]);
}
async function addItem(role: "web_rw" | "orch_rw", title: string) {
  await pg.exec(`SET ROLE ${role}`);
  try {
    await pg.query(`INSERT INTO inbox_items (kind, ref_table, ref_id, title) VALUES ('approval', 't', $1, $2)`, [title, title]);
  } finally {
    await pg.exec("RESET ROLE");
  }
}
const deps = (result: (endpoint: string) => PushResult, keys: typeof KEYS | null = KEYS) => {
  const send = vi.fn(async (sub: { endpoint: string }, _payload: unknown, _keys: unknown) => result(sub.endpoint));
  const d: InboxPushDeps = { run: (fn) => runAs(pglitePool(pg), "web_rw", fn), loadKeys: async () => keys, send };
  return { d, send };
};
const unnotified = async () => (await pg.query<{ n: number }>(`SELECT count(*)::int n FROM inbox_items WHERE notified_at IS NULL`)).rows[0]!.n;

describe("runInboxPush", () => {
  it("is off without keys, without items and without subscriptions, and sends nothing", async () => {
    await addSub("https://fcm.googleapis.com/a");
    const none = deps(() => "sent", null);
    expect((await runInboxPush(none.d)).code).toBe("off");
    const noItems = deps(() => "sent");
    expect((await runInboxPush(noItems.d)).code).toBe("off");
    await pg.exec("DELETE FROM push_subscriptions");
    await addItem("web_rw", "one");
    const noSubs = deps(() => "sent");
    expect((await runInboxPush(noSubs.d)).code).toBe("off");
    expect(none.send).not.toHaveBeenCalled();
    expect(noItems.send).not.toHaveBeenCalled();
    expect(noSubs.send).not.toHaveBeenCalled();
    expect(await unnotified()).toBe(1);
  });

  it("sends one generic payload per subscription and marks items once, orchestrator items included", async () => {
    await addSub("https://fcm.googleapis.com/a");
    await addSub("https://web.push.apple.com/b");
    await addItem("web_rw", "SECRET TEXT one");
    await addItem("orch_rw", "SECRET TEXT two");
    const { d, send } = deps(() => "sent");
    const out = await runInboxPush(d);
    expect(out).toEqual({ code: "ok", counts: { items: 2, sent: 2, failed: 0, gone: 0 } });
    expect(send).toHaveBeenCalledTimes(2);
    const payload = send.mock.calls[0]![1] as unknown;
    expect(payload).toEqual({ title: "Kentcrosswise", body: "2 new items in your inbox", url: "/inbox" });
    expect(JSON.stringify(payload)).not.toContain("SECRET");
    expect(await unnotified()).toBe(0);
    expect((await runInboxPush(d)).code).toBe("off");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("only announces open items; a resolved item is not counted", async () => {
    await addSub("https://fcm.googleapis.com/a");
    await addItem("web_rw", "one");
    await pg.exec("UPDATE inbox_items SET status = 'done', resolved_at = now()");
    const { d, send } = deps(() => "sent");
    expect((await runInboxPush(d)).code).toBe("off");
    expect(send).not.toHaveBeenCalled();
  });

  it("deletes a subscription on 404/410 and keeps the others, items still marked", async () => {
    await addSub("https://fcm.googleapis.com/dead");
    await addSub("https://fcm.googleapis.com/live");
    await addItem("web_rw", "one");
    const { d } = deps((e) => (e.endsWith("dead") ? "gone" : "sent"));
    expect((await runInboxPush(d)).counts).toMatchObject({ sent: 1, gone: 1 });
    const left = (await pg.query<{ endpoint: string }>("SELECT endpoint FROM push_subscriptions")).rows;
    expect(left.map((r) => r.endpoint)).toEqual(["https://fcm.googleapis.com/live"]);
    expect(await unnotified()).toBe(0);
  });

  it("throws when every subscription fails, keeping items un-notified and subscriptions", async () => {
    await addSub("https://fcm.googleapis.com/a");
    await addItem("web_rw", "one");
    const { d } = deps(() => "failed");
    await expect(runInboxPush(d)).rejects.toBeInstanceOf(PushDeliveryError);
    expect(await unnotified()).toBe(1);
    expect((await pg.query("SELECT 1 FROM push_subscriptions")).rows).toHaveLength(1);
  });

  it("is off, not a failure, when every subscription is gone", async () => {
    await addSub("https://fcm.googleapis.com/a");
    await addItem("web_rw", "one");
    const { d } = deps(() => "gone");
    expect((await runInboxPush(d)).code).toBe("off");
    expect(await unnotified()).toBe(1);
  });

  it("propagates a database error", async () => {
    const d: InboxPushDeps = { run: async () => { throw new Error("db down"); }, loadKeys: async () => KEYS, send: async () => "sent" };
    await expect(runInboxPush(d)).rejects.toThrow("db down");
  });
});

describe("loadVapidKeys", () => {
  const store = (values: Record<string, string>) => ({
    get: (async (_name: string, key?: string) => {
      if (key && key in values) return values[key]!;
      throw new SecretKeyMissingError("kcw/prod/web", key ?? "");
    }) as never,
  });
  it("reads both keys from the named secret and treats a missing key as not set up", async () => {
    const spy = vi.fn(store({ vapid_public: " P ", vapid_private: "S" }).get);
    expect(await loadVapidKeys({ KCW_WEB_SECRET: "x/web" }, { get: spy })).toEqual({ publicKey: "P", privateKey: "S" });
    expect(spy).toHaveBeenCalledWith("x/web", "vapid_public");
    expect(await loadVapidKeys({}, store({ vapid_public: "P" }))).toBeNull();
  });
  it("lets other secret errors through", async () => {
    await expect(loadVapidKeys({}, { get: (async () => { throw new TypeError("aws"); }) as never })).rejects.toThrow("aws");
  });
});
