import type {
  ClassifyOptions,
  ClassifyResult,
  CompleteRequest,
  CompleteResult,
  ModelProvider,
  UsageCallback,
} from "./types";

type ClassifyAnswer = { label: string; confidence: number; model?: string };
type CompleteAnswer = { text: string; model?: string };
type Scripted<T, A extends unknown[]> = T | Error | ((...args: A) => T | Error | Promise<T | Error>);

export interface FakeProviderOptions {
  name?: string;
  model?: string;
  /** Answer for every call, an Error to throw, or a function of the input. */
  classify?: Scripted<ClassifyAnswer, [input: string, labels: readonly string[]]>;
  complete?: Scripted<CompleteAnswer, [req: CompleteRequest]>;
  onUsage?: UsageCallback;
}

/** Deterministic provider for tests. Records every call in `calls`. */
export class FakeProvider implements ModelProvider {
  readonly name: string;
  readonly model: string;
  readonly calls: { op: "classify" | "complete"; input: string; labels?: readonly string[] }[] = [];
  readonly #opts: FakeProviderOptions;

  constructor(opts: FakeProviderOptions = {}) {
    this.#opts = opts;
    this.name = opts.name ?? "fake";
    this.model = opts.model ?? "fake-model-1";
  }

  async classify(input: string, labels: readonly string[], _opts?: ClassifyOptions): Promise<ClassifyResult> {
    this.calls.push({ op: "classify", input, labels });
    const spec = this.#opts.classify ?? { label: labels[0] ?? "", confidence: 1 };
    const answer = typeof spec === "function" ? await spec(input, labels) : spec;
    if (answer instanceof Error) throw answer;
    const model = answer.model ?? this.model;
    await this.#opts.onUsage?.({ provider: this.name, model, operation: "classify", inputTokens: input.length, outputTokens: 0 });
    return { label: answer.label, confidence: answer.confidence, model, provider: this.name };
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    this.calls.push({ op: "complete", input: req.prompt });
    const spec = this.#opts.complete ?? { text: "" };
    const answer = typeof spec === "function" ? await spec(req) : spec;
    if (answer instanceof Error) throw answer;
    const model = answer.model ?? this.model;
    await this.#opts.onUsage?.({
      provider: this.name,
      model,
      operation: "complete",
      inputTokens: req.prompt.length,
      outputTokens: answer.text.length,
    });
    return { text: answer.text, model, provider: this.name };
  }
}
