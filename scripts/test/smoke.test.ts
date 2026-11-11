import { describe, expect, it } from "vitest";
import { hasBuildId, judge, normalizeBaseUrl, parseBuildFile, runSmoke, type FetchLike } from "../lib/smoke";

type Reply = { status: number; location?: string; body?: string } | "throw";

function fakeFetch(replies: Record<string, Reply[]>): FetchLike & { calls: string[]; bodyReads: string[] } {
  const calls: string[] = [];
  const bodyReads: string[] = [];
  const f = Object.assign(async (url: string) => {
    calls.push(url);
    const path = new URL(url).pathname;
    const queue = replies[path] ?? [];
    const r = queue.length > 1 ? queue.shift()! : queue[0];
    if (r === undefined) return { status: 404, headers: { get: () => null }, text: async () => "" };
    if (r === "throw") throw new TypeError("fetch failed");
    return {
      status: r.status,
      headers: { get: (n: string) => (n.toLowerCase() === "location" ? (r.location ?? null) : null) },
      text: async () => {
        bodyReads.push(path);
        return r.body ?? "";
      },
    };
  }, { calls, bodyReads });
  return f;
}

const ID = "gRdcxh-PRIYKgrEbTYttV";
const PAGE = `<script>self.__next_f.push([1,"{\\"d\\":\\"$undefined\\",\\"b\\":\\"${ID}\\"}"])</script>`;

const GOOD: Record<string, Reply[]> = {
  "/": [{ status: 200, body: PAGE }],
  "/demo": [{ status: 200, body: PAGE }],
  "/office": [{ status: 200, body: PAGE }],
  "/bot": [{ status: 200, body: PAGE }],
  "/hub": [{ status: 307, location: "/api/auth/signin?callbackUrl=%2Fhub" }],
};

const noSleep = async () => {};
const BASE = "https://d1.cloudfront.net";

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

describe("hasBuildId", () => {
  it("finds the id in plain and escaped flight data, not as a bare substring", () => {
    expect(hasBuildId(`{"b":"${ID}"}`, ID)).toBe(true);
    expect(hasBuildId(`\\"b\\":\\"${ID}\\"`, ID)).toBe(true);
    expect(hasBuildId(`\\"b\\":\\"other\\"`, ID)).toBe(false);
    expect(hasBuildId(`"${ID}"`, ID)).toBe(false);
  });
});

describe("parseBuildFile", () => {
  it("returns build_id from kcw-build.json", () => {
    expect(parseBuildFile(`{"kcw_env":"prod","build_id":"${ID}"}`)).toBe(ID);
  });

  it("rejects bad JSON, a missing id and an empty or non-string id", () => {
    expect(() => parseBuildFile("{not json")).toThrow(/must contain JSON/);
    expect(() => parseBuildFile("{}")).toThrow(/no build_id string/);
    expect(() => parseBuildFile(`{"build_id":""}`)).toThrow(/no build_id string/);
    expect(() => parseBuildFile(`{"build_id":42}`)).toThrow(/no build_id string/);
    expect(() => parseBuildFile("null")).toThrow(/no build_id string/);
  });
});

describe("runSmoke", () => {
  it("passes on a healthy stack", async () => {
    const f = fakeFetch(GOOD);
    const lines: string[] = [];
    await runSmoke({ baseUrl: BASE, fetch: f, sleep: noSleep, log: (l) => lines.push(l) });
    expect(f.calls).toEqual([`${BASE}/`, `${BASE}/demo`, `${BASE}/office`, `${BASE}/bot`, `${BASE}/hub`]);
    expect(lines.at(-1)).toMatch(/OK .*attempt 1/);
    expect(lines.at(-1)).not.toMatch(/build/);
  });

  it("passes when every page carries the build id and logs it", async () => {
    const f = fakeFetch(GOOD);
    const lines: string[] = [];
    await runSmoke({ baseUrl: BASE, buildId: ID, fetch: f, sleep: noSleep, log: (l) => lines.push(l) });
    expect(lines.at(-1)).toContain(`build ${ID} (attempt 1)`);
  });

  it("reads bodies only for ok checks when a build id is set", async () => {
    const f = fakeFetch(GOOD);
    await runSmoke({ baseUrl: BASE, buildId: ID, fetch: f, sleep: noSleep, log: () => {} });
    expect(f.bodyReads).toEqual(["/", "/demo", "/office", "/bot"]);
  });

  it("does not read bodies without a build id", async () => {
    const f = fakeFetch(GOOD);
    await runSmoke({ baseUrl: BASE, fetch: f, sleep: noSleep, log: () => {} });
    expect(f.bodyReads).toEqual([]);
  });

  it("fails on a stale page and passes once the edge serves the new build", async () => {
    const stale = `{"b":"old-build"}`;
    const f = fakeFetch({ ...GOOD, "/": [{ status: 200, body: stale }, { status: 200, body: PAGE }] });
    const lines: string[] = [];
    await runSmoke({ baseUrl: BASE, buildId: ID, fetch: f, sleep: noSleep, attempts: 3, log: (l) => lines.push(l) });
    expect(lines[0]).toContain(`/: build ${ID} not found (stale cache?)`);
    expect(lines.at(-1)).toMatch(/OK .*attempt 2/);
  });

  it("fails with the stale-cache problem when no attempt shows the build", async () => {
    const f = fakeFetch({ ...GOOD, "/demo": [{ status: 200, body: "old" }] });
    await expect(
      runSmoke({ baseUrl: BASE, buildId: ID, fetch: f, sleep: noSleep, attempts: 2, log: () => {} }),
    ).rejects.toThrow(`/demo: build ${ID} not found (stale cache?)`);
  });

  it("retries until CloudFront serves the new stack", async () => {
    const f = fakeFetch({ ...GOOD, "/": ["throw", { status: 503 }, { status: 200, body: PAGE }] });
    await runSmoke({ baseUrl: BASE, fetch: f, sleep: noSleep, log: () => {}, attempts: 5 });
    expect(f.calls.filter((u) => u === `${BASE}/`).length).toBe(3);
  });

  it("fails with every problem after the last attempt", async () => {
    const f = fakeFetch({ ...GOOD, "/demo": [{ status: 500 }], "/hub": [{ status: 200 }] });
    await expect(runSmoke({ baseUrl: BASE, fetch: f, sleep: noSleep, log: () => {}, attempts: 2 })).rejects.toThrow(
      /\/demo: expected 200, got 500; \/hub: expected a redirect, got 200/,
    );
  });
});
