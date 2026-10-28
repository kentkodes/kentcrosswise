import { createHash } from "node:crypto";

/** Query parameters that only track a visitor, never select a page. Matched case-insensitively. */
const TRACKING_EXACT = new Set([
  "fbclid", "gclid", "dclid", "msclkid", "yclid", "igshid", "mc_cid", "mc_eid", "_hsenc", "_hsmi", "ref_src",
  "ref_url", "spm", "gbraid", "wbraid", "mkt_tok",
]);
const TRACKING_PREFIX = ["utm_", "pk_", "hsa_"];

function isTracking(name: string): boolean {
  const n = name.toLowerCase();
  return TRACKING_EXACT.has(n) || TRACKING_PREFIX.some((p) => n.startsWith(p));
}

const UNRESERVED = /[A-Za-z0-9\-._~]/;

/** Decodes %XX of unreserved characters and uppercases the hex of every other escape. */
function normalizeEscapes(s: string): string {
  return s.replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) => {
    const ch = String.fromCharCode(parseInt(hex, 16));
    return UNRESERVED.test(ch) ? ch : `%${hex.toUpperCase()}`;
  });
}

/**
 * The one form of a URL used as identity (`essay_urls.url`): lowercase scheme and host, no default
 * port, no credentials, no fragment, no tracking parameters, sorted query, normalized escapes, no
 * trailing slash (except the root path). Returns null for anything that is not an http(s) URL.
 */
export function canonicalizeUrl(input: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim(), base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  u.username = "";
  u.password = "";
  u.hash = "";
  // URL already lowercases scheme and host, drops default ports and resolves dot segments.
  let path = normalizeEscapes(u.pathname);
  if (path.length > 1 && path.endsWith("/")) path = path.replace(/\/+$/, "") || "/";
  const params = [...u.searchParams.entries()].filter(([k]) => !isTracking(k));
  params.sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1));
  const query = params.length
    ? "?" + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
    : "";
  return `${u.protocol}//${u.host}${path}${query}`;
}

/** sha256 hex of a canonical URL; the idempotency key of the `essay-urls` event. */
export function urlHash(canonicalUrl: string): string {
  return createHash("sha256").update(canonicalUrl).digest("hex");
}
