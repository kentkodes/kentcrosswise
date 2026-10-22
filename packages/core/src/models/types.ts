/** Default model ids (D13, research/apis.md §4-§5). Override per node/provider via options. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-5-5";
/** Pinned, not `jev-latest`: upgrades are deliberate, after replaying stored route_corrections. */
export const DEFAULT_JEV_MODEL = "jev-1.13.0";

export interface ClassifyOptions {
  /** Extra guidance for the model, e.g. what each label means. */
  instructions?: string;
}

export interface ClassifyResult {
  label: string;
  /** 0..1 */
  confidence: number;
  /** Model id as returned by the provider (not the requested one). */
  model: string;
  provider: string;
  /** Set when withFallback answered with the fallback provider. */
  fallback?: FallbackInfo;
}

export interface FallbackInfo {
  from: string;
  reason: "low_confidence" | "error";
  /** Primary's answer when reason = low_confidence. */
  primaryLabel?: string;
  primaryConfidence?: number;
  primaryModel?: string;
}

export interface CompleteRequest {
  prompt: string;
  system?: string;
  maxTokens?: number;
}

export interface CompleteResult {
  text: string;
  model: string;
  provider: string;
  fallback?: FallbackInfo;
}

export interface ModelProvider {
  readonly name: string;
  classify(input: string, labels: readonly string[], opts?: ClassifyOptions): Promise<ClassifyResult>;
  complete(req: CompleteRequest): Promise<CompleteResult>;
}

/** One model call, reported so the caller can write a usage_events row. */
export interface UsageRecord {
  provider: string;
  /** Model id returned by the provider. */
  model: string;
  operation: "classify" | "complete";
  inputTokens: number;
  outputTokens: number;
}

export type UsageCallback = (usage: UsageRecord) => void | Promise<void>;
