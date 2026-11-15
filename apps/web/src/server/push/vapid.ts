// RFC 8292 (VAPID): an ES256 JWT in `Authorization: vapid t=<jwt>, k=<public key>`. node:crypto only.
import { createPrivateKey, sign } from "node:crypto";

/** The JWT subject: a contact URI. An https URI, never a mailto (the repository is public). */
export const VAPID_SUBJECT = "https://kentcrosswise.com";
export const VAPID_TTL_SECONDS = 12 * 60 * 60;

const b64 = (v: Buffer | string) => Buffer.from(v).toString("base64url");

export interface VapidKeys {
  /** 65-byte uncompressed P-256 point, base64url. */
  publicKey: string;
  /** 32-byte scalar, base64url. */
  privateKey: string;
}

/** The ES256 JWT for the push service at `endpoint` (aud is its origin). `nowSeconds` is injectable. */
export function vapidJwt(endpoint: string, keys: VapidKeys, nowSeconds: number, subject = VAPID_SUBJECT): string {
  const pub = Buffer.from(keys.publicKey, "base64url");
  const d = Buffer.from(keys.privateKey, "base64url");
  if (pub.length !== 65 || pub[0] !== 4) throw new RangeError("bad_vapid_public");
  if (d.length !== 32) throw new RangeError("bad_vapid_private");
  const key = createPrivateKey({
    format: "jwk",
    key: { kty: "EC", crv: "P-256", d: b64(d), x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33)) },
  });
  const input =
    `${b64(JSON.stringify({ typ: "JWT", alg: "ES256" }))}.` +
    b64(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSeconds + VAPID_TTL_SECONDS, sub: subject }));
  const signature = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return `${input}.${b64(signature)}`;
}

/** The Authorization header value. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, nowSeconds: number): string {
  return `vapid t=${vapidJwt(endpoint, keys, nowSeconds)}, k=${keys.publicKey}`;
}
