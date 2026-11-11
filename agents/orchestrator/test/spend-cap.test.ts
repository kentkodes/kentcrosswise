// The $50 monthly model-spend cap (spend.ts, sweep.ts, store.ts): the pure rule, the sweep's
// decisions on fakes, and the SQL reads and flag write as orch_rw on PGlite.
import { PGlite } from "@electric-sql/pglite";
import { fromPglite, migrate } from "@kcw/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DispatchWorkflowInput, CancelResult } from "../src/github";
import {
  SPEND_CAP_USD,
  capReached,
  eventCostUsd,
  monthToDateSpend,
  runSweep,
  sqlSweeperStore,
  utcMonth,
  type ActiveRun,
  type QueuedMessage,
  type SpendEvent,
  type SpendPrice,
  type SweepTask,
  type SweeperGitHub,
  type SweeperStore,
  type WebhookDelivery,
} from "../src/sweeper";

const at = (iso: string) => new Date(iso);

function ev(ts: string, p: Partial<SpendEvent> = {}): SpendEvent {
  return { ts: at(ts), provider: "acme", model: "m1", inputTokens: 0, outputTokens: 0, costUsd: null, ...p };
}

function price(effectiveFrom: string, usdPerMtokIn: number, usdPerMtokOut: number, model = "m1"): SpendPrice {
  return { provider: "acme", model, effectiveFrom, usdPerMtokIn, usdPerMtokOut };
}

// ---------------------------------------------------------------- the cap and the pure rule

describe("cap constant and comparison", () => {
  it("the cap is $50 and reached at or above it", () => {
    expect(SPEND_CAP_USD).toBe(50);
    expect(capReached(49.999999)).toBe(false);
    expect(capReached(50)).toBe(true);
    expect(capReached(50.01)).toBe(true);
  });

  it("compares at micro-dollar precision: the total is rounded before the verdict", () => {
    expect(capReached(49.99999949)).toBe(false); // rounds to 49.999999
    expect(capReached(49.99999951)).toBe(true); // rounds to 50
    expect(capReached(49.9999995)).toBe(true); // a half micro-dollar rounds up to 50 (Math.round)
  });

  it("the month total is rounded to micro-dollars before it is compared", () => {
    const now = new Date("2026-11-10T00:00:00Z");
    const s = monthToDateSpend([ev("2026-11-02T10:00:00Z", { costUsd: 49.9999995 })], [], now);
    expect(s.spentUsd).toBe(50);
    expect(capReached(s.spentUsd)).toBe(true);
  });
});

