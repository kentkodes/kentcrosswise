import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAs, type Queryable } from "../src/server/db";
import { formatUsd, parseRange, usageSummary, type UsageGroup } from "../src/server/usage";
import { freshDb, pglitePool } from "./pglite";

// Synthetic providers, models and prices only (never vendor prices).
const RANGE = { from: "2026-03-01", to: "2026-03-31" };

describe("usageSummary as web_rw", () => {
  let pg: PGlite;
  const asRw = <T>(fn: (db: Queryable) => Promise<T>) => runAs(pglitePool(pg), "web_rw", fn, { readOnly: true });
  const find = (groups: UsageGroup[], key: string) => groups.find((g) => g.key === key);

  beforeAll(async () => {
    pg = await freshDb();
    await pg.exec(`
      INSERT INTO model_prices (provider, model, usd_per_mtok_in, usd_per_mtok_out, effective_from) VALUES
        ('acme', 'm1', 1, 2, '2026-01-01'),
        ('acme', 'm1', 3, 6, '2026-03-15'),   -- price change mid-range
        ('acme', 'm1', 100, 100, '2026-04-01'), -- after the range: never used for it
        ('acme', 'm2', 10, 10, '2026-03-20');  -- starts after the m2 event below
      INSERT INTO usage_events (ts, kind, agent, provider, model, input_tokens, output_tokens, cost_usd, minutes, dedupe_key) VALUES
        -- before the change: 1M in x $1 + 1M out x $2 = $3
        ('2026-03-10T12:00:00Z', 'model', 'developer', 'acme', 'm1', 1000000, 1000000, NULL, NULL, NULL),
        -- on the change day (UTC): 1M x $3 + 0.5M x $6 = $6
        ('2026-03-15T00:00:00Z', 'model', 'qa', 'acme', 'm1', 1000000, 500000, NULL, NULL, NULL),
        -- a stored cost wins over model_prices
        ('2026-03-16T08:00:00Z', 'model', 'developer', 'acme', 'm1', 1000000, 0, 0.5, NULL, NULL),
        -- no price yet for m2 on this day, and no price at all for m3
        ('2026-03-12T08:00:00Z', 'model', 'qa', 'acme', 'm2', 2000, 1000, NULL, NULL, NULL),
        ('2026-03-12T09:00:00Z', 'model', 'orchestrator', 'other', 'm3', 10, 10, NULL, NULL, NULL),
        -- outside the range on both sides
        ('2026-02-28T23:59:59Z', 'model', 'developer', 'acme', 'm1', 5, 5, NULL, NULL, NULL),
        ('2026-04-01T00:00:00Z', 'model', 'developer', 'acme', 'm1', 5, 5, NULL, NULL, NULL),
        -- Actions minutes: counted apart, never in model cost
        ('2026-03-10T12:00:00Z', 'actions_minutes', 'orchestrator', NULL, NULL, NULL, NULL, 0, 7.5, 'github:workflow_run:1:1'),
        ('2026-03-11T12:00:00Z', 'actions_minutes', 'developer', NULL, NULL, NULL, NULL, 0, 2.25, 'github:workflow_run:2:1'),
        ('2026-04-02T12:00:00Z', 'actions_minutes', 'developer', NULL, NULL, NULL, NULL, 0, 99, 'github:workflow_run:3:1');
    `);
  });
  afterAll(async () => {
    await pg.close();
  });

  it("prices each event with the price effective on its day (price change mid-range)", async () => {
    const s = await asRw((db) => usageSummary(db, RANGE));
    const m1 = find(s.byModel, "acme/m1")!;
    // $3 (old price) + $6 (new price) + $0.5 (stored cost)
    expect(m1).toEqual({ key: "acme/m1", events: 3, inputTokens: 3_000_000, outputTokens: 1_500_000, costUsd: 9.5, unpricedEvents: 0 });
    expect(find(s.byDay, "2026-03-10")!.costUsd).toBe(3);
    expect(find(s.byDay, "2026-03-15")!.costUsd).toBe(6);
    expect(find(s.byDay, "2026-03-16")!.costUsd).toBe(0.5);
  });

  it("shows no price (null, not $0) when no price row applies", async () => {
    const s = await asRw((db) => usageSummary(db, RANGE));
    expect(find(s.byModel, "acme/m2")).toMatchObject({ events: 1, costUsd: null, unpricedEvents: 1 });
    expect(find(s.byModel, "other/m3")).toMatchObject({ events: 1, costUsd: null, unpricedEvents: 1 });
    expect(find(s.byAgent, "orchestrator")).toMatchObject({ costUsd: null, unpricedEvents: 1 });
    // A group with priced and unpriced events: the priced sum plus the unpriced count.
    expect(find(s.byAgent, "qa")).toMatchObject({ events: 2, costUsd: 6, unpricedEvents: 1 });
    expect(find(s.byDay, "2026-03-12")).toMatchObject({ events: 2, costUsd: null, unpricedEvents: 2 });
    expect(formatUsd(null)).toBe("no price");
  });

  it("totals and groups only model usage inside the range", async () => {
    const s = await asRw((db) => usageSummary(db, RANGE));
    expect(s.total).toEqual({
      key: "total",
      events: 5,
      inputTokens: 3_002_010,
      outputTokens: 1_501_010,
      costUsd: 9.5,
      unpricedEvents: 2,
    });
    expect(s.byAgent.map((g) => g.key)).toEqual(["qa", "developer", "orchestrator"]);
    expect(find(s.byAgent, "developer")).toMatchObject({ events: 2, costUsd: 3.5 });
    expect(s.byModel.map((g) => g.key)).toEqual(["acme/m1", "acme/m2", "other/m3"]);
    expect(s.byDay.map((g) => g.key)).toEqual(["2026-03-10", "2026-03-12", "2026-03-15", "2026-03-16"]);
  });

  it("sums Actions minutes separately", async () => {
    const s = await asRw((db) => usageSummary(db, RANGE));
    expect(s.actions).toEqual({ minutes: 9.75, runs: 2 });
  });

  it("an empty range has zero totals and no groups", async () => {
    const s = await asRw((db) => usageSummary(db, { from: "2025-01-01", to: "2025-01-31" }));
    expect(s.total).toMatchObject({ events: 0, costUsd: null, unpricedEvents: 0 });
    expect([s.byAgent, s.byModel, s.byDay]).toEqual([[], [], []]);
    expect(s.actions).toEqual({ minutes: 0, runs: 0 });
  });

  it("dedupe_key keeps one row per run attempt (0004)", async () => {
    await expect(
      pg.query(
        "INSERT INTO usage_events (kind, agent, minutes, dedupe_key) VALUES ('actions_minutes', 'qa', 1, 'github:workflow_run:1:1')",
      ),
    ).rejects.toThrow(/duplicate key/);
    const s = await asRw((db) => usageSummary(db, RANGE));
    expect(s.actions.runs).toBe(2);
  });
});

