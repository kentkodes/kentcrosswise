// One-line error descriptions for the sweeper's logs: the error class, HTTP status if any, the
// message, and the same for up to two causes. A GitHubApiError's own message only names the
// operation (P2-09); the cause says why (e.g. the JWT library refusing the key, a fetch failure).
// Messages are shortened and anything that looks like a credential is redacted, so a library
// that echoes a token, JWT, key or connection string cannot put it in CloudWatch.

const MAX_MESSAGE = 160;
const MAX_DEPTH = 3;

const REDACTIONS: [RegExp, string][] = [
  [/-----BEGIN [^-]*-----[\s\S]*?(?:-----END [^-]*-----|$)/g, "<pem>"],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, "<jwt>"],
  [/\bgh[opsur]_[A-Za-z0-9_]{8,}/g, "<token>"],
  [/\b(bearer|token)\s+[\w.-]{8,}/gi, "$1 <redacted>"],
  [/:\/\/[^\s/@]+@/g, "://<redacted>@"],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, by] of REDACTIONS) out = out.replace(re, by);
  out = out.replace(/\s+/g, " ").trim();
  return out.length > MAX_MESSAGE ? `${out.slice(0, MAX_MESSAGE)}...` : out;
}

function one(err: unknown): string {
  if (!(err instanceof Error)) return typeof err;
  const status = "status" in err && typeof err.status === "number" ? ` ${err.status}` : "";
  const code = "code" in err && typeof err.code === "string" ? ` [${redact(err.code)}]` : "";
  const message = err.message ? `: ${redact(err.message)}` : "";
  return `${err.name}${status}${code}${message}`;
}

/** `GitHubApiError: listDeliveries failed <- Error [ERR_OSSL_UNSUPPORTED]: error:1E08010C:DECODER routines::unsupported` */
export function describeError(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < MAX_DEPTH && cur !== undefined && cur !== null; i++) {
    parts.push(one(cur));
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return parts.join(" <- ");
}
