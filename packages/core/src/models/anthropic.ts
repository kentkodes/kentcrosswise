import Anthropic from "@anthropic-ai/sdk";
import type { Message, MessageCreateParamsNonStreaming, OutputConfig } from "@anthropic-ai/sdk/resources/messages/messages";
import { ProviderError } from "./errors";
import { checkCallTag } from "./ledger";
import { withRetries, type RetryOptions } from "./retry";
import {
  DEFAULT_ANTHROPIC_MODEL,
  type CallCallback,
  type CallTag,
  type ClassifyOptions,
  type ClassifyResult,
  type CompleteRequest,
  type CompleteResult,
  type ModelProvider,
  type UsageCallback,
  type UsageRecord,
} from "./types";

/** The part of the Anthropic SDK client we use. Inject a fake in tests. */
export interface AnthropicLike {
  messages: { create(params: MessageCreateParamsNonStreaming): PromiseLike<Message> };
}

export interface AnthropicProviderOptions {
  /** A ready client (tests), or an apiKey used to build one. */
  client?: AnthropicLike;
  apiKey?: string | (() => Promise<string>);
  model?: string;
  maxTokens?: number;
  /** Sent as output_config.effort (SDK 1.x typed field), e.g. "high" for Opus 5.5. Omitted when unset. */
  effort?: NonNullable<OutputConfig["effort"]>;
  /** Legacy: successful responses only. Prefer `onCall`. */
  onUsage?: UsageCallback;
  /** Every request (each retry attempt): a start before it is sent, an end after it (AR3 call records). */
  onCall?: CallCallback;
  /**
   * Retries of 408, 409, 429, 5xx and connection errors, done here (the SDK client is built with
   * maxRetries 0) so each attempt is its own call record. Default 2 retries, like the SDK's.
   */
  retry?: RetryOptions;
}

const CLASSIFY_TOOL = "record_label";
const PROVIDER = "anthropic";

/**
 * Claude via the official SDK. Retries (408, 409, 429, 5xx, connection errors) are made here, not by the
 * SDK, so each attempt is reported to `onCall` as its own call.
 * Keep prompts under 100K tokens: Haiku 5.5 has a price cliff above that.
 */
export class AnthropicProvider implements ModelProvider {
  readonly name = PROVIDER;
  readonly model: string;
  readonly #opts: AnthropicProviderOptions;
  #client: AnthropicLike | undefined;

  constructor(opts: AnthropicProviderOptions) {
    if (!opts.client && opts.apiKey === undefined) throw new Error("AnthropicProvider needs a client or an apiKey");
    this.#opts = opts;
    this.#client = opts.client;
    this.model = opts.model ?? DEFAULT_ANTHROPIC_MODEL;
  }