describe("usageSummary on the preview seed", () => {
  it("shows priced and unpriced seed usage and Actions minutes in the default range", async () => {
    const pg = await freshDb({ seed: true });
    try {
      const s = await runAs(pglitePool(pg), "web_rw", (db) => usageSummary(db, parseRange(undefined, undefined)), { readOnly: true });
      expect(s.total.events).toBe(6);
      expect(s.byModel.find((g) => g.key === "seed/seed-unpriced")).toMatchObject({ costUsd: null });
      expect(s.byModel.find((g) => g.key === "seed/seed-large")!.costUsd).toBeGreaterThan(0);
      expect(s.actions).toEqual({ minutes: 11.75, runs: 2 });
    } finally {
      await pg.close();
    }
  });
});

describe("parseRange", () => {
  const now = new Date("2026-10-23T15:00:00Z");

  it("defaults to the last 30 days including today (UTC)", () => {
    expect(parseRange(undefined, undefined, now)).toEqual({ from: "2026-09-24", to: "2026-10-23", adjusted: false });
  });

  it("accepts a valid range", () => {
    expect(parseRange("2026-01-01", "2026-01-31", now)).toEqual({ from: "2026-01-01", to: "2026-01-31", adjusted: false });
    expect(parseRange("2026-01-01", "2026-01-01", now)).toMatchObject({ adjusted: false });
  });

  it.each<[unknown, unknown]>([
    ["2026-02-30", "2026-03-01"],
    ["2026-03-02", "2026-03-01"],
    ["2024-01-01", "2026-01-01"],
    ["yesterday", "2026-01-01"],
    [["2026-01-01"], "2026-01-02"],
    ["2026-01-01", undefined],
  ])("falls back to the default for %j..%j", (from, to) => {
    expect(parseRange(from, to, now)).toEqual({ from: "2026-09-24", to: "2026-10-23", adjusted: true });
  });
});

describe("formatUsd", () => {
  it("formats cents under a dollar with 4 decimals", () => {
    expect(formatUsd(0)).toBe("$0.0000");
    expect(formatUsd(0.01234)).toBe("$0.0123");
    expect(formatUsd(12.345)).toBe("$12.35");
  });
});
