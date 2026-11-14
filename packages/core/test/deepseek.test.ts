import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
  DeepseekProvider,
  ProviderError,
  type DeepseekProviderOptions,
  type UsageRecord,
} from "../src/models/index";

const LABELS = ["travel", "cultural", "comedic"] as const;
const TEXT = "SECRET-ESSAY-TEXT"; // synthetic
const KEY = "KEYMATERIAL";
const BODY_MARK = "RESPONSEBODY";
const RETURNED = "deepseek-flash-returned-id"; // the id the API reports, may differ from the requested one

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function toolReply(args: unknown, extra: Record<string, unknown> = {}) {
  return {
    model: RETURNED,
    choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "record_label", arguments: JSON.stringify(args) } }] } }],
    usage: { prompt_tokens: 120, completion_tokens: 7 },
    ...extra,
  };
}
const contentReply = (content: string) => ({ model: "m-1", choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 5, completion_tokens: 2 } });

function queue(...responses: (Response | Error)[]) {
  return vi.fn<typeof fetch>(async () => {
    const next = responses.shift();
    if (!next) throw new Error("fetch queue empty");
    if (next instanceof Error) throw next;
    return next;
  });
}

const make = (fetchFn: typeof fetch, extra: Partial<DeepseekProviderOptions> = {}) =>
  new DeepseekProvider({ apiKey: KEY, fetch: fetchFn, retry: { sleep: async () => undefined }, ...extra });

