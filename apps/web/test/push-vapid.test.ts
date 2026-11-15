import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { VAPID_SUBJECT, vapidAuthorization, vapidJwt } from "../src/server/push/vapid";

function newKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });
  const pub = publicKey.export({ format: "jwk" });
  return {
    keys: {
      privateKey: jwk.d!,
      publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(pub.x!, "base64url"), Buffer.from(pub.y!, "base64url")]).toString("base64url"),
    },
    pub,
  };
}

describe("vapid", () => {
  it("builds the RFC 8292 header and claims and signs with ES256", () => {
    const { keys, pub } = newKeys();
    const jwt = vapidJwt("https://push.example.net/push/abc?x=1", keys, 1453523768 - 12 * 3600);
    const [h, c, s] = jwt.split(".") as [string, string, string];
    // RFC 8292 section 2 example: same header segment; claims in the same order (aud, exp, sub).
    expect(h).toBe("eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9");
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toEqual({
      aud: "https://push.example.net",
      exp: 1453523768,
      sub: VAPID_SUBJECT,
    });
    expect(Buffer.from(c, "base64url").toString().startsWith('{"aud":"https://push.example.net","exp":1453523768,"sub":')).toBe(true);
    expect(Buffer.from(s, "base64url").length).toBe(64);
    const ok = verify("sha256", Buffer.from(`${h}.${c}`), { key: createPublicKey({ format: "jwk", key: pub }), dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
    expect(ok).toBe(true);
  });

  it("formats the Authorization header with the public key", () => {
    const { keys } = newKeys();
    const header = vapidAuthorization("https://fcm.googleapis.com/fcm/send/x", keys, 1_000);
    expect(header).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    expect(header.endsWith(`k=${keys.publicKey}`)).toBe(true);
  });

  it("rejects malformed keys", () => {
    const { keys } = newKeys();
    expect(() => vapidJwt("https://a.example", { ...keys, publicKey: "AAAA" }, 1)).toThrow("bad_vapid_public");
    expect(() => vapidJwt("https://a.example", { ...keys, privateKey: "AAAA" }, 1)).toThrow("bad_vapid_private");
  });
});