  async classify(input: string, labels: readonly string[], opts: ClassifyOptions = {}): Promise<ClassifyResult> {
    if (labels.length < 2) throw new Error("classify needs at least two labels");
    const msg = await this.#create("classify", opts.call, {
      model: this.model,
      max_tokens: this.#opts.maxTokens ?? 256,
      system:
        "You classify a piece of text into exactly one of the given labels. " +
        "Report the label and your confidence from 0 to 1 by calling the tool." +
        (opts.instructions ? `\n\n${opts.instructions}` : ""),
      messages: [{ role: "user", content: input }],
      tools: [
        {
          name: CLASSIFY_TOOL,
          description: "Record the chosen label and confidence.",
          input_schema: {
            type: "object",
            properties: {
              label: { type: "string", enum: [...labels] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
            },
            required: ["label", "confidence"],
          },
        },
      ],
      tool_choice: { type: "tool", name: CLASSIFY_TOOL },
    });
    if (msg.stop_reason === "max_tokens" || msg.stop_reason === "refusal") {
      throw new ProviderError(`Anthropic response stopped: ${msg.stop_reason}`, { provider: PROVIDER, retryable: false });
    }
    const block = msg.content.find((b) => b.type === "tool_use" && b.name === CLASSIFY_TOOL);
    const out = block && block.type === "tool_use" ? (block.input as { label?: unknown; confidence?: unknown }) : {};
    if (typeof out.label !== "string" || !labels.includes(out.label)) {
      throw new ProviderError("Anthropic response: label is not one of the labels", { provider: PROVIDER, retryable: false });
    }
    const confidence = typeof out.confidence === "number" ? Math.min(1, Math.max(0, out.confidence)) : 0;
    return { label: out.label, confidence, model: msg.model, provider: PROVIDER };
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const msg = await this.#create("complete", req.call, {
      model: this.model,
      max_tokens: req.maxTokens ?? this.#opts.maxTokens ?? 1024,
      ...(req.system !== undefined && { system: req.system }),
      messages: [{ role: "user", content: req.prompt }],
    });
    const text = msg.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    const stop = msg.stop_reason === "max_tokens" ? "max_tokens" : msg.stop_reason === "refusal" ? "refusal" : "end";
    return { text, stop, model: msg.model, provider: PROVIDER };
  }

  async #create(operation: UsageRecord["operation"], tag: CallTag | undefined, params: MessageCreateParamsNonStreaming): Promise<Message> {
    checkCallTag(tag);
    const client = await this.#getClient();
    const msg = await withRetries(() => this.#attempt(client, operation, tag, params), { retries: 2, ...this.#opts.retry });
    await this.#opts.onUsage?.({
      provider: PROVIDER,
      model: msg.model,
      operation,
      inputTokens: msg.usage?.input_tokens ?? 0,
      outputTokens: msg.usage?.output_tokens ?? 0,
    });
    return msg;
  }

  /** One request, recorded as one call: start before sending, end with usage, unknown or rejected. */
  async #attempt(
    client: AnthropicLike,
    operation: UsageRecord["operation"],
    tag: CallTag | undefined,
    params: MessageCreateParamsNonStreaming,
  ): Promise<Message> {
    const onCall = this.#opts.onCall;
    const base = { callId: globalThis.crypto.randomUUID(), provider: PROVIDER, operation, ...(tag && { tag }) };
    await onCall?.({ ...base, phase: "start", model: this.model });
    let msg: Message;
    try {
      msg = await client.messages.create(
        this.#opts.effort ? { ...params, output_config: { effort: this.#opts.effort } } : params,
      );
    } catch (err) {
      const status = err instanceof Anthropic.APIError ? err.status : undefined;
      // A 4xx was refused before any work (not billed); a 5xx, a timeout or a lost connection may have been processed.
      // A 408 (request timeout) may have been processed, so it is unknown like a 5xx; other 4xx were refused.
      const outcome = status !== undefined && status < 500 && status !== 408 ? "rejected" : "unknown";
      await onCall?.({ ...base, phase: "end", model: this.model, outcome, inputTokens: null, outputTokens: null });
      const connection = err instanceof Anthropic.APIConnectionError;
      const retryAfter = err instanceof Anthropic.APIError ? Number(err.headers?.get?.("retry-after")) : NaN;
      throw new ProviderError(`Anthropic request failed${status ? ` (HTTP ${status})` : ""}`, {
        provider: PROVIDER,
        ...(status !== undefined && { status }),
        retryable: connection || (status !== undefined && (status === 408 || status === 409 || status === 429 || status >= 500)),
        ...(Number.isFinite(retryAfter) && retryAfter > 0 && { retryAfterSeconds: retryAfter }),
        cause: err,
      });
    }
    const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
    const inputTokens = count(msg.usage?.input_tokens);
    const outputTokens = count(msg.usage?.output_tokens);
    await onCall?.({
      ...base,
      phase: "end",
      model: typeof msg.model === "string" && msg.model.length > 0 ? msg.model : this.model,
      outcome: inputTokens !== null && outputTokens !== null ? "reported" : "unknown",
      inputTokens,
      outputTokens,
    });
    return msg;
  }

  async #getClient(): Promise<AnthropicLike> {
    if (this.#client) return this.#client;
    const key = this.#opts.apiKey;
    const apiKey = typeof key === "function" ? await key() : key;
    this.#client = new Anthropic({ apiKey, maxRetries: 0 });
    return this.#client;
  }
}
