import { ProviderError, isRetryableStatus } from "./errors";
import { withRetries, type RetryOptions } from "./retry";
import {
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
  type ClassifyOptions,
  type ClassifyResult,
  type CompleteRequest,
  type CompleteResult,
  type ModelProvider,
  type UsageCallback,
  type UsageRecord,
} from "./types";

export interface DeepseekProviderOptions {
  /** The key, or a function that fetches it (e.g. from @kcw/secrets `kcw/prod/models`). */
  apiKey: string | (() => Promise<string>);
  /** OpenAI-compatible gateway root (the `/chat/completions` path is appended). Defaults to DEFAULT_DEEPSEEK_BASE_URL. */
  baseUrl?: string;
  /** Defaults to the pinned DEFAULT_DEEPSEEK_MODEL. */
  model?: string;
  maxTokens?: number;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  retry?: RetryOptions;
  onUsage?: UsageCallback;
}

const PROVIDER = "deepseek";
const CLASSIFY_TOOL = "record_label";

interface ChatMessage {
  content?: unknown;
  tool_calls?: { function?: { name?: unknown; arguments?: unknown } }[];
}
interface ChatResponse {
  model?: unknown;
  choices?: { message?: ChatMessage }[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

/**
 * DeepSeek V4.1 Flash through an OpenAI-compatible Chat Completions gateway, over plain fetch.
 * Errors carry the provider and HTTP status only; request and response bodies and the key are never
 * put into an error or a log.
 */
export class DeepseekProvider implements ModelProvider {
  readonly name = PROVIDER;
  readonly model: string;
  readonly #opts: DeepseekProviderOptions;

  constructor(opts: DeepseekProviderOptions) {
    this.#opts = opts;
    this.model = opts.model ?? DEFAULT_DEEPSEEK_MODEL;
  }

  async classify(input: string, labels: readonly string[], opts: ClassifyOptions = {}): Promise<ClassifyResult> {
    if (labels.length < 2) throw new Error("classify needs at least two labels");
    const system =
      "You classify a piece of text into exactly one of the given labels. " +
      "Report the label and your confidence from 0 to 1 by calling the tool." +
      (opts.instructions ? `\n\n${opts.instructions}` : "");
    const parameters = {
      type: "object",
      properties: {
        label: { type: "string", enum: [...labels] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["label", "confidence"],
    };
    const { message, model } = await this.#chat("classify", {
      max_tokens: this.#opts.maxTokens ?? 256,
      messages: [
        { role: "system", content: system },
        { role: "user", content: input },
      ],
      tools: [
        { type: "function", function: { name: CLASSIFY_TOOL, description: "Record the chosen label and confidence.", parameters } },
      ],
      tool_choice: { type: "function", function: { name: CLASSIFY_TOOL } },
    });
    const out = answerFrom(message);
    if (typeof out.label !== "string" || !labels.includes(out.label)) {
      throw new ProviderError("DeepSeek response: label is not one of the labels", { provider: PROVIDER, retryable: false });
    }
    const confidence = typeof out.confidence === "number" && Number.isFinite(out.confidence) ? Math.min(1, Math.max(0, out.confidence)) : 0;
    return { label: out.label, confidence, model, provider: PROVIDER };
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const { message, model } = await this.#chat("complete", {
      max_tokens: req.maxTokens ?? this.#opts.maxTokens ?? 1024,
      messages: [
        ...(req.system !== undefined ? [{ role: "system", content: req.system }] : []),
        { role: "user", content: req.prompt },
      ],
    });
    return { text: typeof message.content === "string" ? message.content : "", model, provider: PROVIDER };
  }

  async #chat(
    operation: UsageRecord["operation"],
    body: Record<string, unknown>,
  ): Promise<{ message: ChatMessage; model: string }> {
    const json = await withRetries(() => this.#post({ model: this.model, ...body }), this.#opts.retry);
    const model = typeof json.model === "string" && json.model.length > 0 ? json.model : this.model;
    const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
    await this.#opts.onUsage?.({
      provider: PROVIDER,
      model,
      operation,
      inputTokens: count(json.usage?.prompt_tokens),
      outputTokens: count(json.usage?.completion_tokens),
    });
    return { message: json.choices?.[0]?.message ?? {}, model };
  }

  async #post(body: Record<string, unknown>): Promise<ChatResponse> {
    const key = typeof this.#opts.apiKey === "string" ? this.#opts.apiKey : await this.#opts.apiKey();
    const doFetch = this.#opts.fetch ?? fetch;
    const url = `${(this.#opts.baseUrl ?? DEFAULT_DEEPSEEK_BASE_URL).replace(/\/+$/, "")}/chat/completions`;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#opts.timeoutMs ?? 60_000),
      });
    } catch (err) {
      throw new ProviderError("DeepSeek request failed (network or timeout)", { provider: PROVIDER, retryable: true, cause: err });
    }
    if (!res.ok) {
      const retryAfter = Number(res.headers.get("retry-after"));
      throw new ProviderError(`DeepSeek returned HTTP ${res.status}`, {
        provider: PROVIDER,
        status: res.status,
        retryable: isRetryableStatus(res.status) || res.status >= 500,
        ...(Number.isFinite(retryAfter) && retryAfter > 0 && { retryAfterSeconds: retryAfter }),
      });
    }
    try {
      const parsed: unknown = await res.json();
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
      return parsed as ChatResponse;
    } catch (err) {
      throw new ProviderError("DeepSeek returned invalid JSON", { provider: PROVIDER, retryable: false, cause: err });
    }
  }
}

/** The tool call's arguments, else a JSON object found in the message text (gateways that ignore tools). */
function answerFrom(message: ChatMessage): { label?: unknown; confidence?: unknown } {
  const args = message.tool_calls?.[0]?.function?.arguments;
  const fromTool = typeof args === "string" ? parseObject(args) : isObject(args) ? args : undefined;
  if (fromTool) return fromTool;
  if (typeof message.content === "string") {
    const start = message.content.indexOf("{");
    const end = message.content.lastIndexOf("}");
    if (start >= 0 && end > start) return parseObject(message.content.slice(start, end + 1)) ?? {};
  }
  return {};
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text);
    return isObject(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