describe("DeepseekProvider", () => {
  it("classifies through a forced tool call and sends the pinned model, key and base URL", async () => {
    const f = queue(json(200, toolReply({ label: "travel", confidence: 0.83 })));
    const out = await make(f).classify(TEXT, LABELS, { instructions: "Pick one." });
    expect(out).toEqual({ label: "travel", confidence: 0.83, model: RETURNED, provider: "deepseek" });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DEFAULT_DEEPSEEK_BASE_URL}/chat/completions`);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("deepseek-flash");
    expect(DEFAULT_DEEPSEEK_BASE_URL).toBe("https://api.deepseek.com");
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "record_label" } });
    expect(body.tools[0].function.parameters.properties.label.enum).toEqual([...LABELS]);
    expect(body.messages[0].content).toContain("Pick one.");
    expect(body.messages[1]).toEqual({ role: "user", content: TEXT });
  });

  it("falls back to a JSON object in the message when there is no tool call", async () => {
    const f = queue(json(200, contentReply('Here you go:\n```json\n{"label": "cultural", "confidence": 1.4}\n```')));
    const out = await make(f).classify(TEXT, LABELS);
    expect(out).toMatchObject({ label: "cultural", confidence: 1, model: "m-1" }); // clamped to 1
  });

  it("rejects a label outside the labels with a non-retryable ProviderError (one call only)", async () => {
    const f = queue(json(200, toolReply({ label: "diary", confidence: 0.9 })), json(200, toolReply({ label: "travel", confidence: 1 })));
    const err = await make(f).classify(TEXT, LABELS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(false);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("rejects an answer with no label at all", async () => {
    const err = await make(queue(json(200, contentReply("no idea")))).classify(TEXT, LABELS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(false);
  });

  it("retries 429 then succeeds, honouring the retry count", async () => {
    const f = queue(json(429, { error: BODY_MARK }, { "retry-after": "1" }), json(200, toolReply({ label: "comedic", confidence: 0.6 })));
    const sleep = vi.fn(async () => undefined);
    const out = await make(f, { retry: { sleep } }).classify(TEXT, LABELS);
    expect(out.label).toBe("comedic");
    expect(f).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("retries network errors and 5xx, then gives up with a body-free error", async () => {
    const f = queue(new TypeError(`${BODY_MARK} ${KEY}`), json(500, { e: BODY_MARK }), json(502, { e: BODY_MARK }), json(500, { e: BODY_MARK }));
    const err = await make(f).classify(TEXT, LABELS).catch((e: unknown) => e);
    expect(f).toHaveBeenCalledTimes(4);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(500);
    const text = JSON.stringify([(err as Error).message, (err as Error).name, String((err as Error).stack).split("\n")[0]]);
    for (const leak of [KEY, BODY_MARK, TEXT]) expect(text).not.toContain(leak);
  });

  it("does not retry other 4xx and never leaks key, prompt or body into the error", async () => {
    const f = queue(json(401, { error: `${BODY_MARK} ${KEY} ${TEXT}` }));
    const err = (await make(f).classify(TEXT, LABELS).catch((e: unknown) => e)) as ProviderError;
    expect(f).toHaveBeenCalledTimes(1);
    expect(err.retryable).toBe(false);
    expect(err.message).toBe("DeepSeek returned HTTP 401");
  });

  it("a network error without a retry budget has a fixed message", async () => {
    const err = (await make(queue(new TypeError(`${KEY} ${BODY_MARK}`)), { retry: { retries: 0 } }).classify(TEXT, LABELS).catch((e: unknown) => e)) as ProviderError;
    expect(err.message).toBe("DeepSeek request failed (network or timeout)");
  });

  it("uses an overridden base URL (trailing slash tolerated) and an async key", async () => {
    const f = queue(json(200, toolReply({ label: "travel", confidence: 1 })));
    await make(f, { baseUrl: "https://gateway.example.com/openai/v1/", apiKey: async () => "ASYNCKEY" }).classify(TEXT, LABELS);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://gateway.example.com/openai/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ASYNCKEY");
  });

  it("reports usage from the response (0 when absent) for classify and complete", async () => {
    const usage: UsageRecord[] = [];
    const p = make(queue(json(200, toolReply({ label: "travel", confidence: 1 })), json(200, { choices: [{ message: { content: "Hello" } }] })), {
      onUsage: (u) => void usage.push(u),
    });
    await p.classify(TEXT, LABELS);
    const done = await p.complete({ prompt: "hi", system: "be brief" });
    expect(done).toEqual({ text: "Hello", stop: "end", model: DEFAULT_DEEPSEEK_MODEL, provider: "deepseek" });
    expect(usage).toEqual([
      { provider: "deepseek", model: RETURNED, operation: "classify", inputTokens: 120, outputTokens: 7 },
      { provider: "deepseek", model: DEFAULT_DEEPSEEK_MODEL, operation: "complete", inputTokens: 0, outputTokens: 0 },
    ]);
  });

  it("complete sends the system message first and honours maxTokens", async () => {
    const f = queue(json(200, contentReply("x")));
    await make(f, { maxTokens: 50 }).complete({ prompt: "hi", system: "sys", maxTokens: 9 });
    const body = JSON.parse((f.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.messages).toEqual([{ role: "system", content: "sys" }, { role: "user", content: "hi" }]);
    expect(body.max_tokens).toBe(9);
    expect(body).not.toHaveProperty("tools");
  });

  it.each([
    ["length", "max_tokens"],
    ["content_filter", "refusal"],
    ["stop", "end"],
  ])("complete maps finish_reason %s to %s", async (finish_reason, stop) => {
    const f = queue(json(200, { model: "m-1", choices: [{ message: { content: "x" }, finish_reason }] }));
    expect(await make(f).complete({ prompt: "hi" })).toMatchObject({ stop });
  });

  it("classify throws a non-retryable ProviderError when finish_reason is length (one call only)", async () => {
    const f = queue(json(200, { model: "m-1", choices: [{ message: { content: "" }, finish_reason: "length" }] }));
    const err = await make(f).classify(TEXT, LABELS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ message: "DeepSeek response stopped: max_tokens", retryable: false });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("needs at least two labels", async () => {
    await expect(make(queue()).classify(TEXT, ["travel"])).rejects.toThrow("two labels");
  });
});
