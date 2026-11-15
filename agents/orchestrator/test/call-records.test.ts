import { PGlite } from "@electric-sql/pglite";
import { FakeProvider } from "@kcw/core/models";
import { fromPglite, migrate } from "@kcw/db";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FIXTURE_EXPECTED,
  FIXTURE_EXPECTED_AFTER_LATE_PRICE,
  FIXTURE_EXPECTED_AFTER_LATE_REPORT,
  FIXTURE_LATE_PRICE_SQL,
  FIXTURE_LATE_REPORT,
  FIXTURE_NOW,
  FIXTURE_PRICES_SQL,
  FIXTURE_USAGE_SQL,
} from "../../../packages/db/test/usage-fixtures";
import { PgTaskStore, reportPurpose } from "../src/graph/store";
import { trackPlannerCalls } from "../src/nodes/usage";
import { monthToDateSpend, utcMonth } from "../src/sweeper/spend";
import { sqlSweeperStore } from "../src/sweeper/store";
import { runSweep } from "../src/sweeper/sweep";

// AR3: planner call records through PgTaskStore.recordCall (as orch_rw) and the sweep's spending
// decision on the shared reconciliation fixture. Synthetic data only.
const LOGIN = "orch_calls_app";

describe("planner call records and the spending decision", () => {
  let lite: PGlite;
  let store: PgTaskStore;
  let task: number;

  beforeAll(async () => {
    lite = new PGlite();
    await migrate(fromPglite(lite));
    await lite.exec(`CREATE ROLE ${LOGIN} LOGIN; GRANT orch_rw TO ${LOGIN};`);
    task = Number((await lite.query<{ id: number }>("INSERT INTO tasks (source, owner_text) VALUES ('console', 'synthetic') RETURNING id")).rows[0]!.id);
    // A pool of one session, as orch_rw: enough for PgTaskStore.recordCall (pool.query only).
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        await lite.exec(`SET ROLE ${LOGIN}`);
        try {
          return await lite.query(text, values);
        } finally {
          await lite.exec("RESET ROLE");
        }
      },
    } as unknown as pg.Pool;
    store = new PgTaskStore(pool);
  });
  afterAll(async () => {
    await lite.close();
  });

  const rows = async (where: string) =>
    (await lite.query<Record<string, unknown>>(
      `SELECT agent, purpose, task_id::int AS task_id, outcome, input_tokens, output_tokens FROM usage_events WHERE ${where} ORDER BY ts, outcome`)).rows;

  it("each planner call is one row with purpose plan and the request's task; a failed one stays unknown", async () => {
    const logs: string[] = [];
    const tracker = trackPlannerCalls((e) => store.recordCall("orchestrator", e), (l) => logs.push(l));
    let n = 0;
    const provider = new FakeProvider({
      onCall: tracker.onCall,
      complete: () => (n++ === 0 ? { text: '{"subtasks": ["a"]}', tokens: { input: 40, output: 9 } } : new Error("timeout")),
    });
    const inner = {
      split: async () => {
        await provider.complete({ prompt: "p" });
        return ["a"];
      },
      plan: async () => {
        await provider.complete({ prompt: "p" });
        return { title: "t", body: "b" } as never;
      },
    };
    const planner = tracker.planner(inner);
    await planner.split({ task_id: task } as never);
    await expect(planner.plan({ task_id: task } as never)).rejects.toThrow("timeout");
    expect(await rows("agent = 'orchestrator'")).toEqual([
      { agent: "orchestrator", purpose: "plan", task_id: task, outcome: "reported", input_tokens: 40, output_tokens: 9 },
      { agent: "orchestrator", purpose: "plan", task_id: task, outcome: "unknown", input_tokens: null, output_tokens: null },
    ]);
    // Outside a node call: still recorded (it may be billed), without a task, and logged.
    await provider.complete({ prompt: "p" }).catch(() => undefined);
    expect(await rows("agent = 'orchestrator' AND task_id IS NULL")).toHaveLength(1);
    expect(logs).toEqual(["model call outside a task (fake): recorded without a task"]);
    await lite.exec("DELETE FROM usage_events");
  });

  it("report usage lines take their purpose from the call's job", () => {
    expect(reportPurpose("report:123:2:work:0")).toBe("work");
    expect(reportPurpose("report:123:2:review:4")).toBe("review");
    expect(reportPurpose("github:workflow_run:1:1")).toBeNull();
  });

  it("the sweep's spend on the shared fixture: unpriced and unknown counted apart; a late price and a late report apply", async () => {
    await lite.exec(FIXTURE_PRICES_SQL + FIXTURE_USAGE_SQL);
    const sweeper = sqlSweeperStore(fromPglite(lite));
    const spendNow = async () => {
      const { start, end } = utcMonth(FIXTURE_NOW);
      const u = await sweeper.monthUsage(start, end);
      const s = monthToDateSpend(u.events, u.prices, FIXTURE_NOW);
      return { events: s.events, spentUsd: s.spentUsd, unpricedEvents: s.unpricedEvents, unknownEvents: s.unknownEvents };
    };
    expect(await spendNow()).toEqual(FIXTURE_EXPECTED);
    await lite.exec(FIXTURE_LATE_PRICE_SQL);
    expect(await spendNow()).toEqual(FIXTURE_EXPECTED_AFTER_LATE_PRICE);
    // The late report of the unknown call, written twice (a duplicate): one row, counted once.
    const late = { phase: "end", callId: FIXTURE_LATE_REPORT.callId, provider: "acme", model: "m1", operation: "complete", outcome: "reported", inputTokens: FIXTURE_LATE_REPORT.inputTokens, outputTokens: FIXTURE_LATE_REPORT.outputTokens } as const;
    await store.recordCall("orchestrator", late);
    await store.recordCall("orchestrator", late);
    expect(await spendNow()).toEqual(FIXTURE_EXPECTED_AFTER_LATE_REPORT);
  });

  it("the cap log line and the run summary carry the unpriced and unknown counts", async () => {
    const logs: string[] = [];
    const events = [
      { ts: new Date("2026-11-02T00:00:00Z"), provider: "a", model: "m", inputTokens: null, outputTokens: null, costUsd: 60 },
      { ts: new Date("2026-11-02T00:00:00Z"), provider: "a", model: "none", inputTokens: 1, outputTokens: 1, costUsd: null },
      { ts: new Date("2026-11-02T00:00:00Z"), provider: "a", model: "m", inputTokens: null, outputTokens: null, costUsd: null, outcome: "unknown" as const },
    ];
    let paused = false;
    const fakeStore = {
      listSweepTasks: async () => [],
      isAgentsPaused: async () => paused,
      setAgentsPaused: async () => void (paused = true),
      monthUsage: async () => ({ events, prices: [] }),
      knownDeliveries: async () => new Set<string>(),
      listUnsentOutbox: async () => [],
      markOutboxSent: async () => undefined,
      recordOutboxFailure: async () => undefined,
    };
    const gh = {
      listActiveAgentRuns: async () => [],
      cancelRun: async () => "cancelled" as const,
      dispatchWorkflow: async () => ({ runId: null }),
      countDispatchedRuns: async () => 1,
      listDeliveries: async () => [],
      redeliver: async () => undefined,
    };
    const r = await runSweep({
      store: fakeStore as never,
      queue: { send: async () => undefined },
      github: async () => gh as never,
      scheduledTime: new Date("2026-11-10T12:00:00Z"),
      now: new Date("2026-11-10T12:00:00Z"),
      log: (l) => logs.push(l),
    });
    expect(r.spend).toEqual({ month: "2026-11", spentUsd: 60, unpricedEvents: 1, unknownEvents: 1 });
    expect(logs).toContain("spend_cap_reached month=2026-11 spent=60.00 unpriced=1 unknown=1");
    expect(logs.some((l) => l.includes("unpriced=1 unknown=1 cap=reached"))).toBe(true);
  });
});
