import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runAs } from "../src/server/db";
import { parseFollowers, refreshDue, type InstagramStore } from "../src/server/instagram";
import { runSocialDaily, SocialDailyFailedError } from "../src/server/jobs/social-daily";
import { parseChannelStats } from "../src/server/youtube";
import { freshDb, pglitePool } from "./pglite";

const NOW = Date.parse("2026-11-15T06:15:00Z");
const CTX = { scheduledTime: "2026-11-15T06:15:00Z" };
const YT_TOKEN = "synthetic-google-access-token";
const IG_TOKEN = "synthetic-instagram-token";
const IG_NEW = "synthetic-instagram-token-new";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ytBody = (stats: Record<string, unknown>) => ({ items: [{ statistics: stats }] });

type Handler = (url: string) => Response | Promise<Response>;
function fakeFetch(handlers: { yt?: Handler; ig?: Handler; refresh?: Handler }) {
  const calls: string[] = [];
  const bearers: string[] = [];
  const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    bearers.push((init?.headers as Record<string, string> | undefined)?.authorization ?? "");
    if (url.includes("googleapis.com/youtube")) return (handlers.yt ?? (() => json(ytBody({ subscriberCount: "1230", viewCount: "45678" }))))(url);
    if (url.includes("refresh_access_token")) return (handlers.refresh ?? (() => json({ access_token: IG_NEW })))(url);
    return (handlers.ig ?? (() => json({ user_id: "1", followers_count: 321 })))(url);
  });
  return { f: f as unknown as typeof fetch, calls, bearers };
}

function fakeStore(refreshedAt: string | null, opts: { failPatch?: boolean } = {}) {
  const patches: Record<string, string>[] = [];
  const store: InstagramStore = {
    read: async () => (refreshedAt === null ? null : { token: IG_TOKEN, refreshedAt }),
    patch: async (p) => {
      if (opts.failPatch) throw new Error("denied");
      patches.push({ ...p });
    },
  };
  return { store, patches };
}

