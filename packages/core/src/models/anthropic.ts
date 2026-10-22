import Anthropic from "@anthropic-ai/sdk";
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages/messages";
import { ProviderError } from "./errors";
import {
  DEFAULT_ANTHROPIC_MODEL,
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
  onUsage?: UsageCallback;
}

const CLASSIFY_TOOL = "record_label";
const PROVIDER = "anthropic";

/**
 * Claude via the official SDK (which itself retries 429/529 with backoff).
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
    const msg = await this.#create("classify", {
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
    const block = msg.content.find((b) => b.type === "tool_use" && b.name === CLASSIFY_TOOL);
    const out = block && block.type === "tool_use" ? (block.input as { label?: unknown; confidence?: unknown }) : {};
    if (typeof out.label !== "string" || !labels.includes(out.label)) {
      throw new ProviderError("Anthropic response: label is not one of the labels", { provider: PROVIDER, retryable: false });
    }
    const confidence = typeof out.confidence === "number" ? Math.min(1, Math.max(0, out.confidence)) : 0;
    return { label: out.label, confidence, model: msg.model, provider: PROVIDER };
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const msg = await this.#create("complete", {
      model: this.model,
      max_tokens: req.maxTokens ?? this.#opts.maxTokens ?? 1024,
      ...(req.system !== undefined && { system: req.system }),
      messages: [{ role: "user", content: req.prompt }],
    });
    const text = msg.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    return { text, model: msg.model, provider: PROVIDER };
  }

  async #create(operation: UsageRecord["operation"], params: MessageCreateParamsNonStreaming): Promise<Message> {
    const client = await this.#getClient();
    let msg: Message;
    try {
      msg = await client.messages.create(params);
    } catch (err) {
      const status = err instanceof Anthropic.APIError ? err.status : undefined;
      throw new ProviderError(`Anthropic request failed${status ? ` (HTTP ${status})` : ""}`, {
        provider: PROVIDER,
        ...(status !== undefined && { status }),
        cause: err,
      });
    }
    await this.#opts.onUsage?.({
      provider: PROVIDER,
      model: msg.model,
      operation,
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
    });
    return msg;
  }

  async #getClient(): Promise<AnthropicLike> {
    if (this.#client) return this.#client;
    const key = this.#opts.apiKey;
    const apiKey = typeof key === "function" ? await key() : key;
    this.#client = new Anthropic({ apiKey });
    return this.#client;
  }
}
