// Sends one Web Push message (RFC 8030 request, RFC 8291 body, RFC 8292 auth). The payload is generic by
// construction: callers pass a title, a body and a same-site path, never private text.
import { encryptPayload } from "./ece";
import { type VapidKeys, vapidAuthorization } from "./vapid";

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
export interface PushPayload {
  title: string;
  body: string;
  /** A path on this site, opened when the notification is tapped. */
  url: string;
}
/** sent: accepted (2xx); gone: the push service says the subscription is dead (404, 410); failed: anything else. */
export type PushResult = "sent" | "gone" | "failed";

const HOST_SUFFIXES = [".push.apple.com", ".notify.windows.com"] as const;
const HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com"] as const;
const TIMEOUT_MS = 10_000;

/** https URL on a known push service host, so the server never posts to an arbitrary host. */
export function isAllowedPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return (HOSTS as readonly string[]).includes(host) || HOST_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length);
}

/** The subscription's keys as the browser exports them (base64url), validated. */
export function parseSubscriptionKeys(keys: unknown): { p256dh: string; auth: string } | null {
  if (typeof keys !== "object" || keys === null) return null;
  const { p256dh, auth } = keys as Record<string, unknown>;
  if (typeof p256dh !== "string" || typeof auth !== "string") return null;
  if (!/^[A-Za-z0-9_-]+$/.test(p256dh) || !/^[A-Za-z0-9_-]+$/.test(auth)) return null;
  if (Buffer.from(p256dh, "base64url").length !== 65 || Buffer.from(auth, "base64url").length !== 16) return null;
  return { p256dh, auth };
}

export interface SendOptions {
  fetch?: typeof fetch;
  /** Seconds since the epoch (tests). */
  nowSeconds?: number;
}

export async function sendPush(
  sub: PushSubscriptionRecord,
  payload: PushPayload,
  vapid: VapidKeys,
  opts: SendOptions = {},
): Promise<PushResult> {
  if (!isAllowedPushEndpoint(sub.endpoint)) return "failed";
  const keys = parseSubscriptionKeys(sub.keys);
  if (!keys) return "failed";
  const body = encryptPayload({
    plaintext: Buffer.from(JSON.stringify(payload)),
    uaPublic: Buffer.from(keys.p256dh, "base64url"),
    authSecret: Buffer.from(keys.auth, "base64url"),
  });
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: vapidAuthorization(sub.endpoint, vapid, now),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "86400",
        Urgency: "normal",
      },
      body: new Uint8Array(body),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return "failed";
  }
  if (res.status === 404 || res.status === 410) return "gone";
  return res.status >= 200 && res.status < 300 ? "sent" : "failed";
}