describe("monthToDateSpend", () => {
  const NOW = at("2026-11-10T12:00:00Z");

  it("under the cap: sums stored and priced costs", () => {
    const s = monthToDateSpend([ev("2026-11-02T10:00:00Z", { costUsd: 19.5 }), ev("2026-11-03T10:00:00Z", { costUsd: 30.49 })], [], NOW);
    expect(s).toMatchObject({ month: "2026-11", events: 2, spentUsd: 49.99, unpricedEvents: 0 });
    expect(capReached(s.spentUsd)).toBe(false);
  });

  it("exactly at the cap: reached", () => {
    const s = monthToDateSpend([ev("2026-11-02T10:00:00Z", { costUsd: 20 }), ev("2026-11-03T10:00:00Z", { costUsd: 30 })], [], NOW);
    expect(s.spentUsd).toBe(50);
    expect(capReached(s.spentUsd)).toBe(true);
  });

  it("over the cap: reached", () => {
    const s = monthToDateSpend([ev("2026-11-02T10:00:00Z", { costUsd: 50.01 })], [], NOW);
    expect(s.spentUsd).toBe(50.01);
    expect(capReached(s.spentUsd)).toBe(true);
  });

  it("unpriced rows are counted and add $0, reported apart from the total", () => {
    const prices = [price("2026-01-01", 1, 2)];
    const s = monthToDateSpend(
      [
        ev("2026-11-02T10:00:00Z", { costUsd: 10 }),
        ev("2026-11-02T11:00:00Z", { model: "no-price", inputTokens: 1_000_000, outputTokens: 1_000_000 }),
        ev("2026-11-02T12:00:00Z", { inputTokens: 1_000_000, outputTokens: 0 }), // priced by the row above: $1
      ],
      prices,
      NOW,
    );
    expect(s).toMatchObject({ events: 3, spentUsd: 11, unpricedEvents: 1 });
  });

  it("month boundary is UTC: the instant decides the month, both ends", () => {
    const events = [
      ev("2026-10-31T23:59:59.999Z", { costUsd: 100 }), // October: excluded
      ev("2026-11-01T00:00:00.000Z", { costUsd: 1 }), // first instant of November: included
      ev("2026-11-30T23:59:59.999Z", { costUsd: 2 }), // last instant of November: included
      ev("2026-12-01T00:00:00.000Z", { costUsd: 100 }), // December: excluded
    ];
    const s = monthToDateSpend(events, [], at("2026-11-15T00:00:00Z"));
    expect(s).toMatchObject({ month: "2026-11", events: 2, spentUsd: 3 });
    expect(utcMonth(at("2026-11-01T00:00:00Z")).month).toBe("2026-11");
    expect(utcMonth(at("2026-10-31T23:59:59Z")).month).toBe("2026-10");
    expect(utcMonth(at("2026-12-31T23:59:59Z")).month).toBe("2026-12");
  });

  it("price effective_from: the latest row on or before the event's UTC day applies", () => {
    const prices = [price("2026-03-01", 1, 2), price("2026-03-15", 3, 6)];
    const now = at("2026-03-20T00:00:00Z");
    const oneMillionEach = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    // 2026-03-14 23:59 UTC is still the 03-01 row: $1 + $2 = $3.
    expect(eventCostUsd(ev("2026-03-14T23:59:00Z", oneMillionEach), prices)).toBe(3);
    // The change day, from 00:00 UTC: the 03-15 row: $3 + $6 = $9.
    expect(eventCostUsd(ev("2026-03-15T00:00:00Z", oneMillionEach), prices)).toBe(9);
    expect(monthToDateSpend([ev("2026-03-14T23:59:00Z", oneMillionEach), ev("2026-03-15T00:00:00Z", oneMillionEach)], prices, now).spentUsd).toBe(12);
  });

  it("a price effective after the event's day does not apply; the event is unpriced", () => {
    const prices = [price("2026-03-15", 3, 6)];
    expect(eventCostUsd(ev("2026-03-14T12:00:00Z", { inputTokens: 1, outputTokens: 1 }), prices)).toBeNull();
    expect(eventCostUsd(ev("2026-03-15T12:00:00Z", { inputTokens: 1, outputTokens: 1 }), prices)).not.toBeNull();
  });

  it("a stored cost wins over the price row; missing tokens count as 0", () => {
    const prices = [price("2026-01-01", 1, 2)];
    expect(eventCostUsd(ev("2026-03-01T00:00:00Z", { costUsd: 0.5, inputTokens: 1_000_000 }), prices)).toBe(0.5);
    expect(eventCostUsd(ev("2026-03-01T00:00:00Z", { inputTokens: null, outputTokens: 1_000_000 }), prices)).toBe(2);
  });

  it("prices are per provider and model", () => {
    const prices = [price("2026-01-01", 1, 2, "m1")];
    expect(eventCostUsd(ev("2026-03-01T00:00:00Z", { model: "m2", inputTokens: 1 }), prices)).toBeNull();
  });
});

// ---------------------------------------------------------------- the sweep on fakes

class FakeSpendStore implements SweeperStore {
  tasks: SweepTask[] = [];
  paused = false;
  events: SpendEvent[] = [];
  prices: SpendPrice[] = [];
  spendFails = false;
  flagWrites = 0;
  flagFails = false;
  async listSweepTasks(limit: number) {
    return this.tasks.slice(0, limit);
  }
  async isAgentsPaused() {
    return this.paused;
  }
  async setAgentsPaused() {
    if (this.flagFails) throw new TypeError("db down");
    this.flagWrites += 1;
    this.paused = true;
  }
  async monthUsage(_start: Date, _end: Date) {
    if (this.spendFails) throw new TypeError("db down");
    return { events: this.events, prices: this.prices };
  }
  async knownDeliveries(): Promise<Set<string>> {
    return new Set();
  }
}

