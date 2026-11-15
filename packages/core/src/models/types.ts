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
  /** What the call is for and what it belongs to; passed to the call record (AR3). */
  call?: CallTag;
}

/**
 * What a model call is for and what it belongs to, by id only (never text). Passed through to the
 * provider's `onCall` events and stored on the usage_events call record (migration 0019).
 */
export interface CallTag {
  /** An open lowercase word: plan, work, review, route, mood, categorize, hook, ... */
  purpose?: string;
  taskId?: number;
  /** E.g. {kind: "entry" | "diary_entry" | "essay", id: <uuid>}. */
  subject?: { kind: string; id: string };
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
  /** What the call is for and what it belongs to; passed to the call record (AR3). */
  call?: CallTag;
}

export interface CompleteResult {
  text: string;
  /** Why the reply ended: "max_tokens" or "refusal" means the text is cut off or withheld. */
  stop: "end" | "max_tokens" | "refusal";
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

/**
 * Legacy usage callback: called after a successful response only, with missing counts as 0. New
 * callers use `onCall` (CallEvent), which records every request, including failed and unknown ones.
 */
export type UsageCallback = (usage: UsageRecord) => void | Promise<void>;

/**
 * End of a provider request: `reported` (both token counts came back), `unknown` (the request was
 * sent and may be billed, but no usage came back; tokens null, never 0) or `rejected` (the provider
 * answered with a 4xx status: not billed).
 */
export type CallOutcome = "reported" | "unknown" | "rejected";

interface CallBase {
  /** Random id drawn for each HTTP request (each retry attempt is its own call). */
  callId: string;
  provider: string;
  operation: UsageRecord["operation"];
  tag?: CallTag;
}

/** Emitted right before a request is sent. `model` is the requested model. */
export interface CallStart extends CallBase {
  phase: "start";
  model: string;
}

/** Emitted after the request ended, before the answer is validated. `model` is the returned id when there is one. */
export interface CallEnd extends CallBase {
  phase: "end";
  model: string;
  outcome: CallOutcome;
  inputTokens: number | null;
  outputTokens: number | null;
}

export type CallEvent = CallStart | CallEnd;

/**
 * Receives every call event. A start that throws stops the call before it is sent; an end that
 * throws fails the call (its started record then reads as unknown).
 */
export type CallCallback = (event: CallEvent) => void | Promise<void>;
