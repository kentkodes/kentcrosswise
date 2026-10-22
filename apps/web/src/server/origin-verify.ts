// D25: the server Function URL is public (AuthType NONE), so every request must carry the secret
// header that only CloudFront adds. Checked in the OpenNext Lambda wrapper (./origin-wrapper),
// before routing, the ISR cache, route handlers and server actions.
import { createHash, timingSafeEqual } from "node:crypto";

export const ORIGIN_HEADER = "x-kcw-origin";

/** Env var naming where the expected value lives (D9: a name, never the value). */
export const ORIGIN_SECRET_ENV = "KCW_ORIGIN_VERIFY_SECRET";
/** Optional JSON key inside that secret; unset for SSM parameters, which hold the raw value. */
export const ORIGIN_KEY_ENV = "KCW_ORIGIN_VERIFY_KEY";

const MIN_LENGTH = 32;

export type Headers = Readonly<Record<string, string | undefined>> | null | undefined;

function headerValue(headers: Headers, name: string): string | undefined {
  if (!headers) return undefined;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return v;
  }
  return undefined;
}

/** Constant-time check of the origin header against the expected value. */
export function originHeaderMatches(headers: Headers, expected: string): boolean {
  if (expected.length < MIN_LENGTH) return false;
  const got = headerValue(headers, ORIGIN_HEADER);
  if (typeof got !== "string" || got === "") return false;
  const a = createHash("sha256").update(got).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export type GuardDecision = "allow" | "deny" | "unavailable";

export interface OriginGuardOptions {
  env: Readonly<Record<string, string | undefined>>;
  /** Reads a secret (name, optional key). @kcw/secrets in production, a fake in tests. */
  loadSecret: (name: string, key: string | undefined) => Promise<string>;
}

/**
 * Builds the per-request check. Without KCW_ORIGIN_VERIFY_SECRET the guard is off outside Lambda
 * (next dev/start) and fails closed inside Lambda (AWS_LAMBDA_FUNCTION_NAME is set).
 * The expected value is loaded once and cached; a failed load is retried on the next request.
 */
export function createOriginGuard(opts: OriginGuardOptions): (headers: Headers) => Promise<GuardDecision> {
  const name = opts.env[ORIGIN_SECRET_ENV];
  const key = opts.env[ORIGIN_KEY_ENV] || undefined;
  const inLambda = Boolean(opts.env.AWS_LAMBDA_FUNCTION_NAME);
  let expected: Promise<string> | undefined;

  return async (headers) => {
    if (!name) return inLambda ? "deny" : "allow";
    expected ??= opts.loadSecret(name, key);
    let value: string;
    try {
      value = await expected;
    } catch {
      expected = undefined;
      return "unavailable";
    }
    return originHeaderMatches(headers, value) ? "allow" : "deny";
  };
}

export interface LambdaUrlResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export function refusal(decision: Exclude<GuardDecision, "allow">): LambdaUrlResponse {
  return decision === "deny"
    ? { statusCode: 403, headers: { "content-type": "text/plain", "cache-control": "no-store" }, body: "Forbidden" }
    : { statusCode: 503, headers: { "content-type": "text/plain", "cache-control": "no-store" }, body: "Unavailable" };
}

type Handler = (event: unknown, ...rest: unknown[]) => Promise<unknown>;

/** Wraps a Lambda handler: requests without the right header never reach it. */
export function guardHandler(inner: Handler, guard: (headers: Headers) => Promise<GuardDecision>): Handler {
  return async (event, ...rest) => {
    const headers =
      typeof event === "object" && event !== null && "headers" in event ? (event.headers as Headers) : undefined;
    const decision = await guard(headers);
    if (decision !== "allow") {
      console.error(`[origin-verify] ${decision}`);
      return refusal(decision);
    }
    return inner(event, ...rest);
  };
}
