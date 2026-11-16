// AR3 accounting: the usage page totals and the sweep's spending decision reconcile on the shared
// fixture; router and mood calls are call records linked to their entry; unpriced and unknown rows
// stay visible and out of the cap total; a price-read failure makes no model call. PGlite and
// FakeProvider only; no model is called for real. Synthetic text and ids.
import type { PGlite } from "@electric-sql/pglite";
import { FakeProvider } from "@kcw/core/models";
import { fromPglite } from "@kcw/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  FIXTURE_EXPECTED,
  FIXTURE_EXPECTED_AFTER_LATE_PRICE,
  FIXTURE_LATE_PRICE_SQL,
  FIXTURE_NOW,
  FIXTURE_PRICES_SQL,
  FIXTURE_USAGE_SQL,
} from "../../../packages/db/test/usage-fixtures";
import { monthToDateSpend, utcMonth } from "../../../agents/orchestrator/src/sweeper/spend";
import { sqlSweeperStore } from "../../../agents/orchestrator/src/sweeper/store";
import { saveEntry } from "../src/server/capture";
import { runAs } from "../src/server/db";
import { createDiaryEntry } from "../src/server/diary";
import { scoreDiaryEntry } from "../src/server/mood";
import { recordRouterCall, routeEntry, type DbRun } from "../src/server/router";
import { capReachedUsd, monthToDateRange, spendDecisionLine, usageSummary } from "../src/server/usage";
import { freshDb, pglitePool } from "./pglite";

const GOOD_MOOD = JSON.stringify({ energy: 0.5, stress: 0.5, happiness: 0.5, satisfaction: 0.5, sadness: 0.5, anger: 0, anxiety: 0, gratitude: 0, sentiment: 0 });

describe("reconciliation: usage page and spending decision on the same rows", () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await freshDb();
    await pg.exec(FIXTURE_PRICES_SQL + FIXTURE_USAGE_SQL);
  });
  afterAll(async () => {
    await pg.close();
  });

  const both = async () => {
    const panel = await runAs(pglitePool(pg), "web_rw", (db) => usageSummary(db, monthToDateRange(FIXTURE_NOW)), { readOnly: true });
    await pg.exec("SET ROLE orch_rw");
    try {
      const { start, end } = utcMonth(FIXTURE_NOW);
      const u = await sqlSweeperStore(fromPglite(pg)).monthUsage(start, end);
      return { panel, sweep: monthToDateSpend(u.events, u.prices, FIXTURE_NOW) };
    } finally {
      await pg.exec("RESET ROLE");
    }
  };

  it("same totals, unpriced and unknown counts on both sides; unknown tokens are not invented", async () => {
    const { panel, sweep } = await both();
    const page = { events: panel.total.events, spentUsd: panel.total.costUsd, unpricedEvents: panel.total.unpricedEvents, unknownEvents: panel.total.unknownEvents };
    expect(page).toEqual(FIXTURE_EXPECTED);
    expect({ events: sweep.events, spentUsd: sweep.spentUsd, unpricedEvents: sweep.unpricedEvents, unknownEvents: sweep.unknownEvents }).toEqual(FIXTURE_EXPECTED);
    // Tokens of the unknown and started calls are NULL: only reported counts are summed.
    expect(panel.total.inputTokens).toBe(1_000_000 + 10 + 0 + 1000);
    expect(spendDecisionLine(panel)).toBe("spend_cap spent=5.50 unpriced=1 unknown=2");
  });

  it("groups by purpose, with the counts where they belong", async () => {
    const { panel } = await both();
    const by = Object.fromEntries(panel.byPurpose.map((g) => [g.key, g]));
    expect(Object.keys(by).sort()).toEqual(["categorize", "hook", "mood", "plan", "route", "work"]);
    expect(by.route).toMatchObject({ events: 2, costUsd: 2, unpricedEvents: 0, unknownEvents: 0 });
    expect(by.categorize).toMatchObject({ costUsd: null, unpricedEvents: 1 });
    expect(by.hook).toMatchObject({ costUsd: null, unknownEvents: 1, unpricedEvents: 0 });
  });

  it("a price entered late applies to earlier calls on both sides", async () => {
    await pg.exec(FIXTURE_LATE_PRICE_SQL);
    const { panel, sweep } = await both();
    expect([panel.total.costUsd, panel.total.unpricedEvents]).toEqual([FIXTURE_EXPECTED_AFTER_LATE_PRICE.spentUsd, 0]);
    expect([sweep.spentUsd, sweep.unpricedEvents]).toEqual([FIXTURE_EXPECTED_AFTER_LATE_PRICE.spentUsd, 0]);
  });
});