class FakeGitHub implements SweeperGitHub {
  runs: ActiveRun[] = [];
  cancelled: number[] = [];
  dispatched: DispatchWorkflowInput[] = [];
  listedDeliveries = 0;
  /** Runs of the gc workflow already dispatched in the window. 0 lets the nightly gc dispatch. */
  existingDispatches = 0;
  async listActiveAgentRuns() {
    return this.runs;
  }
  async cancelRun(id: number): Promise<CancelResult> {
    this.cancelled.push(id);
    return "cancelled";
  }
  async dispatchWorkflow(input: DispatchWorkflowInput) {
    this.dispatched.push(input);
    return { runId: null };
  }
  async countDispatchedRuns() {
    return this.existingDispatches;
  }
  async listDeliveries(_since: Date): Promise<WebhookDelivery[]> {
    this.listedDeliveries += 1;
    return [];
  }
  async redeliver(_id: number) {}
}

// 06:20 UTC is inside the nightly gc window [06:15, 07:15).
const GC_TIME = "2026-11-10T06:20:00Z";

function sweepSetup(store: FakeSpendStore, now = "2026-11-10T12:00:00Z") {
  const sent: QueuedMessage[] = [];
  const gh = new FakeGitHub();
  const logs: string[] = [];
  const deps = {
    store,
    queue: { send: async (m: QueuedMessage) => void sent.push(m) },
    github: async () => gh,
    scheduledTime: at(now),
    now: at(now),
    log: (l: string) => logs.push(l),
  };
  return { sent, gh, logs, deps };
}

/** Stored costs that sum to `total` in November 2026, on the 2nd. */
const spendOf = (total: number): SpendEvent[] => [ev("2026-11-02T10:00:00Z", { costUsd: total })];