describe("social-daily job", () => {
  let pg: PGlite;
  const run = <T,>(fn: Parameters<typeof runAs<T>>[2]) => runAs(pglitePool(pg), "web_rw", fn);
  const snapshots = async () =>
    (await pg.query<{ platform: string; day: string; followers: string | number | null; views: string | number | null; followers_exact: boolean }>(
      `SELECT a.platform, s.day::text AS day, s.followers, s.views, s.followers_exact
         FROM social_snapshots s JOIN social_accounts a ON a.id = s.account_id ORDER BY a.platform`,
    )).rows.map((r) => ({
      ...r,
      followers: r.followers === null ? null : Number(r.followers),
      views: r.views === null ? null : Number(r.views),
    }));

  beforeAll(async () => {
    pg = await freshDb();
    await pg.query(
      `INSERT INTO social_accounts (platform, handle, ingest) VALUES
         ('youtube', 'test_yt', 'api'), ('instagram', 'test_ig', 'api'), ('tiktok', 'test_tt', 'manual')`,
    );
  }, 60_000);
  afterAll(async () => {
    await pg.close();
  });
  beforeEach(async () => {
    await pg.query("DELETE FROM social_snapshots");
  });

  const deps = (over: Record<string, unknown> = {}) => {
    const logs: string[] = [];
    return { logs, d: { run, now: () => NOW, log: (l: string) => logs.push(l), googleToken: async () => YT_TOKEN, googleState: async () => "not_connected" as const, ...over } };
  };

  it("writes both platforms: YouTube inexact with views, Instagram exact with null views", async () => {
    const { f } = fakeFetch({});
    const { store } = fakeStore("2026-11-14T00:00:00Z");
    const { d, logs } = deps({ fetch: f, instagram: store });
    const out = await runSocialDaily(CTX, d);
    expect(out).toEqual({ code: "ok", counts: { written: 2, skipped: 0, failed: 0 } });
    expect(await snapshots()).toEqual([
      { platform: "instagram", day: "2026-11-15", followers: 321, views: null, followers_exact: true },
      { platform: "youtube", day: "2026-11-15", followers: 1230, views: 45678, followers_exact: false },
    ]);
    expect(logs).toEqual(["[social-daily] youtube ok", "[social-daily] instagram ok"]);
  });

  it("a hidden YouTube subscriber count gives null followers", async () => {
    const { f } = fakeFetch({ yt: () => json(ytBody({ hiddenSubscriberCount: true, viewCount: "9" })) });
    const { d } = deps({ fetch: f, instagram: fakeStore(null).store });
    await runSocialDaily(CTX, d);
    expect(await snapshots()).toEqual([{ platform: "youtube", day: "2026-11-15", followers: null, views: 9, followers_exact: false }]);
  });

  it("running twice for the same day writes one row per account", async () => {
    const { f } = fakeFetch({});
    const { d } = deps({ fetch: f, instagram: fakeStore("2026-11-14T00:00:00Z").store });
    await runSocialDaily(CTX, d);
    await runSocialDaily(CTX, d);
    expect(await snapshots()).toHaveLength(2);
  });

  it("not connected on both: skipped, job does not fail, code off", async () => {
    const { f, calls } = fakeFetch({});
    const { d, logs } = deps({ fetch: f, googleToken: async () => null, instagram: fakeStore(null).store });
    expect(await runSocialDaily(CTX, d)).toEqual({ code: "off", counts: { written: 0, skipped: 2, failed: 0 } });
    expect(calls).toEqual([]);
    expect(logs).toEqual(["[social-daily] youtube not_connected", "[social-daily] instagram not_connected"]);
  });

  it("no Google token while connected is a failure, not a skip; Instagram still runs", async () => {
    const { f, calls } = fakeFetch({});
    const { d, logs } = deps({
      fetch: f, googleToken: async () => null, googleState: async () => "connected", instagram: fakeStore("2026-11-14T00:00:00Z").store,
    });
    await expect(runSocialDaily(CTX, d)).rejects.toBeInstanceOf(SocialDailyFailedError);
    expect(logs).toEqual(["[social-daily] youtube http token", "[social-daily] instagram ok"]);
    expect(calls.some((c) => c.includes("youtube"))).toBe(false);
    expect((await snapshots()).map((s) => s.platform)).toEqual(["instagram"]);
  });

  it("a Google consent that was rejected is unauthorized", async () => {
    const { f } = fakeFetch({});
    const { d, logs } = deps({ fetch: f, googleToken: async () => null, googleState: async () => "expired", instagram: fakeStore(null).store });
    await expect(runSocialDaily(CTX, d)).rejects.toBeInstanceOf(SocialDailyFailedError);
    expect(logs[0]).toBe("[social-daily] youtube unauthorized token");
  });

  it("the snapshot day is the UTC day of the schedule time, not of the clock", async () => {
    const { f } = fakeFetch({});
    const { d } = deps({ fetch: f, instagram: fakeStore(null).store });
    await runSocialDaily({ scheduledTime: "2026-11-13T23:59:00Z" }, d);
    expect((await snapshots()).map((s) => s.day)).toEqual(["2026-11-13"]);
  });

  it("no api account gives no_account without calling the platform", async () => {
    await pg.query("UPDATE social_accounts SET ingest = 'manual' WHERE platform = 'youtube'");
    try {
      const { f, calls } = fakeFetch({});
      const { d, logs } = deps({ fetch: f, instagram: fakeStore("2026-11-14T00:00:00Z").store });
      await runSocialDaily(CTX, d);
      expect(logs[0]).toBe("[social-daily] youtube no_account");
      expect(calls.some((c) => c.includes("youtube"))).toBe(false);
    } finally {
      await pg.query("UPDATE social_accounts SET ingest = 'api' WHERE platform = 'youtube'");
    }
  });

  describe("Instagram token refresh", () => {
    it("refreshes at 25 days and patches both keys, then uses the new token", async () => {
      const { f, calls, bearers } = fakeFetch({});
      const { store, patches } = fakeStore("2026-10-21T06:15:00Z"); // exactly 25 days
      const { d, logs } = deps({ fetch: f, instagram: store });
      await runSocialDaily(CTX, d);
      expect(patches).toEqual([{ long_lived_token: IG_NEW, refreshed_at: "2026-11-15T06:15:00.000Z" }]);
      expect(calls.filter((c) => c.includes("refresh_access_token"))).toHaveLength(1);
      expect(logs[1]).toBe("[social-daily] instagram ok refresh=ok");
      expect(bearers[calls.findIndex((c) => c.includes("/me?"))]).toBe(`Bearer ${IG_NEW}`);
    });

    it("does not refresh below 25 days", async () => {
      const { f, calls } = fakeFetch({});
      const { store, patches } = fakeStore("2026-10-22T06:15:00Z"); // 24 days
      await runSocialDaily(CTX, deps({ fetch: f, instagram: store }).d);
      expect(patches).toEqual([]);
      expect(calls.some((c) => c.includes("refresh_access_token"))).toBe(false);
    });

    it("a refresh failure is logged by code and the snapshot is still written", async () => {
      const { f } = fakeFetch({ refresh: () => json({}, 500) });
      const { store, patches } = fakeStore("2026-09-01T00:00:00Z");
      const { d, logs } = deps({ fetch: f, instagram: store });
      const out = await runSocialDaily(CTX, d);
      expect(out.code).toBe("ok");
      expect(patches).toEqual([]);
      expect(logs[1]).toBe("[social-daily] instagram ok refresh=http");
      expect((await snapshots()).map((s) => s.platform)).toContain("instagram");
    });

    it("a refreshed token that cannot be saved fails the job; the snapshot is still written", async () => {
      const { f } = fakeFetch({});
      const { store } = fakeStore("2026-09-01T00:00:00Z", { failPatch: true });
      const { d, logs } = deps({ fetch: f, instagram: store });
      await expect(runSocialDaily(CTX, d)).rejects.toBeInstanceOf(SocialDailyFailedError);
      expect(logs).toEqual(["[social-daily] youtube ok", "[social-daily] instagram store refresh=store_failed Error"]);
      expect((await snapshots()).map((s) => s.platform)).toEqual(["instagram", "youtube"]);
    });

    it("refreshDue treats a missing date as due", () => {
      expect(refreshDue("", NOW)).toBe(true);
      expect(refreshDue("not a date", NOW)).toBe(true);
    });
  });

  describe("failures", () => {
    it("a 401 from YouTube fails the job after Instagram still ran", async () => {
      const { f } = fakeFetch({ yt: () => json({}, 401) });
      const { d, logs } = deps({ fetch: f, instagram: fakeStore("2026-11-14T00:00:00Z").store });
      await expect(runSocialDaily(CTX, d)).rejects.toBeInstanceOf(SocialDailyFailedError);
      expect(logs).toEqual(["[social-daily] youtube unauthorized", "[social-daily] instagram ok"]);
      expect(await snapshots()).toEqual([{ platform: "instagram", day: "2026-11-15", followers: 321, views: null, followers_exact: true }]);
    });

    it("an expired Instagram token (HTTP 400, code 190) is unauthorized, YouTube still written", async () => {
      const { f } = fakeFetch({ ig: () => json({ error: { code: 190, message: "secret detail" } }, 400) });
      const { d, logs } = deps({ fetch: f, instagram: fakeStore("2026-11-14T00:00:00Z").store });
      await expect(runSocialDaily(CTX, d)).rejects.toBeInstanceOf(SocialDailyFailedError);
      expect(logs[1]).toBe("[social-daily] instagram unauthorized");
      expect((await snapshots()).map((s) => s.platform)).toEqual(["youtube"]);
    });

    it("a malformed response is bad_response and writes nothing for that platform", async () => {
      const { f } = fakeFetch({ ig: () => json({ followers_count: "many" }), yt: () => new Response("<html>", { status: 200 }) });
      const { d, logs } = deps({ fetch: f, instagram: fakeStore("2026-11-14T00:00:00Z").store });
      await expect(runSocialDaily(CTX, d)).rejects.toThrow("social-daily failed");
      expect(logs).toEqual(["[social-daily] youtube bad_response", "[social-daily] instagram bad_response"]);
      expect(await snapshots()).toEqual([]);
    });

    it("a network error is reported as network", async () => {
      const f = vi.fn(async () => {
        throw new TypeError("connect ECONNREFUSED 203.0.113.9");
      }) as unknown as typeof fetch;
      const { d, logs } = deps({ fetch: f, instagram: fakeStore(null).store });
      await expect(runSocialDaily(CTX, d)).rejects.toBeInstanceOf(SocialDailyFailedError);
      expect(logs[0]).toBe("[social-daily] youtube network");
    });
  });

  it("log lines carry no token, handle, account id or response text", async () => {
    const { f } = fakeFetch({ ig: () => json({ error: { code: 190, message: "secret detail" } }, 400) });
    const { store } = fakeStore("2026-09-01T00:00:00Z", { failPatch: true });
    const { d, logs } = deps({ fetch: f, instagram: store });
    await runSocialDaily(CTX, d).catch(() => {});
    const all = logs.join("\n");
    const ids = (await pg.query<{ id: string }>("SELECT id FROM social_accounts")).rows.map((r) => r.id);
    expect(ids).toHaveLength(3);
    for (const s of [YT_TOKEN, IG_TOKEN, IG_NEW, "test_yt", "test_ig", ...ids, "secret detail", "denied"]) {
      expect(all).not.toContain(s);
    }
  });
});

describe("response parsers", () => {
  it("parseChannelStats rejects missing items and non-numeric counts", () => {
    expect(() => parseChannelStats({ items: [] })).toThrow("bad_response");
    expect(() => parseChannelStats(null)).toThrow("bad_response");
    expect(() => parseChannelStats(ytBody({ subscriberCount: "x", viewCount: "1" }))).toThrow("bad_response");
    expect(() => parseChannelStats(ytBody({ subscriberCount: "1" }))).toThrow("bad_response");
    expect(parseChannelStats(ytBody({ subscriberCount: "10", viewCount: "20" }))).toEqual({ followers: 10, views: 20 });
  });
  it("parseFollowers requires a non-negative integer", () => {
    expect(parseFollowers({ followers_count: 0 })).toBe(0);
    for (const bad of [{}, { followers_count: -1 }, { followers_count: 1.5 }, { followers_count: "3" }, null]) {
      expect(() => parseFollowers(bad)).toThrow("bad_response");
    }
  });
});
