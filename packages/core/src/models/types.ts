/** Default model ids (D13, research/apis.md §4). Override per node/provider via options. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-5-5";
/** Worker model (DeepSeek V4.1 Flash) on the first-party API: an alias, not a dated pin. Override with the optional `deepseek_model` secret key. */
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-flash";
/** First-party DeepSeek API (OpenAI-compatible); a gateway is selected with the optional `deepseek_base_url` secret key (plus `deepseek_model`). */
export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
/** Orchestrator planner (owner decision 2026-11-11): Opus 5.5 at high effort. */
export const DEFAULT_ORCHESTRATOR_MODEL = "claude-opus-5-5";
export const DEFAULT_ORCHESTRATOR_EFFORT = "high";

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
