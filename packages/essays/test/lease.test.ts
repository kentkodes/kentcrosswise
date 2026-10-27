import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimFetchSlot, noteRetryAfter, waitForFetchSlot } from "../src/crawl/lease";
import type { Db } from "../src/db";
import { loadSource, loadSources, parseCrawlRules, SourceConfigError, sourceAllows } from "../src/registry/source";
import { addSource, essaysDb } from "./db-helpers";

const T0 = new Date("2026-10-27T10:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

let pg: PGlite;
let db: Db;
beforeAll(async () => {
  ({ pg, db } = await essaysDb());
});
afterAll(async () => {
  await pg.close();
});

describe("claimFetchSlot", () => {
  it("grants one request, then makes the next wait min_delay_ms", async () => {
    const id = await addSource(db, "lease-a", "https://a.example.com", { min_delay_ms: 3000 });
    const first = await claimFetchSlot(db, id, { now: T0 });
    expect(first).toMatchObject({ granted: true });
    const second = await claimFetchSlot(db, id, { now: at(1000) });
    expect(second).toEqual({ granted: false, reason: "wait", waitMs: 2000 });
    expect(await claimFetchSlot(db, id, { now: at(3000) })).toMatchObject({ granted: true });
  });

  it("defaults to a 3 s delay", async () => {
    const id = await addSource(db, "lease-default", "https://d.example.com");
    await claimFetchSlot(db, id, { now: T0 });
    expect(await claimFetchSlot(db, id, { now: at(2999) })).toMatchObject({ granted: false, waitMs: 1 });
  });

  it("uses a longer robots Crawl-delay", async () => {
    const id = await addSource(db, "lease-robots", "https://r.example.com", { min_delay_ms: 1000 });
    await claimFetchSlot(db, id, { now: T0, robotsCrawlDelayMs: 10_000 });
    expect(await claimFetchSlot(db, id, { now: at(5000) })).toMatchObject({ granted: false, waitMs: 5000 });
  });

  it("lets only one of many concurrent callers through", async () => {
    const id = await addSource(db, "lease-race", "https://race.example.com");
    const results = await Promise.all(Array.from({ length: 8 }, () => claimFetchSlot(db, id, { now: T0 })));
    expect(results.filter((r) => r.granted)).toHaveLength(1);
    for (const r of results.filter((x) => !x.granted)) expect(r).toMatchObject({ reason: "wait" });
  });

  it("stops at the daily cap and resets on the next UTC day", async () => {
    const id = await addSource(db, "lease-cap", "https://cap.example.com", { min_delay_ms: 0, daily_request_cap: 2 });
    expect(await claimFetchSlot(db, id, { now: T0 })).toMatchObject({ granted: true });
    expect(await claimFetchSlot(db, id, { now: at(1) })).toMatchObject({ granted: true });
    expect(await claimFetchSlot(db, id, { now: at(2) })).toMatchObject({ granted: false, reason: "daily_cap" });
    expect(await claimFetchSlot(db, id, { now: new Date("2026-10-28T00:00:01Z") })).toMatchObject({ granted: true });
    expect((await loadSource(db, id))?.requestCount).toBe(1);
  });

  it("refuses paused and unknown sources", async () => {
    const id = await addSource(db, "lease-paused", "https://p.example.com");
    await db.query("UPDATE sources SET paused_by = 'owner' WHERE id = $1", [id]);
    expect(await claimFetchSlot(db, id, { now: T0 })).toMatchObject({ granted: false, reason: "paused" });
    expect(await claimFetchSlot(db, "no-such-slug", { now: T0 })).toMatchObject({ granted: false, reason: "unknown_source" });
  });

  it("Retry-After pushes the lease out and never pulls it in", async () => {
    const id = await addSource(db, "lease-retry", "https://ra.example.com", { min_delay_ms: 1000 });
    await claimFetchSlot(db, id, { now: T0 });
    await noteRetryAfter(db, id, 30_000, T0);
    expect(await claimFetchSlot(db, id, { now: at(10_000) })).toMatchObject({ granted: false, waitMs: 20_000 });
    await noteRetryAfter(db, id, 1000, T0);
    expect((await loadSource(db, id))?.nextFetchAt?.getTime()).toBe(at(30_000).getTime());
  });
});

describe("waitForFetchSlot", () => {
  it("sleeps until the lease is free", async () => {
    const id = await addSource(db, "lease-wait", "https://w.example.com", { min_delay_ms: 3000 });
    let now = T0;
    const sleeps: number[] = [];
    const opts = {
      clock: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now = new Date(now.getTime() + ms);
      },
    };
    expect(await waitForFetchSlot(db, id, opts)).toMatchObject({ granted: true });
    expect(await waitForFetchSlot(db, id, opts)).toMatchObject({ granted: true });
    expect(sleeps).toEqual([3000]);
  });

  it("gives up when the wait is too long", async () => {
    const id = await addSource(db, "lease-long", "https://l.example.com", { min_delay_ms: 120_000 });
    await claimFetchSlot(db, id, { now: T0 });
    const res = await waitForFetchSlot(db, id, { clock: () => T0, sleep: async () => {}, maxWaitMs: 60_000 });
    expect(res).toMatchObject({ granted: false, reason: "wait" });
  });
});

