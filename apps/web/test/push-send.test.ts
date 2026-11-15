import { createECDH, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { isAllowedPushEndpoint, parseSubscriptionKeys, sendPush } from "../src/server/push/send";

const ua = createECDH("prime256v1");
ua.generateKeys();
const sub = (endpoint = "https://fcm.googleapis.com/fcm/send/abc") => ({
  endpoint,
  keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
});
const vapid = (() => {
  const e = createECDH("prime256v1");
  e.generateKeys();
  return { publicKey: e.getPublicKey().toString("base64url"), privateKey: e.getPrivateKey().toString("base64url") };
})();
const payload = { title: "Kentcrosswise", body: "2 new items in your inbox", url: "/inbox" };
const respond = (status: number) => vi.fn(async () => new Response(null, { status }));

describe("sendPush", () => {
  it("posts an encrypted body with the VAPID, TTL and encoding headers", async () => {
    const f = respond(201);
    expect(await sendPush(sub(), payload, vapid, { fetch: f as unknown as typeof fetch, nowSeconds: 1000 })).toBe("sent");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://fcm.googleapis.com/fcm/send/abc");
    const h = init.headers as Record<string, string>;
    expect(h["Content-Encoding"]).toBe("aes128gcm");
    expect(h.TTL).toBe("86400");
    expect(h.Urgency).toBe("normal");
    expect(h.Authorization).toMatch(/^vapid t=.+, k=/);
    expect(init.method).toBe("POST");
    expect((init.body as Uint8Array).length).toBe(86 + Buffer.byteLength(JSON.stringify(payload)) + 1 + 16);
  });

  it("maps 404 and 410 to gone, other statuses and network errors to failed", async () => {
    const call = (f: typeof fetch) => sendPush(sub(), payload, vapid, { fetch: f });
    expect(await call(respond(410) as unknown as typeof fetch)).toBe("gone");
    expect(await call(respond(404) as unknown as typeof fetch)).toBe("gone");
    expect(await call(respond(500) as unknown as typeof fetch)).toBe("failed");
    expect(await call(respond(429) as unknown as typeof fetch)).toBe("failed");
    expect(await call((async () => { throw new TypeError("boom"); }) as unknown as typeof fetch)).toBe("failed");
  });

  it("never calls fetch for a host off the allowlist or malformed keys", async () => {
    const f = respond(201);
    const opts = { fetch: f as unknown as typeof fetch };
    expect(await sendPush(sub("https://evil.example.com/x"), payload, vapid, opts)).toBe("failed");
    expect(await sendPush({ endpoint: sub().endpoint, keys: { p256dh: "x", auth: "y" } }, payload, vapid, opts)).toBe("failed");
    expect(f).not.toHaveBeenCalled();
  });
});

describe("isAllowedPushEndpoint", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/x",
    "https://web.push.apple.com/Qx",
    "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://db5p.notify.windows.com/?token=x",
  ])("accepts %s", (u) => expect(isAllowedPushEndpoint(u)).toBe(true));
  it.each([
    "http://fcm.googleapis.com/x",
    "https://fcm.googleapis.com.evil.example/x",
    "https://evilfcm.googleapis.com/x",
    "https://push.apple.com/x",
    "https://user:pw@fcm.googleapis.com/x",
    "https://fcm.googleapis.com:8443/x",
    "https://example.com/x",
    "not a url",
    42,
  ])("rejects %s", (u) => expect(isAllowedPushEndpoint(u)).toBe(false));
});

describe("parseSubscriptionKeys", () => {
  it("checks the key lengths", () => {
    expect(parseSubscriptionKeys(sub().keys)).not.toBeNull();
    expect(parseSubscriptionKeys({ p256dh: "AAAA", auth: "AAAA" })).toBeNull();
    expect(parseSubscriptionKeys(null)).toBeNull();
  });
});
