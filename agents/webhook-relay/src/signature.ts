import { createHmac, timingSafeEqual } from "node:crypto";

export type SignatureResult = "valid" | "invalid" | "missing";

const HEADER_FORMAT = /^sha256=([0-9a-f]{64})$/;

/**
 * Checks GitHub's `X-Hub-Signature-256` header: `sha256=` + hex HMAC-SHA256 of the raw request body
 * with the webhook secret. The comparison is constant-time. The body must be the exact bytes GitHub
 * sent (never re-serialized JSON).
 */
export function verifySignature(rawBody: Uint8Array, header: string | undefined, secret: string): SignatureResult {
  if (secret.length === 0) throw new Error("webhook secret is empty");
  if (header === undefined || header.length === 0) return "missing";
  const m = HEADER_FORMAT.exec(header.trim().toLowerCase());
  if (!m) return "invalid";
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(m[1]!, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected) ? "valid" : "invalid";
}

/** Computes the header value GitHub would send (tests and local tools). */
export function signBody(rawBody: Uint8Array | string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}
