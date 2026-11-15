import Anthropic from "@anthropic-ai/sdk";
import type { Message } from "@anthropic-ai/sdk/resources/messages/messages";
import { describe, expect, it, vi } from "vitest";
import {
  AnthropicProvider,
  callEventStatement,
  DeepseekProvider,
  FakeProvider,
  ProviderError,
  recordCallsWith,
  withFallback,
  type AnthropicLike,
  type CallEvent,
  type DeepseekProviderOptions,
} from "../src/models/index";

// AR3: every provider request is reported as one call (start, then end), with unknown token counts
// kept as null and each retry attempt as its own call. Synthetic text, keys and ids only.
const LABELS = ["travel", "comedic"] as const;
const TEXT = "SECRET-ESSAY-TEXT";
const TAG = { purpose: "categorize", subject: { kind: "essay", id: "00000000-0000-4000-8000-000000000009" } };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const tool = (label: string, usage: unknown = { prompt_tokens: 120, completion_tokens: 7 }) => ({
  model: "ds-returned",
  choices: [{ message: { tool_calls: [{ function: { name: "record_label", arguments: JSON.stringify({ label, confidence: 0.9 }) } }] } }],
  ...(usage !== null && { usage }),
});
function queue(...responses: (Response | Error)[]) {
  return vi.fn<typeof fetch>(async () => {
    const next = responses.shift();
    if (!next) throw new Error("fetch queue empty");
    if (next instanceof Error) throw next;
    return next;
  });
}
function deepseek(f: typeof fetch, extra: Partial<DeepseekProviderOptions> = {}) {
  const events: CallEvent[] = [];
  const p = new DeepseekProvider({ apiKey: "KEYMATERIAL", fetch: f, retry: { sleep: async () => undefined }, onCall: (e) => void events.push(e), ...extra });
  return { p, events };
}
const ends = (events: CallEvent[]) => events.filter((e) => e.phase === "end");

