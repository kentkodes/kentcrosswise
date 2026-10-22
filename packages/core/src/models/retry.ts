import { ProviderError } from "./errors";

export interface RetryOptions {
  /** Retries after the first attempt (default 3, so up to 4 attempts). */
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** 0..1, injected for tests (jitter). */
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Delay before retry number `attempt` (1-based): exponential with jitter in [50%, 100%], at least Retry-After. */
export function backoffDelay(attempt: number, err: unknown, opts: RetryOptions = {}): number {
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 8000;
  const exp = Math.min(max, base * 2 ** (attempt - 1));
  const jittered = exp * (0.5 + 0.5 * (opts.random ?? Math.random)());
  const retryAfterMs =
    err instanceof ProviderError && err.retryAfterSeconds !== undefined ? err.retryAfterSeconds * 1000 : 0;
  return Math.round(Math.min(max, Math.max(jittered, retryAfterMs)));
}

/** Runs `fn`, retrying ProviderErrors marked retryable (429/529). Other errors propagate at once. */
export async function withRetries<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof ProviderError) || !err.retryable || attempt >= retries) throw err;
      await sleep(backoffDelay(attempt + 1, err, opts));
    }
  }
}
