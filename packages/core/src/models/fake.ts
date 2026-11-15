import { checkCallTag } from "./ledger";
import type {
  CallCallback,
  CallTag,
  ClassifyOptions,
  ClassifyResult,
  CompleteRequest,
  CompleteResult,
  ModelProvider,
  UsageCallback,
} from "./types";

/** Scripted usage of one answer: both counts by default (input/output text lengths); null = not reported. */
type Tokens = { input: number | null; output: number | null };
type ClassifyAnswer = { label: string; confidence: number; model?: string; tokens?: Tokens };
type CompleteAnswer = { text: string; stop?: CompleteResult["stop"]; model?: string; tokens?: Tokens };
type Scripted<T, A extends unknown[]> = T | Error | ((...args: A) => T | Error | Promise<T | Error>);

export interface FakeProviderOptions {
  name?: string;
  model?: string;
  /** Answer for every call, an Error to throw, or a function of the input. */
  classify?: Scripted<ClassifyAnswer, [input: string, labels: readonly string[]]>;
  complete?: Scripted<CompleteAnswer, [req: CompleteRequest]>;
  onUsage?: UsageCallback;
  /** Call events like a real adapter: a start, then an end (an Error answer ends `unknown` with null tokens). */
  onCall?: CallCallback;
}

/** Deterministic provider for tests. Records every call in `calls`. */
export class FakeProvider implements ModelProvider {
  readonly name: string;
  readonly model: string;
  readonly calls: { op: "classify" | "complete"; input: string; labels?: readonly string[]; tag?: CallTag }[] = [];
  readonly #opts: FakeProviderOptions;

  constructor(opts: FakeProviderOptions = {}) {
    this.#opts = opts;
    this.name = opts.name ?? "fake";
    this.model = opts.model ?? "fake-model-1";
  }

  async #run<T extends { model?: string; tokens?: Tokens }>(
    operation: "classify" | "complete",
    tag: CallTag | undefined,
    answer: () => Promise<T | Error>,
    defaults: (a: T) => [number, number],
  ): Promise<{ a: T; model: string; tokens: [number, number] }> {
    checkCallTag(tag);
    const base = { callId: globalThis.crypto.randomUUID(), provider: this.name, operation, ...(tag && { tag }) };
    await this.#opts.onCall?.({ ...base, phase: "start", model: this.model });
    const a = await answer().catch((err: unknown) => (err instanceof Error ? err : new Error("fake answer failed")));
    if (a instanceof Error) {
      await this.#opts.onCall?.({ ...base, phase: "end", model: this.model, outcome: "unknown", inputTokens: null, outputTokens: null });
      throw a;
    }
    const model = a.model ?? this.model;
    const [di, dout] = defaults(a);
    const input = a.tokens ? a.tokens.input : di;
    const output = a.tokens ? a.tokens.output : dout;
    await this.#opts.onCall?.({
      ...base,
      phase: "end",
      model,
      outcome: input !== null && output !== null ? "reported" : "unknown",
      inputTokens: input,
      outputTokens: output,
    });
    return { a, model, tokens: [input ?? 0, output ?? 0] };
  }

  async classify(input: string, labels: readonly string[], opts?: ClassifyOptions): Promise<ClassifyResult> {
    this.calls.push({ op: "classify", input, labels, ...(opts?.call && { tag: opts.call }) });
    const spec = this.#opts.classify ?? { label: labels[0] ?? "", confidence: 1 };
    const { a, model, tokens } = await this.#run(
      "classify",
      opts?.call,
      async () => (typeof spec === "function" ? await spec(input, labels) : spec),
      () => [input.length, 0],
    );
    await this.#opts.onUsage?.({ provider: this.name, model, operation: "classify", inputTokens: tokens[0], outputTokens: tokens[1] });
    return { label: a.label, confidence: a.confidence, model, provider: this.name };
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    this.calls.push({ op: "complete", input: req.prompt, ...(req.call && { tag: req.call }) });
    const spec = this.#opts.complete ?? { text: "" };
    const { a, model, tokens } = await this.#run(
      "complete",
      req.call,
      async () => (typeof spec === "function" ? await spec(req) : spec),
      (x) => [req.prompt.length, x.text.length],
    );
    await this.#opts.onUsage?.({ provider: this.name, model, operation: "complete", inputTokens: tokens[0], outputTokens: tokens[1] });
    return { text: a.text, stop: a.stop ?? "end", model, provider: this.name };
  }
}
