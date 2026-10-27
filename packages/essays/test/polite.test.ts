import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPoliteClient } from "../src/crawl/polite";
import type { Db } from "../src/db";
import { loadSource } from "../src/registry/source";
import { addSource, essaysDb } from "./db-helpers";
import { FakeServer } from "./fake-server";

let pg: PGlite;
let db: Db;
const servers: FakeServer[] = [];

beforeAll(async () => {
  ({ pg, db } = await essaysDb());
});
afterAll(async () => {
  await pg.close();
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

let n = 0;
/** A fake site plus a registered source pointing at it, and a virtual clock that sleeping advances. */
async function setup(robots: { status: number; body?: string }, rules: Record<string, unknown> = {}) {
  const server = new FakeServer();
  await server.start();
  servers.push(server);
  server.reply("/robots.txt", robots.status, robots.body ?? "");
  server.reply("/essay/1", 200, "page one");
  server.reply("/private/2", 200, "page two");
  const id = await addSource(db, `polite-${n++}`, server.origin, { min_delay_ms: 3000, ...rules });
  const source = (await loadSource(db, id))!;
  const clock = { now: new Date("2026-10-27T10:00:00Z") };
  const sleeps: number[] = [];
  const polite = createPoliteClient({
    db,
    source,
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.now = new Date(clock.now.getTime() + ms);
    },
    random: () => 0,
  });
  return { server, id, polite, sleeps, clock };
}

describe("polite client", () => {
  it("fetches robots.txt first, then the page, spaced by the lease", async () => {
    const { server, polite, sleeps } = await setup({ status: 200, body: "User-agent: *\nDisallow: /private\n" });
    expect(await polite.get(`${server.origin}/essay/1`)).toMatchObject({ ok: true, body: "page one" });
    expect(server.requests.map((r) => r.path)).toEqual(["/robots.txt", "/essay/1"]);
    expect(sleeps).toEqual([3000]);
  });

  it("refuses a robots-disallowed path without requesting it", async () => {
    const { server, polite } = await setup({ status: 200, body: "User-agent: *\nDisallow: /private\n" });
    expect(await polite.get(`${server.origin}/private/2`)).toMatchObject({ ok: false, reason: "guard_refused", detail: "robots_disallow" });
    expect(server.count("/private/2")).toBe(0);
  });

  it("honors a wildcard group and Crawl-delay", async () => {
    const { server, polite, sleeps } = await setup({ status: 200, body: "User-agent: *\nCrawl-delay: 10\n" });
    await polite.get(`${server.origin}/essay/1`);
    await polite.get(`${server.origin}/essay/1`);
    // robots request, wait 3 s; page request (lease 10 s from robots Crawl-delay), wait 10 s; page again.
    expect(sleeps).toEqual([3000, 10_000]);
  });

  it("treats robots 404 as allow", async () => {
    const { server, polite } = await setup({ status: 404 });
    expect(await polite.get(`${server.origin}/private/2`)).toMatchObject({ ok: true });
  });

  it("fails closed on robots 5xx, 403 and 401", async () => {
    for (const status of [503, 403, 401]) {
      const { server, polite } = await setup({ status });
      const res = await polite.get(`${server.origin}/essay/1`);
      expect(res).toMatchObject({ ok: false, reason: "guard_refused" });
      expect(server.count("/essay/1")).toBe(0);
    }
  });

  it("retries a robots fetch in the next run after a transient failure", async () => {
    const { server, polite } = await setup({ status: 503 });
    expect(await polite.get(`${server.origin}/essay/1`)).toMatchObject({ ok: false });
    server.reply("/robots.txt", 200, "");
    expect(await polite.get(`${server.origin}/essay/1`)).toMatchObject({ ok: false }); // same run: still closed
    polite.cache.startRun();
    expect(await polite.get(`${server.origin}/essay/1`)).toMatchObject({ ok: true });
  });

  it("refuses hosts and paths outside the source rules", async () => {
    const { server, polite } = await setup({ status: 404 }, { allow_paths: ["/essay/"] });
    expect(await polite.get(`${server.origin}/private/2`)).toMatchObject({ ok: false, detail: "path_not_allowed" });
    expect(await polite.get("http://other.invalid/essay/1")).toMatchObject({ ok: false, detail: "host_not_allowed" });
  });

  it("refuses everything for a paused source", async () => {
    const { server, polite, id } = await setup({ status: 404 });
    await db.query("UPDATE sources SET paused_by = 'block' WHERE id = $1", [id]);
    const source = (await loadSource(db, id))!;
    const paused = createPoliteClient({ db, source, sleep: async () => {} });
    expect(await paused.get(`${server.origin}/essay/1`)).toMatchObject({ ok: false, detail: "source_paused" });
    expect(server.requests).toHaveLength(0);
    expect(polite.userAgent).toMatch(/^KentcrosswiseBot/);
  });

  it("pushes the lease out after a long Retry-After", async () => {
    const { server, polite, id, clock } = await setup({ status: 404 });
    server.reply("/essay/1", 429, "", { "retry-after": "600" });
    expect(await polite.get(`${server.origin}/essay/1`)).toMatchObject({ ok: false, reason: "http_429", retryAfterMs: 600_000 });
    expect((await loadSource(db, id))!.nextFetchAt!.getTime()).toBeGreaterThanOrEqual(clock.now.getTime() + 600_000);
  });

  it("serializes concurrent invocations on the shared lease (real clock)", async () => {
    const { server, id } = await setup({ status: 404 }, { min_delay_ms: 80 });
    const source = (await loadSource(db, id))!;
    const stamps: number[] = [];
    server.route("/essay/1", (_req, res) => {
      stamps.push(Date.now());
      res.writeHead(200);
      res.end("x");
    });
    const results = await Promise.all([1, 2, 3].map(() => createPoliteClient({ db, source }).get(`${server.origin}/essay/1`)));
    expect(results.every((r) => r.ok)).toBe(true);
    stamps.sort((x, y) => x - y);
    expect(stamps).toHaveLength(3);
    // Timers can fire a few ms early; the lease itself is exact (see lease.test.ts).
    expect((stamps[1] as number) - (stamps[0] as number)).toBeGreaterThanOrEqual(60);
    expect((stamps[2] as number) - (stamps[1] as number)).toBeGreaterThanOrEqual(60);
  });
});
