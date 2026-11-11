import type { Message } from "@anthropic-ai/sdk/resources/messages/messages";
import { describe, expect, it, vi } from "vitest";
import {
  AnthropicProvider,
  DEFAULT_ORCHESTRATOR_EFFORT,
  DEFAULT_ORCHESTRATOR_MODEL,
  FakeProvider,
  ProviderError,
  backoffDelay,
  withFallback,
  type AnthropicLike,
  type UsageRecord,
} from "../src/models/index";

const LABELS = ["crm_note", "diary", "todo", "idea", "agent_request"] as const;
const TEXT = "Buy milk tomorrow"; // synthetic

function haikuFake(usage?: (u: UsageRecord) => void) {
  return new FakeProvider({
    name: "anthropic",
    model: "claude-haiku-5-5-20261001",
    classify: { label: "todo", confidence: 0.9 },
    ...(usage && { onUsage: usage }),
  });
}

describe("backoffDelay", () => {
  it("is exponential, capped, and honours Retry-After", () => {
    expect(backoffDelay(1, null, { random: () => 1 })).toBe(500);
    expect(backoffDelay(3, null, { random: () => 1 })).toBe(2000);
    expect(backoffDelay(10, null, { random: () => 1 })).toBe(8000);
    expect(backoffDelay(1, null, { random: () => 0 })).toBe(250);
    const err = new ProviderError("x", { provider: "primary", status: 429, retryAfterSeconds: 3 });
    expect(backoffDelay(1, err, { random: () => 1 })).toBe(3000);
  });
});

describe("withFallback", () => {
  it("keeps the primary answer at or above the threshold", async () => {
    const primary = new FakeProvider({ name: "primary", classify: { label: "diary", confidence: 0.7 } });
    const fallback = haikuFake();
    const out = await withFallback(primary, fallback, { threshold: 0.7 }).classify(TEXT, LABELS);
    expect(out).toMatchObject({ label: "diary", provider: "primary" });
    expect(out.fallback).toBeUndefined();
    expect(fallback.calls).toHaveLength(0);
  });

  it("falls back on low confidence and records the primary's answer", async () => {
    const primary = new FakeProvider({ name: "primary", model: "primary-model-1", classify: { label: "diary", confidence: 0.4 } });
    const onFallback = vi.fn();
    const out = await withFallback(primary, haikuFake(), { threshold: 0.7, onFallback }).classify(TEXT, LABELS);
    expect(out).toMatchObject({
      label: "todo",
      provider: "anthropic",
      fallback: { from: "primary", reason: "low_confidence", primaryLabel: "diary", primaryConfidence: 0.4, primaryModel: "primary-model-1" },
    });
    expect(onFallback).toHaveBeenCalledOnce();
  });

  it("falls back on a primary error", async () => {
    const primary = new FakeProvider({ name: "primary", classify: new ProviderError("down", { provider: "primary", status: 500 }) });
    const out = await withFallback(primary, haikuFake(), { threshold: 0.7 }).classify(TEXT, LABELS);
    expect(out).toMatchObject({ label: "todo", fallback: { from: "primary", reason: "error" } });
  });

  it("propagates the fallback's error when both fail", async () => {
    const boom = new Error("fallback down");
    const p = new FakeProvider({ classify: new Error("primary down") });
    const f = new FakeProvider({ classify: boom });
    await expect(withFallback(p, f, { threshold: 0.5 }).classify(TEXT, LABELS)).rejects.toBe(boom);
  });

  it("reports usage with the model id each provider returned", async () => {
    const usage: UsageRecord[] = [];
    const primary = new FakeProvider({
      name: "primary",
      model: "primary-model-1",
      classify: { label: "diary", confidence: 0.2 },
      onUsage: (u) => void usage.push(u),
    });
    await withFallback(primary, haikuFake((u) => usage.push(u)), { threshold: 0.7 }).classify(TEXT, LABELS);
    expect(usage.map((u) => [u.provider, u.model])).toEqual([
      ["primary", "primary-model-1"],
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

  it("sends output_config.effort only when configured", async () => {
    const { client, create } = fakeClient({ content: [{ type: "text", text: "ok" }] as Message["content"] });
    await new AnthropicProvider({ client }).complete({ prompt: "hi" });
    await new AnthropicProvider({ client, model: DEFAULT_ORCHESTRATOR_MODEL, effort: DEFAULT_ORCHESTRATOR_EFFORT }).complete({ prompt: "hi" });
    const [plain, high] = create.mock.calls as unknown as [[Record<string, unknown>], [Record<string, unknown>]];
    expect(plain[0]).not.toHaveProperty("output_config");
    expect(high[0]).toMatchObject({ model: "claude-opus-5-5", output_config: { effort: "high" } });
  });

  it("wraps SDK errors in ProviderError", async () => {
    const client: AnthropicLike = { messages: { create: async () => Promise.reject(new Error("socket")) } };
    await expect(new AnthropicProvider({ client }).complete({ prompt: "hi" })).rejects.toBeInstanceOf(ProviderError);
  });
});
