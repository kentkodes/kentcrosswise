import type { TestPg } from "./db-helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db";
import { MAX_URL_ATTEMPTS, nextHealth, recordOutcome, recordSourceEvent, stateOf, type HealthEvent, type HealthState } from "../src/registry/health";
import { loadSource } from "../src/registry/source";
import { addSource, essaysDb } from "./db-helpers";

const OK: HealthState = { health: "ok", healthReason: null, consecutiveFailures: 0, pausedBy: null };
const fail = (reason = "http_5xx"): HealthEvent => ({ kind: "failure", reason });

function run(state: HealthState, events: HealthEvent[]): HealthState {
  return events.reduce((s, e) => nextHealth(s, e).state, state);
}

describe("health state machine", () => {
  it("stays ok for 1-2 failures", () => {
    expect(run(OK, [fail()])).toMatchObject({ health: "ok", consecutiveFailures: 1, healthReason: "http_5xx" });
    expect(run(OK, [fail(), fail()])).toMatchObject({ health: "ok", consecutiveFailures: 2 });
  });

  it("degrades at 3 failures and asks for exactly one issue", () => {
    let state = OK;
    let opened = 0;
    for (const e of [fail(), fail(), fail()]) {
      const t = nextHealth(state, e);
      state = t.state;
      if (t.effects.openIssue) opened += 1;
    }
    expect(state).toMatchObject({ health: "degraded", consecutiveFailures: 3, pausedBy: null });
    expect(opened).toBe(1);
    const more = nextHealth(state, fail());
    expect(more.state.health).toBe("degraded");
    expect(more.effects.openIssue).toBe(false);
  });

  it("breaks and pauses at 6 failures", () => {
    const s = run(OK, Array.from({ length: 6 }, () => fail("feed_unparseable")));
    expect(s).toEqual({ health: "broken", healthReason: "feed_unparseable", consecutiveFailures: 6, pausedBy: "failures" });
  });

  it("a discovery success resets a healthy source but does not restore a degraded one", () => {
    expect(run(OK, [fail(), fail(), { kind: "success", mode: "discover" }])).toMatchObject({ health: "ok", consecutiveFailures: 0, healthReason: null });
    const degraded = run(OK, [fail(), fail(), fail()]);
    expect(run(degraded, [{ kind: "success", mode: "discover" }]).health).toBe("degraded");
  });

  it("a successful nightly check restores degraded and failure-paused sources", () => {
    const degraded = run(OK, [fail(), fail(), fail()]);
    expect(run(degraded, [{ kind: "success", mode: "check" }])).toEqual(OK);
    const broken = run(OK, Array.from({ length: 6 }, () => fail()));
    expect(run(broken, [{ kind: "success", mode: "check" }])).toEqual(OK);
  });

  it.each(["robots_disallow", "blocked_401", "blocked_403", "login_required", "paywall"] as const)(
    "block signal %s pauses at once, link-only, no issue",
    (reason) => {
      const t = nextHealth(OK, { kind: "block", reason });
      expect(t.state).toMatchObject({ health: "broken", healthReason: reason, pausedBy: "block" });
      expect(t.effects).toMatchObject({ linkOnly: true, openIssue: false });
    },
  );

  it("a nightly check cannot lift a block or an owner pause; only the owner can", () => {
    const blocked = nextHealth(OK, { kind: "block", reason: "robots_disallow" }).state;
    expect(run(blocked, [{ kind: "success", mode: "check" }])).toEqual(blocked);
    const owner = run(OK, [{ kind: "owner_pause" }]);
    expect(owner.pausedBy).toBe("owner");
    expect(run(owner, [fail(), { kind: "success", mode: "check" }])).toEqual(owner);
    expect(run(blocked, [{ kind: "owner_resume" }])).toEqual(OK);
    expect(run(owner, [{ kind: "owner_resume" }])).toEqual(OK);
  });
});

