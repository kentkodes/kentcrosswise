import type { Message } from "@anthropic-ai/sdk/resources/messages/messages";
import { describe, expect, it, vi } from "vitest";
import {
  AnthropicProvider,
  DEFAULT_JEV_MODEL,
  FakeProvider,
  JEV_ENDPOINT,
  JevProvider,
  ProviderError,
  backoffDelay,
  type buildJevChoiceRequest,
  withFallback,
  type AnthropicLike,
  type UsageRecord,
} from "../src/models/index";

const LABELS = ["crm_note", "diary", "todo", "idea", "agent_request"] as const;
const TEXT = "Buy milk tomorrow"; // synthetic

function jevBody(choice: string, confidence: number, model = "jev-1.13.0") {
  return {
    model,
    answers: { label: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } } },
    usage: { input_tokens: 12, output_tokens: 0 },
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** fetch fake that returns the queued responses in order. */
function fetchQueue(...responses: Response[]) {
  const fn = vi.fn<typeof fetch>(async () => {
    const next = responses.shift();
    if (!next) throw new Error("fetch queue empty");
    return next;
  });
  return fn;
}

const noSleep = { sleep: vi.fn(async (_ms: number) => {}), random: () => 1, baseDelayMs: 100 };

function haikuFake(usage?: (u: UsageRecord) => void) {
  return new FakeProvider({
    name: "anthropic",
    model: "claude-haiku-5-5-20261001",
    classify: { label: "todo", confidence: 0.9 },
    ...(usage && { onUsage: usage }),
  });
}

describe("JevProvider", () => {
  it("sends the pinned model, bearer key and a choice question; returns the answer", async () => {
    const fetch = fetchQueue(json(200, jevBody("todo", 0.93)));
    const usage: UsageRecord[] = [];
    const jev = new JevProvider({ apiKey: async () => "fake-key", fetch, onUsage: (u) => void usage.push(u) });
    const out = await jev.classify(TEXT, LABELS);
    expect(out).toEqual({ label: "todo", confidence: 0.93, model: "jev-1.13.0", provider: "jev" });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(JEV_ENDPOINT);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fake-key");
    const sent = JSON.parse(String(init?.body)) as ReturnType<typeof buildJevChoiceRequest>;
    expect(sent.model).toBe(DEFAULT_JEV_MODEL);
    expect(sent.state).toBe(TEXT);
    expect(usage).toEqual([
      { provider: "jev", model: "jev-1.13.0", operation: "classify", inputTokens: 12, outputTokens: 0 },
    ]);
  });

  it("uses the model from config", async () => {
    const fetch = fetchQueue(json(200, jevBody("idea", 0.8, "jev-1.14.0")));
    await new JevProvider({ apiKey: "k", model: "jev-1.14.0", fetch }).classify(TEXT, LABELS);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body)).model).toBe("jev-1.14.0");
  });

  it("retries 429/529 with backoff, then succeeds", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetch = fetchQueue(json(429, {}), json(529, {}), json(200, jevBody("todo", 0.9)));
    const jev = new JevProvider({ apiKey: "k", fetch, retry: { sleep, random: () => 1, baseDelayMs: 100 } });
    expect((await jev.classify(TEXT, LABELS)).label).toBe("todo");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
  });

  it("does not retry other errors", async () => {
    const fetch = fetchQueue(json(400, { error: "bad" }));
    const jev = new JevProvider({ apiKey: "k", fetch, retry: noSleep });
    await expect(jev.classify(TEXT, LABELS)).rejects.toMatchObject({ status: 400, retryable: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a choice that is not one of the labels", async () => {
    const jev = new JevProvider({ apiKey: "k", fetch: fetchQueue(json(200, jevBody("shopping", 0.9))) });
    await expect(jev.classify(TEXT, LABELS)).rejects.toBeInstanceOf(ProviderError);
  });

  it("error messages do not contain the input text", async () => {
    const jev = new JevProvider({ apiKey: "k", fetch: fetchQueue(json(400, { echo: TEXT })), retry: noSleep });
    const err = (await jev.classify(TEXT, LABELS).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(TEXT);
  });
});

describe("backoffDelay", () => {
  it("is exponential, capped, and honours Retry-After", () => {
    expect(backoffDelay(1, null, { random: () => 1 })).toBe(500);
    expect(backoffDelay(3, null, { random: () => 1 })).toBe(2000);
    expect(backoffDelay(10, null, { random: () => 1 })).toBe(8000);
    expect(backoffDelay(1, null, { random: () => 0 })).toBe(250);
    const err = new ProviderError("x", { provider: "jev", status: 429, retryAfterSeconds: 3 });
    expect(backoffDelay(1, err, { random: () => 1 })).toBe(3000);
  });
});

describe("withFallback", () => {
  it("keeps the primary answer at or above the threshold", async () => {
    const primary = new FakeProvider({ name: "jev", classify: { label: "diary", confidence: 0.7 } });
    const fallback = haikuFake();
    const out = await withFallback(primary, fallback, { threshold: 0.7 }).classify(TEXT, LABELS);
    expect(out).toMatchObject({ label: "diary", provider: "jev" });
    expect(out.fallback).toBeUndefined();
    expect(fallback.calls).toHaveLength(0);
  });

  it("falls back on low confidence and records the primary's answer", async () => {
    const primary = new FakeProvider({ name: "jev", model: "jev-1.13.0", classify: { label: "diary", confidence: 0.4 } });
    const onFallback = vi.fn();
    const out = await withFallback(primary, haikuFake(), { threshold: 0.7, onFallback }).classify(TEXT, LABELS);
    expect(out).toMatchObject({
      label: "todo",
      provider: "anthropic",
      fallback: { from: "jev", reason: "low_confidence", primaryLabel: "diary", primaryConfidence: 0.4, primaryModel: "jev-1.13.0" },
    });
    expect(onFallback).toHaveBeenCalledOnce();
  });

  it("falls back on a primary error", async () => {
    const primary = new FakeProvider({ name: "jev", classify: new ProviderError("down", { provider: "jev", status: 500 }) });
    const out = await withFallback(primary, haikuFake(), { threshold: 0.7 }).classify(TEXT, LABELS);
    expect(out).toMatchObject({ label: "todo", fallback: { from: "jev", reason: "error" } });
  });

  it("falls back only after Jev's 429/529 retries are exhausted", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetch = fetchQueue(json(429, {}), json(529, {}), json(429, {}), json(529, {}));
    const jev = new JevProvider({ apiKey: "k", fetch, retry: { retries: 3, sleep, random: () => 1, baseDelayMs: 100 } });
    const haiku = haikuFake();
    const out = await withFallback(jev, haiku, { threshold: 0.7 }).classify(TEXT, LABELS);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(haiku.calls).toHaveLength(1);
    expect(out).toMatchObject({ provider: "anthropic", fallback: { reason: "error" } });
  });

  it("propagates the fallback's error when both fail", async () => {
    const boom = new Error("fallback down");
    const p = new FakeProvider({ classify: new Error("primary down") });
    const f = new FakeProvider({ classify: boom });
    await expect(withFallback(p, f, { threshold: 0.5 }).classify(TEXT, LABELS)).rejects.toBe(boom);
  });

  it("reports usage with the model id each provider returned", async () => {
    const usage: UsageRecord[] = [];
    const fetch = fetchQueue(json(200, jevBody("diary", 0.2, "jev-1.13.0")));
    const jev = new JevProvider({ apiKey: "k", fetch, onUsage: (u) => void usage.push(u) });
    await withFallback(jev, haikuFake((u) => usage.push(u)), { threshold: 0.7 }).classify(TEXT, LABELS);
    expect(usage.map((u) => [u.provider, u.model])).toEqual([
      ["jev", "jev-1.13.0"],
      ["anthropic", "claude-haiku-5-5-20261001"],
    ]);
  });

  it("validates the threshold", () => {
    expect(() => withFallback(new FakeProvider(), new FakeProvider(), { threshold: 2 })).toThrow();
  });
});