describe("runSweep spend cap", () => {
  it("under the cap: dispatches as usual, writes no flag", async () => {
    const store = new FakeSpendStore();
    store.tasks = [{ id: 4 }];
    store.events = spendOf(10);
    const { sent, logs, deps } = sweepSetup(store);
    const r = await runSweep(deps);
    expect(r.spend).toEqual({ month: "2026-11", spentUsd: 10, unpricedEvents: 0 });
    expect(r.capReached).toBe(false);
    expect(sent).toHaveLength(1);
    expect(store.flagWrites).toBe(0);
    expect(logs.some((l) => l.startsWith("spend_cap_reached"))).toBe(false);
  });

  it("at the cap: sets agents_paused once, logs the fixed code, sends no sweep message", async () => {
    const store = new FakeSpendStore();
    store.tasks = [{ id: 4 }, { id: 5 }];
    store.events = spendOf(50);
    const { sent, logs, gh, deps } = sweepSetup(store);
    gh.runs = [{ id: 7, path: ".github/workflows/agent-developer.yml", status: "in_progress" }];
    const r = await runSweep(deps);
    expect(r.capReached).toBe(true);
    expect(r.swept).toBe(0);
    expect(sent).toEqual([]);
    expect(store.flagWrites).toBe(1);
    expect(store.paused).toBe(true);
    expect(logs).toContain("spend_cap_reached month=2026-11 spent=50.00");
    // The existing pause part then cancels the runs still in flight (DESIGN §4.3 pause-all).
    expect(gh.cancelled).toEqual([7]);
    expect(r.paused).toBe(true);
  });

  it("over the cap: same decision, spent shown to the cent", async () => {
    const store = new FakeSpendStore();
    store.tasks = [{ id: 4 }];
    store.events = spendOf(61.234);
    const { sent, logs, deps } = sweepSetup(store);
    const r = await runSweep(deps);
    expect(r.capReached).toBe(true);
    expect(sent).toEqual([]);
    expect(logs).toContain("spend_cap_reached month=2026-11 spent=61.23");
  });

  it("already paused: no second write, still no dispatch, still logged", async () => {
    const store = new FakeSpendStore();
    store.tasks = [{ id: 4 }];
    store.paused = true;
    store.events = spendOf(55);
    const { sent, logs, deps } = sweepSetup(store);
    const r = await runSweep(deps);
    expect(store.flagWrites).toBe(0);
    expect(r.capReached).toBe(true);
    expect(sent).toEqual([]);
    expect(logs).toContain("spend_cap_reached month=2026-11 spent=55.00");
  });

  it("never auto-unpauses: a manual pause stays set when spend is under the cap", async () => {
    const store = new FakeSpendStore();
    store.tasks = [{ id: 4 }];
    store.paused = true;
    store.events = spendOf(3);
    const { sent, deps } = sweepSetup(store);
    const r = await runSweep(deps);
    expect(store.paused).toBe(true);
    expect(store.flagWrites).toBe(0);
    expect(r.capReached).toBe(false);
    // Under the cap the sweep behaves as before: messages go out and the graph answers paused.
    expect(sent).toHaveLength(1);
  });

  it("unpriced rows do not trip the cap and are reported", async () => {
    const store = new FakeSpendStore();
    store.tasks = [{ id: 4 }];
    store.events = [...spendOf(10), ev("2026-11-03T10:00:00Z", { model: "no-price", inputTokens: 9_999_999 })];
    const { sent, deps } = sweepSetup(store);
    const r = await runSweep(deps);
    expect(r.spend).toEqual({ month: "2026-11", spentUsd: 10, unpricedEvents: 1 });
    expect(r.capReached).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it("a failed spend read blocks sweep dispatch only: no flag write; gc and redeliver still run", async () => {
    const store = new FakeSpendStore();
    store.tasks = [{ id: 4 }];
    store.spendFails = true;
    const { sent, gh, deps } = sweepSetup(store, GC_TIME);
    gh.existingDispatches = 0;
    const r = await runSweep(deps);
    expect(r.failed.spend).toBe("TypeError");
    expect(r.spend).toBeNull();
    expect(r.capReached).toBe(false);
    expect(sent).toEqual([]);
    expect(store.flagWrites).toBe(0);
    expect(store.paused).toBe(false);
    expect(r.gc).toBe("dispatched");
    expect(gh.dispatched).toHaveLength(1);
    expect(gh.listedDeliveries).toBe(1);
    expect(r.failed.tasks).toBeUndefined();
  });

  it("a failed flag write blocks sweep dispatch only; gc and redeliver still run", async () => {
    const store = new FakeSpendStore();
    store.tasks = [{ id: 4 }];
    store.events = spendOf(60);
    store.flagFails = true;
    const { sent, gh, deps } = sweepSetup(store, GC_TIME);
    const r = await runSweep(deps);
    expect(r.failed.spend).toBe("TypeError");
    expect(r.capReached).toBe(true);
    expect(sent).toEqual([]);
    expect(store.paused).toBe(false);
    expect(r.gc).toBe("dispatched");
    expect(gh.listedDeliveries).toBe(1);
  });

  it("cap reached: gc and redeliver still run; only sweep messages are withheld", async () => {
    const store = new FakeSpendStore();
    store.tasks = [{ id: 4 }];
    store.events = spendOf(70);
    const { sent, gh, deps } = sweepSetup(store, GC_TIME);
    const r = await runSweep(deps);
    expect(r.capReached).toBe(true);
    expect(sent).toEqual([]);
    expect(r.gc).toBe("dispatched");
    expect(gh.dispatched).toHaveLength(1);
    expect(gh.listedDeliveries).toBe(1);
    expect(Object.keys(r.failed)).toEqual([]);
  });

  it("after a manual clear while still over the cap, the next sweep re-sets the flag (one write)", async () => {
    const store = new FakeSpendStore();
    store.tasks = [{ id: 4 }];
    store.events = spendOf(60);
    const { sent, deps } = sweepSetup(store);
    await runSweep(deps); // first sweep: sets the flag
    expect(store.flagWrites).toBe(1);
    store.paused = false; // the owner turns Agents back on while still over the cap
    const r = await runSweep(deps);
    expect(store.flagWrites).toBe(2);
    expect(store.paused).toBe(true);
    expect(r.capReached).toBe(true);
    expect(sent).toEqual([]);
    await runSweep(deps); // already set again: no further write
    expect(store.flagWrites).toBe(2);
  });

  it("the UTC month of the run decides: on 1 Nov, October spend does not count", async () => {
    const store = new FakeSpendStore();
    store.tasks = [{ id: 4 }];
    store.events = [ev("2026-10-31T20:00:00Z", { costUsd: 80 }), ev("2026-11-01T01:00:00Z", { costUsd: 5 })];
    const { sent, deps } = sweepSetup(store, "2026-11-01T01:15:00Z");
    const r = await runSweep(deps);
    expect(r.spend).toEqual({ month: "2026-11", spentUsd: 5, unpricedEvents: 0 });
    expect(r.capReached).toBe(false);
    expect(sent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- the SQL store (orch_rw on PGlite)

describe("sqlSweeperStore spend reads and flag write (orch_rw)", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await PGlite.create();
    await migrate(fromPglite(db));
    // Fixtures as superuser; the store then runs as orch_rw, which must hold the grants it uses.
    await db.exec(`
      INSERT INTO model_prices (provider, model, usd_per_mtok_in, usd_per_mtok_out, effective_from) VALUES
        ('acme', 'm1', 1, 2, '2026-01-01'),
        ('acme', 'm1', 3, 6, '2026-11-05'),
        ('acme', 'other', 100, 100, '2026-01-01');
      INSERT INTO usage_events (ts, kind, agent, provider, model, input_tokens, output_tokens, cost_usd) VALUES
        ('2026-10-31T23:00:00Z', 'model', 'developer', 'acme', 'm1', 1000000, 0, NULL),
        ('2026-11-02T10:00:00Z', 'model', 'developer', 'acme', 'm1', 1000000, 1000000, NULL),
        ('2026-11-06T10:00:00Z', 'model', 'qa', 'acme', 'm1', 1000000, 1000000, NULL),
        ('2026-11-07T10:00:00Z', 'model', 'qa', 'acme', 'nope', 5, 5, NULL),
        ('2026-11-08T10:00:00Z', 'model', 'orchestrator', 'acme', 'm1', 0, 0, 12.5);
    `);
    await db.exec("SET SESSION AUTHORIZATION orch_rw");
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  const store = () => sqlSweeperStore(fromPglite(db));

  it("monthUsage returns the month's model rows and the prices of their provider/model pairs", async () => {
    const { events, prices } = await store().monthUsage(at("2026-11-01T00:00:00Z"), at("2026-12-01T00:00:00Z"));
    expect(events.map((e) => e.model)).toEqual(["m1", "m1", "nope", "m1"]);
    expect(events[0]!.ts).toEqual(at("2026-11-02T10:00:00Z"));
    expect(events[3]!.costUsd).toBe(12.5);
    expect(prices.map((p) => [p.model, p.effectiveFrom, p.usdPerMtokIn])).toEqual([
      ["m1", "2026-01-01", 1],
      ["m1", "2026-11-05", 3],
    ]);
  });

  it("the store's rows give the same month-to-date spend as the pure rule", async () => {
    const usage = await store().monthUsage(at("2026-11-01T00:00:00Z"), at("2026-12-01T00:00:00Z"));
    const s = monthToDateSpend(usage.events, usage.prices, at("2026-11-10T00:00:00Z"));
    // 11-02: $1 + $2 at the Jan price = $3; 11-06: $3 + $6 at the Nov 5 price = $9; 11-08: stored $12.50; 11-07: unpriced.
    expect(s).toMatchObject({ month: "2026-11", events: 4, spentUsd: 24.5, unpricedEvents: 1 });
  });

  it("setAgentsPaused writes the flag as orch_rw; repeated writes keep one row (the store has no clear method)", async () => {
    expect(await store().isAgentsPaused()).toBe(false);
    await store().setAgentsPaused();
    await store().setAgentsPaused();
    expect(await store().isAgentsPaused()).toBe(true);
    const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM system_flags WHERE key = 'agents_paused'");
    expect(rows[0]!.n).toBe(1);
  });
});
