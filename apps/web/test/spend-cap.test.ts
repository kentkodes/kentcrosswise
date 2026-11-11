import type { PGlite } from "@electric-sql/pglite";
import { fromPglite } from "@kcw/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  capReached as orchestratorCapReached,
  monthToDateSpend,
  SPEND_CAP_USD as ORCHESTRATOR_CAP_USD,
  utcMonth,
} from "../../../agents/orchestrator/src/sweeper/spend";
import { sqlSweeperStore } from "../../../agents/orchestrator/src/sweeper/store";
import { runAs, type Queryable } from "../src/server/db";
import { capReachedUsd, monthToDateRange, SPEND_CAP_USD, usageSummary } from "../src/server/usage";
import { freshDb, pglitePool } from "./pglite";

// Equivalence: the usage panel's SQL (usage.ts) and the sweep's pure rule (spend.ts, read through
// the sweeper store) must agree on the same rows. Synthetic providers, models and prices only.
// Fixtures stay inside the month up to NOW so the panel's range (through today) and the sweep's
// range (through the month's end) cover the same events.

const NOW = new Date("2026-11-10T15:00:00Z");

describe("spend cap: the web copy agrees with the orchestrator", () => {
  it("the cap is the same number in both", () => {
    expect(SPEND_CAP_USD).toBe(50);
    expect(SPEND_CAP_USD).toBe(ORCHESTRATOR_CAP_USD);
  });
});

describe("monthToDateRange (UTC)", () => {
  it("runs from the 1st of the month through today", () => {
    expect(monthToDateRange(NOW)).toEqual({ from: "2026-11-01", to: "2026-11-10" });
  });

  it("the first instant of a month starts that month; the last instant of the previous month is the previous one", () => {
    expect(monthToDateRange(new Date("2026-11-01T00:00:00Z"))).toEqual({ from: "2026-11-01", to: "2026-11-01" });
    expect(monthToDateRange(new Date("2026-10-31T23:59:59Z"))).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });
});

describe("month-to-date spend: usage panel SQL and sweep rule on the same rows", () => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = await freshDb();
    await pg.exec(`
      INSERT INTO model_prices (provider, model, usd_per_mtok_in, usd_per_mtok_out, effective_from) VALUES
        ('acme', 'm1', 1, 2, '2026-01-01'),
        ('acme', 'm1', 3, 6, '2026-11-05'),     -- change on the 5th (UTC)
        ('acme', 'm2', 10, 10, '2026-11-08');   -- starts after the m2 event on the 7th
      INSERT INTO usage_events (ts, kind, agent, provider, model, input_tokens, output_tokens, cost_usd, minutes, dedupe_key) VALUES
        -- last instant of October: not in November
        ('2026-10-31T23:59:59Z', 'model', 'developer', 'acme', 'm1', 1000000, 0, NULL, NULL, NULL),
        -- first instant of November, old price: 1M x $1 + 1M x $2 = $3
        ('2026-11-01T00:00:00Z', 'model', 'developer', 'acme', 'm1', 1000000, 1000000, NULL, NULL, NULL),
        -- the day before the change: $1
        ('2026-11-04T23:59:59Z', 'model', 'qa', 'acme', 'm1', 1000000, 0, NULL, NULL, NULL),
        -- the change day from 00:00 UTC: 1M x $3 = $3
        ('2026-11-05T00:00:00Z', 'model', 'qa', 'acme', 'm1', 1000000, 0, NULL, NULL, NULL),
        -- m2 has no price yet on the 7th: unpriced
        ('2026-11-07T12:00:00Z', 'model', 'qa', 'acme', 'm2', 2000, 1000, NULL, NULL, NULL),
        -- m2 priced from the 8th: 1M x $10 + 1M x $10 = $20
        ('2026-11-08T12:00:00Z', 'model', 'docs', 'acme', 'm2', 1000000, 1000000, NULL, NULL, NULL),
        -- a stored cost wins: $0.25
        ('2026-11-09T12:00:00Z', 'model', 'orchestrator', 'acme', 'm1', 0, 0, 0.25, NULL, NULL),
        -- no price at all: unpriced
        ('2026-11-10T20:00:00Z', 'model', 'orchestrator', 'other', 'm3', 10, 10, NULL, NULL, NULL),
        -- Actions minutes never count as model spend
        ('2026-11-03T12:00:00Z', 'actions_minutes', 'developer', NULL, NULL, NULL, NULL, 0, 7.5, 'github:workflow_run:1:1');
    `);
  });

  afterAll(async () => {
    await pg.close();
  });

  const pool = () => pglitePool(pg);

  // The sweep side runs its store as orch_rw (runAs only takes web roles, so switch the session role).
  async function sweepSide(now: Date) {
    await pg.exec("SET ROLE orch_rw");
    try {
      const { start, end } = utcMonth(now);
      const usage = await sqlSweeperStore(fromPglite(pg)).monthUsage(start, end);
      return monthToDateSpend(usage.events, usage.prices, now);
    } finally {
      await pg.exec("RESET ROLE");
    }
  }

  // Expected, computed by hand: 3 + 1 + 3 + 20 + 0.25 = 27.25; unpriced 2 (the m2 row on the 7th and other/m3).
  const EXPECTED = { events: 7, spentUsd: 27.25, unpricedEvents: 2 };

  it("the usage panel's month total matches the hand-computed expectation", async () => {
    const s = await runAs(pool(), "web_rw", (db: Queryable) => usageSummary(db, monthToDateRange(NOW)), { readOnly: true });
    expect(s.range).toEqual({ from: "2026-11-01", to: "2026-11-10" });
    expect(s.total.events).toBe(EXPECTED.events);
    expect(s.total.costUsd).toBeCloseTo(EXPECTED.spentUsd, 6);
    expect(s.total.unpricedEvents).toBe(EXPECTED.unpricedEvents);
  });

  it("the sweep's rule, read through the orchestrator store as orch_rw, gives the same numbers", async () => {
    const spend = await sweepSide(NOW);
    expect(spend.month).toBe("2026-11");
    expect(spend.events).toBe(EXPECTED.events);
    expect(spend.spentUsd).toBeCloseTo(EXPECTED.spentUsd, 6);
    expect(spend.unpricedEvents).toBe(EXPECTED.unpricedEvents);
  });

  it("the two sides agree with each other on every number", async () => {
    const panel = await runAs(pool(), "web_rw", (db: Queryable) => usageSummary(db, monthToDateRange(NOW)), { readOnly: true });
    const sweep = await sweepSide(NOW);
    expect(sweep.events).toBe(panel.total.events);
    expect(sweep.unpricedEvents).toBe(panel.total.unpricedEvents);
    expect(sweep.spentUsd).toBeCloseTo(panel.total.costUsd ?? 0, 6);
  });
});

