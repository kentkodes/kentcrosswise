import { createECDH, randomBytes } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Queryable, runAs } from "../src/server/db";
import { countSubscriptions, deleteSubscription, saveSubscription, sendTestPush } from "../src/server/push/subscriptions";
import { freshDb, pglitePool } from "./pglite";

let pg: PGlite;
beforeAll(async () => {
  pg = await freshDb();
}, 60_000);
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec("DELETE FROM push_subscriptions");
});
function as<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  return runAs(pglitePool(pg), "web_rw", fn);
}

const e = createECDH("prime256v1");
e.generateKeys();
const keys = () => ({ p256dh: e.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") });
const VAPID = { publicKey: "p", privateKey: "q" };

describe("saveSubscription", () => {
  it("stores an allowlisted https endpoint and updates the keys on a repeat", async () => {
    const endpoint = "https://fcm.googleapis.com/fcm/send/abc";
    expect(await as((db) => saveSubscription(db, { endpoint, keys: keys() }))).toBe("saved");
    const second = keys();
    expect(await as((db) => saveSubscription(db, { endpoint, keys: second }))).toBe("saved");
    expect(await as(countSubscriptions)).toBe(1);
    const row = (await pg.query<{ keys: { auth: string } }>("SELECT keys FROM push_subscriptions")).rows[0]!;
    expect(row.keys.auth).toBe(second.auth);
  });

  it("rejects a non-https, unlisted or malformed subscription and stores nothing", async () => {
    for (const input of [
      { endpoint: "http://fcm.googleapis.com/x", keys: keys() },
      { endpoint: "https://example.com/x", keys: keys() },
      { endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "a", auth: "b" } },
      { endpoint: "https://fcm.googleapis.com/x" },
      null,
      "x",
    ]) {
      expect(await as((db) => saveSubscription(db, input))).toBe("invalid");
    }
    expect(await as(countSubscriptions)).toBe(0);
  });

  it("deletes by endpoint", async () => {
    const endpoint = "https://fcm.googleapis.com/fcm/send/abc";
    await as((db) => saveSubscription(db, { endpoint, keys: keys() }));
    await as((db) => deleteSubscription(db, endpoint));
    expect(await as(countSubscriptions)).toBe(0);
  });
});

describe("sendTestPush", () => {
  it("reports none without subscriptions, sent on success, and removes dead subscriptions", async () => {
    const send = vi.fn(async (sub: { endpoint: string }, _payload: unknown, _keys: unknown) => (sub.endpoint.endsWith("dead") ? ("gone" as const) : ("sent" as const)));
    expect(await as((db) => sendTestPush(db, VAPID, send))).toBe("none");
    await as((db) => saveSubscription(db, { endpoint: "https://fcm.googleapis.com/dead", keys: keys() }));
    await as((db) => saveSubscription(db, { endpoint: "https://fcm.googleapis.com/live", keys: keys() }));
    expect(await as((db) => sendTestPush(db, VAPID, send))).toBe("sent");
    expect(await as(countSubscriptions)).toBe(1);
    expect(send.mock.calls[0]![1]).toEqual({ title: "Kentcrosswise", body: "Test notification", url: "/hub" });
  });

  it("reports failed when the service errors and keeps the subscription", async () => {
    await as((db) => saveSubscription(db, { endpoint: "https://fcm.googleapis.com/a", keys: keys() }));
    expect(await as((db) => sendTestPush(db, VAPID, async () => "failed"))).toBe("failed");
    expect(await as(countSubscriptions)).toBe(1);
  });
});
