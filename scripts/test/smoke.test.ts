import { describe, expect, it } from "vitest";
import { judge, normalizeBaseUrl, runSmoke, type FetchLike } from "../lib/smoke";

type Reply = { status: number; location?: string } | "throw";

function fakeFetch(replies: Record<string, Reply[]>): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const f = Object.assign(async (url: string) => {
    calls.push(url);
    const path = new URL(url).pathname;
    const queue = replies[path] ?? [];
    const r = queue.length > 1 ? queue.shift()! : queue[0];
    if (r === undefined) return { status: 404, headers: { get: () => null } };
    if (r === "throw") throw new TypeError("fetch failed");
    return { status: r.status, headers: { get: (n: string) => (n.toLowerCase() === "location" ? (r.location ?? null) : null) } };
  }, { calls });
  return f;
}

const GOOD: Record<string, Reply[]> = {
  "/": [{ status: 200 }],
  "/demo": [{ status: 200 }],
  "/hub": [{ status: 307, location: "/api/auth/signin?callbackUrl=%2Fhub" }],
};

const noSleep = async () => {};

describe("normalizeBaseUrl", () => {
  it("keeps the origin and requires https", () => {
    expect(normalizeBaseUrl("https://d1.cloudfront.net/")).toBe("https://d1.cloudfront.net");
    expect(normalizeBaseUrl("http://localhost:3917/x")).toBe("http://localhost:3917");
    expect(() => normalizeBaseUrl("http://d1.cloudfront.net")).toThrow(/https/);
    expect(() => normalizeBaseUrl("d1.cloudfront.net")).toThrow(/absolute/);
  });
});

describe("judge", () => {
  it("accepts 200 for ok and a matching 3xx for redirect", () => {
    expect(judge({ path: "/", expect: "ok" }, 200, null)).toBeUndefined();
    expect(judge({ path: "/", expect: "ok" }, 403, null)).toMatch(/expected 200, got 403/);
    const hub = { path: "/hub", expect: "redirect" as const, location: /\/api\/auth\/signin/ };
    expect(judge(hub, 307, "https://x/api/auth/signin")).toBeUndefined();
    expect(judge(hub, 200, null)).toMatch(/expected a redirect/);
    expect(judge(hub, 302, "https://evil.example/")).toMatch(/does not match/);
  });
});

describe("runSmoke", () => {
  it("passes on a healthy stack", async () => {
    const f = fakeFetch(GOOD);
    const lines: string[] = [];
    await runSmoke({ baseUrl: "https://d1.cloudfront.net", fetch: f, sleep: noSleep, log: (l) => lines.push(l) });
    expect(f.calls).toEqual(["https://d1.cloudfront.net/", "https://d1.cloudfront.net/demo", "https://d1.cloudfront.net/hub"]);
    expect(lines.at(-1)).toMatch(/OK .*attempt 1/);
  });

  it("retries until CloudFront serves the new stack", async () => {
    const f = fakeFetch({ ...GOOD, "/": ["throw", { status: 503 }, { status: 200 }] });
    await runSmoke({ baseUrl: "https://d1.cloudfront.net", fetch: f, sleep: noSleep, log: () => {}, attempts: 5 });
    expect(f.calls.filter((u) => u.endsWith(".net/")).length).toBe(3);
  });

  it("fails with every problem after the last attempt", async () => {
    const f = fakeFetch({ "/": [{ status: 200 }], "/demo": [{ status: 500 }], "/hub": [{ status: 200 }] });
    await expect(runSmoke({ baseUrl: "https://d1.cloudfront.net", fetch: f, sleep: noSleep, log: () => {}, attempts: 2 })).rejects.toThrow(
      /\/demo: expected 200, got 500; \/hub: expected a redirect, got 200/,
    );
  });
});
