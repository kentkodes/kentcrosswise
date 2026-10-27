import { canonicalizeUrl } from "./canonical";
import { BOT_USER_AGENT } from "./bot-contact";
import type { RobotsFetch } from "./robots";

/** Default request identity; its public contact page is published and verified. */
export const DEFAULT_USER_AGENT = BOT_USER_AGENT;

/** Reason codes; they double as `sources.health_reason` values and never carry page content. */
export type HttpFailure =
  | "network_error"
  | "timeout"
  | "http_429"
  | "http_5xx"
  | "http_4xx"
  | "blocked_401"
  | "blocked_403"
  | "login_redirect"
  | "bad_redirect"
  | "too_many_redirects"
  | "too_large"
  | "guard_refused";

export type HttpResult =
  | {
      ok: true;
      status: number;
      /** Final URL after redirects. */
      url: string;
      /** Response headers without Set-Cookie. */
      headers: Record<string, string>;
      body: string;
      attempts: number;
    }
  | {
      ok: false;
      reason: HttpFailure;
      status?: number;
      attempts: number;
      /** From a Retry-After header, so the caller can push the rate lease out. */
      retryAfterMs?: number;
      /** For `guard_refused`: the guard's own reason. */
      detail?: string;
    };

export type GuardDecision = { ok: true } | { ok: false; reason: string };

export interface HttpClientOptions {
  userAgent?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** In [0, 1); jitter source. */
  random?: () => number;
  /** In-run retries after the first attempt (design: 3, waiting about 2, 4, 8 s). */
  maxRetries?: number;
  baseDelayMs?: number;
  /** A Retry-After longer than this is not waited for in-run: the request fails with `retryAfterMs`. */
  maxRetryAfterMs?: number;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxRedirects?: number;
  /**
   * Called before every request, redirect hops and retries included. Wire robots (`isAllowed`) and the
   * rate lease (`claimFetchSlot`) here so no request can skip them.
   */
  guard?: (url: string) => Promise<GuardDecision>;
}

const LOGIN_HOST = /^(login|signin|sso|auth|accounts|id|secure)\./i;
const LOGIN_PATH = /(^|\/)(log-?in|sign-?in|signon|sso|oauth2?|authorize|account\/login|special:userlogin)(\/|$|\.)/i;

/** Heuristic for a login wall: we never follow a redirect into one. */
export function looksLikeLoginUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return LOGIN_HOST.test(u.hostname) || LOGIN_PATH.test(decodeURIComponent(u.pathname));
  } catch {
    return false;
  }
}

function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

async function readCapped(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel();
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * A polite GET client: one User-Agent on every request, no cookies or credentials ever, redirects
 * followed by hand (never into a login page), exponential backoff with jitter on network errors, 429
 * and 5xx, no retry on other 4xx, and a hard stop on 401/403.
 */
export function createHttpClient(opts: HttpClientOptions = {}) {
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 2000;
  const maxRetryAfterMs = opts.maxRetryAfterMs ?? 60_000;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxBodyBytes = opts.maxBodyBytes ?? 5 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 5;

  async function get(startUrl: string, conditional?: { ifNoneMatch?: string }): Promise<HttpResult> {
    let url = canonicalizeUrl(startUrl);
    if (!url) return { ok: false, reason: "bad_redirect", attempts: 0 };
    let attempts = 0;
    let hops = 0;
    let retries = 0;
    for (;;) {
      const verdict = opts.guard ? await opts.guard(url) : ({ ok: true } as const);
      if (!verdict.ok) return { ok: false, reason: "guard_refused", attempts, detail: verdict.reason };
      attempts += 1;

      let res: Response;
      try {
        res = await doFetch(url, {
          method: "GET",
          headers: { "user-agent": userAgent, accept: "text/html,text/plain,application/json,application/xml;q=0.9,*/*;q=0.5",
            ...(conditional?.ifNoneMatch && { "if-none-match": conditional.ifNoneMatch }) },
          redirect: "manual",
          credentials: "omit",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        if (retries < maxRetries) {
          await sleep(backoff(retries++));
          continue;
        }
        return { ok: false, reason: timedOut ? "timeout" : "network_error", attempts };
      }

      const status = res.status;
      if (status >= 300 && status < 400 && res.headers.has("location")) {
        await res.body?.cancel();
        const next = canonicalizeUrl(res.headers.get("location") ?? "", url);
        if (!next) return { ok: false, reason: "bad_redirect", status, attempts };
        if (looksLikeLoginUrl(next)) return { ok: false, reason: "login_redirect", status, attempts };
        if (++hops > maxRedirects) return { ok: false, reason: "too_many_redirects", status, attempts };
        url = next;
        continue;
      }
      if (status === 401 || status === 403) {
        await res.body?.cancel();
        return { ok: false, reason: status === 401 ? "blocked_401" : "blocked_403", status, attempts };
      }
      if (status === 429 || status >= 500) {
        await res.body?.cancel();
        const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), Date.now());
        const reason = status === 429 ? "http_429" : "http_5xx";
        const waitMs = Math.max(backoff(retries), retryAfterMs ?? 0);
        if (retries < maxRetries && (retryAfterMs ?? 0) <= maxRetryAfterMs) {
          retries += 1;
          await sleep(waitMs);
          continue;
        }
        return { ok: false, reason, status, attempts, ...(retryAfterMs !== undefined && { retryAfterMs }) };
      }
      if (status >= 400) {
        await res.body?.cancel();
        return { ok: false, reason: "http_4xx", status, attempts };
      }

      const body = await readCapped(res, maxBodyBytes);
      if (body === null) return { ok: false, reason: "too_large", status, attempts };
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        if (k.toLowerCase() !== "set-cookie") headers[k.toLowerCase()] = v;
      });
      return { ok: true, status, url, headers, body, attempts };
    }
  }

  /** 2, 4, 8 s ... plus up to 25% jitter. */
  function backoff(retry: number): number {
    const base = baseDelayMs * 2 ** retry;
    return Math.round(base + random() * base * 0.25);
  }

  return { get, userAgent };
}

export type HttpClient = ReturnType<typeof createHttpClient>;

/** Fetches `<origin>/robots.txt` through the polite client and maps the outcome for `interpretRobots`. */
export async function fetchRobotsTxt(client: HttpClient, origin: string): Promise<RobotsFetch> {
  const res = await client.get(`${origin}/robots.txt`);
  if (res.ok) return { kind: "response", status: res.status, body: res.body };
  if (res.status !== undefined && !res.reason.endsWith("redirect")) return { kind: "response", status: res.status, body: "" };
  return { kind: "error", reason: res.reason };
}