describe("AnthropicProvider", () => {
  function fakeClient(reply: Partial<Message>) {
    const create = vi.fn(async () => ({
      model: "claude-haiku-5-5-20261001",
      usage: { input_tokens: 40, output_tokens: 9 },
      content: [],
      ...reply,
    }) as unknown as Message);
    const client: AnthropicLike = { messages: { create } };
    return { client, create };
  }

  it("classifies with a forced tool and reports usage with the returned model", async () => {
    const { client, create } = fakeClient({
      content: [{ type: "tool_use", id: "t1", name: "record_label", input: { label: "idea", confidence: 0.8 } }] as Message["content"],
    });
    const usage: UsageRecord[] = [];
    const out = await new AnthropicProvider({ client, onUsage: (u) => void usage.push(u) }).classify(TEXT, LABELS);
    expect(out).toEqual({ label: "idea", confidence: 0.8, model: "claude-haiku-5-5-20261001", provider: "anthropic" });
    const params = create.mock.calls[0] as unknown as [{ model: string; tool_choice: unknown }];
    expect(params[0].model).toBe("claude-haiku-5-5");
    expect(params[0].tool_choice).toEqual({ type: "tool", name: "record_label" });
    expect(usage).toEqual([
      { provider: "anthropic", model: "claude-haiku-5-5-20261001", operation: "classify", inputTokens: 40, outputTokens: 9 },
    ]);
  });

  it("completes text", async () => {
    const { client } = fakeClient({ content: [{ type: "text", text: "Hello" }] as Message["content"] });
    expect((await new AnthropicProvider({ client }).complete({ prompt: "hi" })).text).toBe("Hello");
  });

  it("wraps SDK errors in ProviderError", async () => {
    const client: AnthropicLike = { messages: { create: async () => Promise.reject(new Error("socket")) } };
    await expect(new AnthropicProvider({ client }).complete({ prompt: "hi" })).rejects.toBeInstanceOf(ProviderError);
  });
});