describe("recordSourceEvent / recordOutcome", () => {
  let pg: TestPg;
  let db: Db;
  beforeAll(async () => {
    ({ pg, db } = await essaysDb());
  });
  afterAll(async () => {
    await pg.close();
  });

  const NOW = new Date("2026-10-27T12:00:00Z");

  it("persists transitions and timestamps", async () => {
    const id = await addSource(db, "h-a", "https://h-a.example.com");
    for (let i = 0; i < 3; i++) await recordSourceEvent(db, id, fail("http_5xx"), NOW);
    let s = (await loadSource(db, id))!;
    expect(s).toMatchObject({ health: "degraded", consecutiveFailures: 3, healthReason: "http_5xx", paused: false });
    expect(s.lastCheckedAt?.toISOString()).toBe(NOW.toISOString());
    expect(s.lastOkAt).toBeNull();
    await recordSourceEvent(db, id, { kind: "success", mode: "check" }, NOW);
    s = (await loadSource(db, id))!;
    expect(s).toMatchObject({ health: "ok", consecutiveFailures: 0, healthReason: null });
    expect(s.lastOkAt?.toISOString()).toBe(NOW.toISOString());
  });

  it("six failures pause the source and the loader reports paused", async () => {
    const id = await addSource(db, "h-b", "https://h-b.example.com");
    for (let i = 0; i < 6; i++) await recordSourceEvent(db, id, fail(), NOW);
    expect(await loadSource(db, id)).toMatchObject({ health: "broken", paused: true, pausedBy: "failures" });
    expect(stateOf((await loadSource(db, id))!).pausedBy).toBe("failures");
  });

  it("a block signal pauses the source and marks only its new URLs link_only", async () => {
    const id = await addSource(db, "h-c", "https://h-c.example.com");
    const other = await addSource(db, "h-d", "https://h-d.example.com");
    await db.query(
      `INSERT INTO essay_urls (url, source_id, status) VALUES
         ('https://h-c.example.com/a', $1, 'new'), ('https://h-c.example.com/b', $1, 'fetched'),
         ('https://h-d.example.com/a', $2, 'new')`,
      [id, other],
    );
    const t = await recordSourceEvent(db, id, { kind: "block", reason: "robots_disallow" }, NOW);
    expect(t.source).toMatchObject({ paused: true, pausedBy: "block", healthReason: "robots_disallow" });
    const { rows } = await db.query<{ url: string; status: string }>("SELECT url, status FROM essay_urls WHERE url LIKE 'https://h-%' ORDER BY url");
    expect(rows.map((r) => r.status)).toEqual(["link_only", "fetched", "new"]);
  });

  it("applies fetch outcomes to essay_urls", async () => {
    const id = await addSource(db, "h-e", "https://h-e.example.com");
    const url = "https://h-e.example.com/essay";
    await db.query("INSERT INTO essay_urls (url, source_id) VALUES ($1, $2)", [url, id]);
    for (let i = 1; i < MAX_URL_ATTEMPTS; i++) {
      expect(await recordOutcome(db, url, { kind: "fetch_failed" })).toBe(true);
      expect((await db.query<{ status: string; attempts: number }>("SELECT status, attempts FROM essay_urls WHERE url = $1", [url])).rows[0]).toEqual({ status: "new", attempts: i });
    }
    await recordOutcome(db, url, { kind: "fetch_failed" });
    expect((await db.query<{ status: string }>("SELECT status FROM essay_urls WHERE url = $1", [url])).rows[0]?.status).toBe("failed");
    await recordOutcome(db, url, { kind: "quarantined" });
    expect((await db.query<{ status: string }>("SELECT status FROM essay_urls WHERE url = $1", [url])).rows[0]?.status).toBe("quarantined");
    expect(await recordOutcome(db, "https://h-e.example.com/unknown", { kind: "fetched" })).toBe(false);
  });
});
