import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_PLAINTEXT_BYTES, encryptPayload } from "../src/server/push/ece";

const u = (s: string) => Buffer.from(s, "base64url");

// RFC 8291 section 5 and Appendix A (copied from the RFC text).
const PLAINTEXT = "When I grow up, I want to be a watermelon";
const AUTH = "BTBZMqHH6r4Tts7J_aSIgg";
const UA_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const UA_PRIVATE = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
const AS_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
const SALT = "DGv6ra1nlYgDCS1FRnbzlw";
const EXPECTED =
  "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
  "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
  "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

describe("encryptPayload", () => {
  it("reproduces the RFC 8291 example byte for byte", () => {
    const out = encryptPayload({
      plaintext: Buffer.from(PLAINTEXT),
      uaPublic: u(UA_PUBLIC),
      authSecret: u(AUTH),
      salt: u(SALT),
      senderPrivate: u(AS_PRIVATE),
    });
    expect(out.length).toBe(144); // the RFC prints Content-Length 145, but its 192 base64url characters are 144 bytes
    expect(out.toString("base64url")).toBe(EXPECTED);
  });

  it("decrypts with the user agent's private key (random salt and key)", () => {
    const out = encryptPayload({ plaintext: Buffer.from("hello"), uaPublic: u(UA_PUBLIC), authSecret: u(AUTH) });
    const salt = out.subarray(0, 16);
    expect(out.readUInt32BE(16)).toBe(4096);
    expect(out[20]).toBe(65);
    const asPublic = out.subarray(21, 86);
    const ua = createECDH("prime256v1");
    ua.setPrivateKey(u(UA_PRIVATE));
    const secret = ua.computeSecret(asPublic);
    const ikm = Buffer.from(hkdfSync("sha256", secret, u(AUTH), Buffer.concat([Buffer.from("WebPush: info\0"), u(UA_PUBLIC), asPublic]), 32));
    const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
    const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
    const d = createDecipheriv("aes-128-gcm", cek, nonce);
    const rest = out.subarray(86);
    d.setAuthTag(rest.subarray(rest.length - 16));
    const plain = Buffer.concat([d.update(rest.subarray(0, rest.length - 16)), d.final()]);
    expect(plain.toString("latin1")).toBe("hello\u0002");
  });

  it("rejects bad keys and oversized payloads", () => {
    const ok = { plaintext: Buffer.from("x"), uaPublic: u(UA_PUBLIC), authSecret: u(AUTH) };
    expect(() => encryptPayload({ ...ok, uaPublic: Buffer.alloc(64) })).toThrow("bad_ua_public");
    expect(() => encryptPayload({ ...ok, authSecret: Buffer.alloc(15) })).toThrow("bad_auth_secret");
    expect(() => encryptPayload({ ...ok, plaintext: Buffer.alloc(MAX_PLAINTEXT_BYTES + 1) })).toThrow("payload_too_large");
  });
});
