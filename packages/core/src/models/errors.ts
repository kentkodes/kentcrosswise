/**
 * A failed model call. Messages carry the provider and HTTP status only, never the
 * request or response body (those can contain private text).
 */
export class ProviderError extends Error {
  readonly provider: string;
  readonly status: number | undefined;
  readonly retryable: boolean;
  /** Seconds from a Retry-After header, if any. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    message: string,
    opts: { provider: string; status?: number; retryable?: boolean; retryAfterSeconds?: number; cause?: unknown },
  ) {
    super(message, { cause: opts.cause });
    this.name = "ProviderError";
    this.provider = opts.provider;
    this.status = opts.status;
    this.retryable = opts.retryable ?? (opts.status !== undefined && isRetryableStatus(opts.status));
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

/** 429 = rate limited, 529 = overloaded (Jev and Anthropic). Both are retried with backoff. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 529;
}