describe("DeepseekProvider call events", () => {
  it("reports start then end with the returned model and both counts, and passes the tag through", async () => {
    const { p, events } = deepseek(queue(json(200, tool("travel"))));
    await p.classify(TEXT, LABELS, { call: TAG });
    expect(events.map((e) => e.phase)).toEqual(["start", "end"]);
    expect(events[0]).toMatchObject({ provider: "deepseek", model: "deepseek-flash", operation: "classify", tag: TAG });
    expect(events[1]).toMatchObject({ callId: events[0]!.callId, model: "ds-returned", outcome: "reported", inputTokens: 120, outputTokens: 7, tag: TAG });
  });

  it("a response without usage is unknown with null counts, never 0", async () => {
    const { p, events } = deepseek(queue(json(200, tool("travel", null))));
    await p.classify(TEXT, LABELS);
    expect(ends(events)).toEqual([expect.objectContaining({ outcome: "unknown", inputTokens: null, outputTokens: null })]);
  });

  it("an invalid answer after a billed response keeps its reported call", async () => {
    const { p, events } = deepseek(queue(json(200, tool("not-a-label"))));
    await expect(p.classify(TEXT, LABELS)).rejects.toBeInstanceOf(ProviderError);
    expect(ends(events)).toEqual([expect.objectContaining({ outcome: "reported", inputTokens: 120 })]);
  });

  it("each retry attempt is its own call: 5xx unknown, then the reported one", async () => {
    const { p, events } = deepseek(queue(json(503, {}), new Error("socket"), json(200, tool("travel"))));
    await p.classify(TEXT, LABELS);
    const e = ends(events);
    expect(e.map((x) => x.phase === "end" && x.outcome)).toEqual(["unknown", "unknown", "reported"]);
    expect(new Set(events.map((x) => x.callId)).size).toBe(3);
  });

  it("a 4xx is rejected (not billed); invalid JSON is unknown", async () => {
    const a = deepseek(queue(json(400, {})));
    await expect(a.p.classify(TEXT, LABELS)).rejects.toBeInstanceOf(ProviderError);
    expect(ends(a.events)).toEqual([expect.objectContaining({ outcome: "rejected", inputTokens: null })]);
    const b = deepseek(queue(new Response("not json", { status: 200 })));
    await expect(b.p.complete({ prompt: TEXT })).rejects.toBeInstanceOf(ProviderError);
    expect(ends(b.events)).toEqual([expect.objectContaining({ outcome: "unknown", operation: "complete" })]);
  });

  it("a start that cannot be recorded stops the call before anything is sent", async () => {
    const f = queue(json(200, tool("travel")));
    const p = new DeepseekProvider({ apiKey: "k", fetch: f, onCall: (e) => { if (e.phase === "start") throw new Error("db down"); } });
    await expect(p.classify(TEXT, LABELS)).rejects.toThrow("db down");
    expect(f).not.toHaveBeenCalled();
  });

  it("a tag with text in it is refused before any call", async () => {
    const f = queue(json(200, tool("travel")));
    const { p } = deepseek(f);
    await expect(p.classify(TEXT, LABELS, { call: { purpose: "categorize", subject: { kind: "essay", id: "some words" } } })).rejects.toThrow(/subject/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("AnthropicProvider call events", () => {
  const msg = (usage: unknown = { input_tokens: 30, output_tokens: 4 }): Message =>
    ({ id: "m", type: "message", role: "assistant", model: "claude-returned", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", ...(usage !== null && { usage }) }) as unknown as Message;
  const apiError = (status: number) => Anthropic.APIError.generate(status, undefined, "synthetic", new Headers());

  it("retries 5xx and connection errors itself, one call per attempt", async () => {
    const answers: (Message | Error)[] = [apiError(500), new Anthropic.APIConnectionError({ message: "x" }), msg()];
    const client: AnthropicLike = { messages: { create: async () => { const a = answers.shift()!; if (a instanceof Error) throw a; return a; } } };
    const events: CallEvent[] = [];
    const out = await new AnthropicProvider({ client, onCall: (e) => void events.push(e), retry: { sleep: async () => undefined } }).complete({ prompt: "hi", call: { purpose: "plan", taskId: 7 } });
    expect(out.text).toBe("ok");
    expect(ends(events).map((e) => e.phase === "end" && [e.outcome, e.inputTokens])).toEqual([["unknown", null], ["unknown", null], ["reported", 30]]);
    expect(events[0]).toMatchObject({ tag: { purpose: "plan", taskId: 7 } });
  });

  it("a 400 is rejected and not retried; a reply without usage is unknown", async () => {
    const create = vi.fn(async () => { throw apiError(400); });
    const events: CallEvent[] = [];
    await expect(new AnthropicProvider({ client: { messages: { create } }, onCall: (e) => void events.push(e) }).complete({ prompt: "hi" })).rejects.toBeInstanceOf(ProviderError);
    expect(create).toHaveBeenCalledTimes(1);
    expect(ends(events)).toEqual([expect.objectContaining({ outcome: "rejected" })]);
    const ev2: CallEvent[] = [];
    await new AnthropicProvider({ client: { messages: { create: async () => msg(null) } }, onCall: (e) => void ev2.push(e) }).complete({ prompt: "hi" });
    expect(ends(ev2)).toEqual([expect.objectContaining({ outcome: "unknown", inputTokens: null, outputTokens: null })]);
  });
});

describe("FakeProvider and withFallback", () => {
  it("fake reports scripted counts, null counts as unknown, an Error answer as unknown", async () => {
    const events: CallEvent[] = [];
    const fake = new FakeProvider({ onCall: (e) => void events.push(e), complete: { text: "x", tokens: { input: null, output: 3 } } });
    await fake.complete({ prompt: "p" });
    await expect(new FakeProvider({ onCall: (e) => void events.push(e), classify: new Error("boom") }).classify("t", LABELS)).rejects.toThrow("boom");
    expect(ends(events).map((e) => e.phase === "end" && e.outcome)).toEqual(["unknown", "unknown"]);
  });

  it("the fallback's call carries the same tag", async () => {
    const events: CallEvent[] = [];
    const primary = new FakeProvider({ name: "p", onCall: (e) => void events.push(e), classify: new Error("down") });
    const fallback = new FakeProvider({ name: "f", onCall: (e) => void events.push(e) });
    await withFallback(primary, fallback, { threshold: 0.5 }).classify("t", LABELS, { call: TAG });
    expect(events.filter((e) => e.phase === "start").map((e) => [e.provider, e.tag])).toEqual([["p", TAG], ["f", TAG]]);
  });
});

describe("ledger statements", () => {
  it("defaults fill tag fields the call left unset; the call's own tag wins", async () => {
    const seen: unknown[][] = [];
    const record = recordCallsWith("orchestrator", async (_t, v) => void seen.push(v), { purpose: "plan", taskId: 3 });
    await record({ phase: "start", callId: "c-1", provider: "a", model: "m", operation: "complete", tag: { purpose: "review" } });
    expect(seen[0]).toEqual(["orchestrator", "a", "m", 3, "review", null, null, "call:c-1"]);
  });

  it("an end carries tokens and the outcome; a bad call id is refused", () => {
    const s = callEventStatement("router", { phase: "end", callId: "c-2", provider: "a", model: "m", operation: "classify", outcome: "unknown", inputTokens: null, outputTokens: null });
    expect(s.values.slice(8)).toEqual([null, null, "unknown"]);
    expect(() => callEventStatement("router", { phase: "start", callId: "has space", provider: "a", model: "m", operation: "classify" })).toThrow();
  });
});