describe("source registry loader", () => {
  it("loads by uuid or slug with the design defaults", async () => {
    const id = await addSource(db, "load-a", "https://Load.example.com", { allow_paths: ["/ebooks/"] });
    const bySlug = await loadSource(db, "load-a");
    expect(bySlug?.id).toBe(id);
    expect((await loadSource(db, id))?.slug).toBe("load-a");
    expect(bySlug).toMatchObject({
      health: "ok", paused: false, licensePolicy: "pd_only", discoveryMode: "seed_targeted", consecutiveFailures: 0,
    });
    expect(bySlug?.crawlRules).toMatchObject({
      minDelayMs: 3000, dailyRequestCap: 500, maxConcurrency: 1, allowPaths: ["/ebooks/"], allowHosts: ["load.example.com"],
    });
    expect(bySlug?.crawlRules.userAgent).toMatch(/^KentcrosswiseBot\/1\.0 /);
    expect(await loadSource(db, "nope")).toBeNull();
    expect((await loadSources(db)).length).toBeGreaterThan(0);
  });

  it("rejects invalid crawl rules", () => {
    const bad = (rules: Record<string, unknown>) => () => parseCrawlRules(rules, "https://example.com");
    expect(bad({ min_delay_ms: -1 })).toThrow(SourceConfigError);
    expect(bad({ max_concurrency: 4 })).toThrow(SourceConfigError);
    expect(bad({ respect_crawl_delay: false })).toThrow(SourceConfigError);
    expect(bad({ allow_paths: ["ebooks"] })).toThrow(SourceConfigError);
    expect(bad({ user_agent: " " })).toThrow(SourceConfigError);
  });

  it("sourceAllows checks paused, host and allow_paths", async () => {
    await addSource(db, "allow-a", "https://allow.example.com", { allow_paths: ["/ebooks/"], allow_hosts: ["files.example.com"] });
    const s = (await loadSource(db, "allow-a"))!;
    expect(sourceAllows(s, "https://allow.example.com/ebooks/1")).toEqual({ allowed: true });
    expect(sourceAllows(s, "https://files.example.com/ebooks/1")).toEqual({ allowed: true });
    expect(sourceAllows(s, "https://allow.example.com/search")).toEqual({ allowed: false, reason: "path_not_allowed" });
    expect(sourceAllows(s, "https://evil.example.org/ebooks/1")).toEqual({ allowed: false, reason: "host_not_allowed" });
    expect(sourceAllows(s, "https://allow.example.com/robots.txt")).toEqual({ allowed: true });
    expect(sourceAllows(s, "ftp://allow.example.com/ebooks/1")).toEqual({ allowed: false, reason: "invalid_url" });
    expect(sourceAllows({ ...s, paused: true }, "https://allow.example.com/ebooks/1")).toEqual({ allowed: false, reason: "source_paused" });
  });
});