describe("cap boundary: both sides give the same verdict", () => {
  // Values chosen at and around the cap, including the sub-micro half-way case (rounds up to 50 in JS).
  it.each<[number, boolean]>([
    [50, true],
    [49.999999, false],
    [49.99999949, false],
    [49.99999951, true],
    [49.9999995, true],
    [50.01, true],
  ])("total %s: web and orchestrator agree (reached: %s)", (total, reached) => {
    expect(capReachedUsd(total)).toBe(reached);
    expect(orchestratorCapReached(total)).toBe(reached);
    expect(capReachedUsd(total, SPEND_CAP_USD)).toBe(orchestratorCapReached(total, ORCHESTRATOR_CAP_USD));
  });

  it("no spend yet (null) is not reached on either side", () => {
    expect(capReachedUsd(null)).toBe(false);
    expect(orchestratorCapReached(0)).toBe(false);
  });

  it("an exact $50 month total, read through the database, is reached on both sides", async () => {
    const pg = await freshDb();
    try {
      await pg.exec(`
        INSERT INTO usage_events (ts, kind, agent, provider, model, input_tokens, output_tokens, cost_usd) VALUES
          ('2026-11-02T10:00:00Z', 'model', 'developer', 'acme', 'm1', 0, 0, 20),
          ('2026-11-03T10:00:00Z', 'model', 'qa', 'acme', 'm1', 0, 0, 30);
      `);
      const panel = await runAs(pglitePool(pg), "web_rw", (db: Queryable) => usageSummary(db, monthToDateRange(NOW)), { readOnly: true });
      const sweep = await (async () => {
        await pg.exec("SET ROLE orch_rw");
        try {
          const { start, end } = utcMonth(NOW);
          const usage = await sqlSweeperStore(fromPglite(pg)).monthUsage(start, end);
          return monthToDateSpend(usage.events, usage.prices, NOW);
        } finally {
          await pg.exec("RESET ROLE");
        }
      })();
      expect(panel.total.costUsd).toBe(50);
      expect(sweep.spentUsd).toBe(50);
      expect(capReachedUsd(panel.total.costUsd)).toBe(true);
      expect(orchestratorCapReached(sweep.spentUsd)).toBe(true);
    } finally {
      await pg.close();
    }
  });
});
