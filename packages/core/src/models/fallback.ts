import type { ClassifyOptions, ClassifyResult, CompleteRequest, CompleteResult, FallbackInfo, ModelProvider } from "./types";

export interface FallbackOptions {
  /** Use the fallback when the primary's confidence is below this (0..1). */
  threshold: number;
  /** Called when the fallback is used (logging/metrics). Errors are passed without bodies. */
  onFallback?: (info: FallbackInfo, error?: unknown) => void;
}

/**
 * Primary first (e.g. Jev, which already retried 429/529 with backoff); the fallback
 * (e.g. Haiku) when the primary errors or its confidence is below the threshold.
 * If the fallback also fails, its error propagates.
 */
export function withFallback(primary: ModelProvider, fallback: ModelProvider, opts: FallbackOptions): ModelProvider {
  if (!(opts.threshold >= 0 && opts.threshold <= 1)) throw new Error("threshold must be within 0..1");
  return {
    name: `${primary.name}+${fallback.name}`,

    async classify(input: string, labels: readonly string[], copts?: ClassifyOptions): Promise<ClassifyResult> {
      let info: FallbackInfo;
      try {
        const first = await primary.classify(input, labels, copts);
        if (first.confidence >= opts.threshold) return first;
        info = {
          from: primary.name,
          reason: "low_confidence",
          primaryLabel: first.label,
          primaryConfidence: first.confidence,
          primaryModel: first.model,
        };
        opts.onFallback?.(info);
      } catch (err) {
        info = { from: primary.name, reason: "error" };
        opts.onFallback?.(info, err);
      }
      const second = await fallback.classify(input, labels, copts);
      return { ...second, fallback: info };
    },

    async complete(req: CompleteRequest): Promise<CompleteResult> {
      try {
        return await primary.complete(req);
      } catch (err) {
        const info: FallbackInfo = { from: primary.name, reason: "error" };
        opts.onFallback?.(info, err);
        return { ...(await fallback.complete(req)), fallback: info };
      }
    },
  };
}
