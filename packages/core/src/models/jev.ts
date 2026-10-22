import { ProviderError } from "./errors";
import { JEV_ENDPOINT, JEV_PROVIDER, buildJevChoiceRequest, parseJevChoiceResponse } from "./jev-adapter";
import { withRetries, type RetryOptions } from "./retry";
import {
  DEFAULT_JEV_MODEL,
  type ClassifyOptions,
  type ClassifyResult,
  type CompleteResult,
  type ModelProvider,
  type UsageCallback,
} from "./types";

export interface JevProviderOptions {
  /** The key, or a function that fetches it (e.g. from @kcw/secrets `kcw/prod/models`). */
  apiKey: string | (() => Promise<string>);
  /** Defaults to the pinned DEFAULT_JEV_MODEL. */
  model?: string;
  endpoint?: string;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  retry?: RetryOptions;
  onUsage?: UsageCallback;
}

/**
 * Jev (TypeSafe AI) over plain HTTPS. We call the endpoint with fetch instead of
 * `@typesafe-ai/sdk` so the wire format stays in jev-adapter.ts and tests need no SDK.
 * Only `classify` is supported (choice questions).
 */
export class JevProvider implements ModelProvider {
  readonly name = JEV_PROVIDER;
  readonly model: string;
  readonly #opts: JevProviderOptions;

  constructor(opts: JevProviderOptions) {
    this.#opts = opts;
    this.model = opts.model ?? DEFAULT_JEV_MODEL;
  }

  async classify(input: string, labels: readonly string[], opts: ClassifyOptions = {}): Promise<ClassifyResult> {
    if (labels.length < 2) throw new Error("classify needs at least two labels");
    const body = buildJevChoiceRequest({
      model: this.model,
      text: input,
      labels,
      ...(opts.instructions !== undefined && { instructions: opts.instructions }),
    });
    const json = await withRetries(() => this.#post(body), this.#opts.retry);
    const answer = parseJevChoiceResponse(json, labels);
    await this.#opts.onUsage?.({
      provider: this.name,
      model: answer.model,
      operation: "classify",
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
    });
    return { label: answer.label, confidence: answer.confidence, model: answer.model, provider: this.name };
  }

  complete(): Promise<CompleteResult> {
    return Promise.reject(
      new ProviderError("Jev does not support free-text completion", { provider: this.name, retryable: false }),
    );
  }

  async #post(body: Record<string, unknown>): Promise<unknown> {
    const key = typeof this.#opts.apiKey === "string" ? this.#opts.apiKey : await this.#opts.apiKey();
    const doFetch = this.#opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(this.#opts.endpoint ?? JEV_ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#opts.timeoutMs ?? 30_000),
      });
    } catch (err) {
      // Network error or timeout: not retried here; withFallback moves on to the fallback.
      throw new ProviderError("Jev request failed (network or timeout)", { provider: this.name, cause: err });
    }
    if (!res.ok) {
      const retryAfter = Number(res.headers.get("retry-after"));
      throw new ProviderError(`Jev returned HTTP ${res.status}`, {
        provider: this.name,
        status: res.status,
        ...(Number.isFinite(retryAfter) && retryAfter > 0 && { retryAfterSeconds: retryAfter }),
      });
    }
    try {
      return await res.json();
    } catch (err) {
      throw new ProviderError("Jev returned invalid JSON", { provider: this.name, retryable: false, cause: err });
    }
  }
}