describe("router and mood call records (web_rw on PGlite)", () => {
  let pg: PGlite;
  const run: DbRun = (fn) => runAs(pglitePool(pg), "web_rw", fn);
  beforeAll(async () => {
    pg = await freshDb();
  });
  afterAll(async () => {
    await pg.close();
  });
  const calls = async () =>
    (await pg.query<Record<string, unknown>>(
      "SELECT agent, purpose, subject_kind, subject_id, outcome, input_tokens FROM usage_events WHERE dedupe_key LIKE 'call:%' ORDER BY ts, outcome",
    )).rows;

  it("a route call is one record linked to its capture entry; a mood call to its diary entry", async () => {
    const entry = await run((db) => saveEntry(db, "Synthetic capture"));
    const router = new FakeProvider({ classify: { label: "todo", confidence: 0.9 }, onCall: (e) => run((db) => recordRouterCall(db, e)) });
    await expect(routeEntry(run, entry, router)).resolves.toMatchObject({ code: "routed" });
    const diary = await run((db) => createDiaryEntry(db, "Synthetic diary body"));
    const mood = new FakeProvider({ complete: { text: GOOD_MOOD }, onCall: (e) => run((db) => recordRouterCall(db, e)) });
    await expect(scoreDiaryEntry(run, diary, mood)).resolves.toBe("scored");
    expect(await calls()).toEqual([
      { agent: "router", purpose: "route", subject_kind: "entry", subject_id: entry, outcome: "reported", input_tokens: "Synthetic capture".length },
      { agent: "router", purpose: "mood", subject_kind: "diary_entry", subject_id: diary, outcome: "reported", input_tokens: "Synthetic diary body".length },
    ]);
    // No text in the rows.
    const all = JSON.stringify((await pg.query("SELECT * FROM usage_events")).rows);
    expect(all).not.toContain("Synthetic");
    await pg.exec("DELETE FROM usage_events");
  });

  it("an invalid mood answer after a billed response keeps its reported record; a provider error leaves an unknown one", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const diary = await run((db) => createDiaryEntry(db, "Another synthetic body"));
    const invalid = new FakeProvider({ complete: { text: "not json" }, onCall: (e) => run((db) => recordRouterCall(db, e)) });
    await expect(scoreDiaryEntry(run, diary, invalid)).resolves.toBe("failed");
    const failing = new FakeProvider({ complete: new Error("timeout"), onCall: (e) => run((db) => recordRouterCall(db, e)) });
    await expect(scoreDiaryEntry(run, diary, failing)).resolves.toBe("failed");
    expect((await calls()).map((r) => [r.purpose, r.outcome, r.input_tokens])).toEqual([
      ["mood", "reported", "Another synthetic body".length],
      ["mood", "unknown", null],
    ]);
    log.mockRestore();
    await pg.exec("DELETE FROM usage_events");
  });

  it("an unpriced row is counted as unpriced and not in the cap total; the cap decision is logged with the counts", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const day = new Date().toISOString().slice(0, 10);
    await pg.exec(`
      INSERT INTO usage_events (ts, kind, agent, provider, model, input_tokens, output_tokens, cost_usd) VALUES
        ('${day}T00:00:00Z', 'model', 'developer', 'acme', 'm-none', 900000000, 900000000, NULL),
        ('${day}T00:00:00Z', 'model', 'developer', 'acme', 'm1', 0, 0, 49.99);`);
    let month = await run((db) => usageSummary(db, monthToDateRange()));
    expect([month.total.costUsd, month.total.unpricedEvents, capReachedUsd(month.total.costUsd)]).toEqual([49.99, 1, false]);
    await pg.exec(`INSERT INTO usage_events (ts, kind, agent, provider, model, input_tokens, output_tokens, cost_usd) VALUES
      ('${day}T00:00:01Z', 'model', 'developer', 'acme', 'm1', 0, 0, 0.01)`);
    month = await run((db) => usageSummary(db, monthToDateRange()));
    expect(capReachedUsd(month.total.costUsd)).toBe(true);
    const entry = await run((db) => saveEntry(db, "Capped capture"));
    const provider = new FakeProvider({ classify: { label: "todo", confidence: 0.9 } });
    await expect(routeEntry(run, entry, provider)).resolves.toEqual({ code: "cap" });
    expect(provider.calls).toHaveLength(0);
    expect(log).toHaveBeenCalledWith("[router] spend_cap spent=50.00 unpriced=1 unknown=0");
    log.mockRestore();
    await pg.exec("DELETE FROM usage_events");
  });

  it("a price-read failure makes no model call and is not swallowed", async () => {
    const entry = await run((db) => saveEntry(db, "Price read fails"));
    const provider = new FakeProvider({ classify: { label: "todo", confidence: 0.9 } });
    await pg.exec("REVOKE SELECT ON model_prices FROM web_rw");
    try {
      await expect(routeEntry(run, entry, provider)).rejects.toThrow(/permission denied/);
    } finally {
      await pg.exec("GRANT SELECT ON model_prices TO web_rw");
    }
    expect(provider.calls).toHaveLength(0);
  });
});
