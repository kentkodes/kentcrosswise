// AR2 slice 2a: operation records (github_operations, migration 0012) make a re-run step reconcile
// instead of repeating a GitHub or planner effect. A step that throws loses its data (the graph
// keeps the previous checkpoint), so each test re-runs runStep from the same `data`, which is
// exactly what the redelivery does. Postgres is PGlite as orch_rw; GitHub is the fake.
import { PGlite } from "@electric-sql/pglite";
import type { MergeInput } from "@kcw/core/merge-input";
import { fromPglite, migrate } from "@kcw/db";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGitHubClient } from "../src/github";
import {
  DISPATCH_UNKNOWN_MINUTES,
  PgTaskStore,
  PlannerOutputError,
  initialTaskData,
  runStep,
  type Plan,
  type TaskData,
  type TaskGraphDeps,
  type TaskInput,
  type TaskStore,
} from "../src/graph";
import { servePglite, type PgSocketServer } from "./pg-socket";

const PLAN: Plan = { title: "Add a healthz page", body: "Add a /healthz route that returns ok." };
const HEAD = "a".repeat(40);
const clean = (pr: number, head: string): MergeInput => ({
  pr,
  headSha: head,
  planSummary: { format: 1, infra: [], artifact: { count: 1, kinds: { create: 0, update: 1, delete: 0, replace: 0 } } },
  lockDiff: { added: [], existing: [] },
  uncoveredPaths: [],
});
let seq = 0;
const start = (): TaskInput => ({ kind: "start", message_id: `m${++seq}` });
const sweep = (): TaskInput => ({ kind: "sweep", message_id: `m${++seq}` });

describe("operation records (AR2 slice 2a)", () => {
  let db: PGlite;
  let srv: PgSocketServer;
  let pool: pg.Pool;
  let store: PgTaskStore;
  let gh: FakeGitHubClient;
  let clock: Date;
  let lines: string[];
  let splitCalls: number;
  let planCalls: number;

  const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => {
    await db.query("RESET ROLE");
    try {
      return (await db.query<T>(text, params)).rows;
    } finally {
      await db.query("SET ROLE orch_rw");
    }
  };
  const newTask = async (): Promise<number> =>
    Number((await sql<{ id: string }>("INSERT INTO tasks (source, owner_text) VALUES ('console', 'Synthetic owner text') RETURNING id"))[0]!.id);
  const keys = async (id: number) =>
    (await sql<{ effect_key: string }>("SELECT effect_key FROM github_operations WHERE task_id = $1 ORDER BY effect_key", [id])).map((r) => r.effect_key);
  const op = async (key: string) => (await sql<{ state: string; result: unknown }>("SELECT state, result FROM github_operations WHERE effect_key = $1", [key]))[0];
  const advance = (minutes: number) => {
    clock = new Date(clock.getTime() + minutes * 60_000);
  };

  const deps = (over: Partial<TaskGraphDeps> = {}): TaskGraphDeps => ({
    github: gh,
    store,
    planner: {
      split: async (r) => {
        splitCalls += 1;
        return [r.owner_text];
      },
      plan: async () => {
        planCalls += 1;
        return PLAN;
      },
    },
    now: () => clock,
    log: (l) => lines.push(l),
    ...over,
  });
  /** The store with the first call of `method` (after the real work, like a lost connection) failing. */
  const failingAfter = <K extends keyof TaskStore>(method: K, when?: (...a: Parameters<TaskStore[K]>) => boolean): TaskStore => {
    let failed = false;
    return new Proxy(store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (prop !== method || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
        return async (...args: unknown[]) => {
          if (!failed && (when === undefined || when(...(args as Parameters<TaskStore[K]>)))) {
            failed = true;
            await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
            throw new Error("synthetic database failure");
          }
          return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        };
      },
    });
  };

  beforeAll(async () => {
    db = await PGlite.create();
    await migrate(fromPglite(db));
    srv = await servePglite(db, { role: "orch_rw" });
    pool = new pg.Pool({ connectionString: srv.url, max: 1 });
    store = new PgTaskStore(pool);
  }, 60_000);
  afterAll(async () => {
    await pool.end().catch(() => undefined);
    await srv.close();
    await db.close();
  });
  beforeEach(async () => {
    gh = new FakeGitHubClient();
    clock = new Date("2026-11-14T10:00:00Z");
    gh.now = () => clock;
    gh.registerRuns = true;
    lines = [];
    splitCalls = 0;
    planCalls = 0;
    await sql("UPDATE tasks SET status = 'done' WHERE status IN ('planning', 'in_progress', 'waiting')");
    await sql("UPDATE system_flags SET value = 'false' WHERE key = 'agents_paused'");
  });

  describe("issue", () => {
    it("a lost createIssue response: the re-run finds the marker and opens no second issue", async () => {
      const id = await newTask();
      const data = initialTaskData();
      gh.failAfterNext("createIssue");
      await expect(runStep(id, data, start(), deps())).rejects.toThrow(/createIssue/);
      expect(gh.issues).toHaveLength(1);
      expect(gh.issues[0]!.body).toContain(`<!-- kcw-op: task-${id}/issue/0 -->`);
      expect(await op(`task-${id}/issue/0`)).toMatchObject({ state: "intent" });

      const next = await runStep(id, data, start(), deps());
      expect(gh.issues).toHaveLength(1);
      expect(gh.dispatches).toHaveLength(1);
      expect(next).toMatchObject({ phase: "dev", issue_number: gh.issues[0]!.number });
      expect((await store.getTask(id))?.github_issue).toBe(gh.issues[0]!.number);
      expect(await op(`task-${id}/issue/0`)).toMatchObject({ state: "done", result: { number: gh.issues[0]!.number } });
    });

    it("a failed github_issue update after the issue exists: the re-run reuses the recorded number", async () => {
      const id = await newTask();
      const data = initialTaskData();
      const flaky = failingAfter("updateTask", (_i, f) => f.github_issue !== undefined);
      await expect(runStep(id, data, start(), deps({ store: flaky }))).rejects.toThrow("synthetic database failure");
      expect(gh.issues).toHaveLength(1);
      await runStep(id, data, start(), deps());
      expect(gh.issues).toHaveLength(1);
      expect(gh.calls.filter((c) => c.method === "listRecentIssues")).toHaveLength(0); // the record had the number
      expect(gh.dispatches).toHaveLength(1);
    });

    it("an intent whose issue was never created: the marker is not found and the re-run creates it", async () => {
      const id = await newTask();
      const data = initialTaskData();
      gh.failNext("createIssue", 503); // refused before it took effect
      await expect(runStep(id, data, start(), deps())).rejects.toThrow(/createIssue/);
      expect(gh.issues).toHaveLength(0);
      await runStep(id, data, start(), deps());
      expect(gh.issues).toHaveLength(1);
    });
  });

  describe("planner", () => {
    it("the planner is not called again when the step is re-run after its answers were recorded", async () => {
      const id = await newTask();
      const data = initialTaskData();
      gh.failNext("createIssue", 500); // the first external effect fails
      await expect(runStep(id, data, start(), deps())).rejects.toThrow(/createIssue/);
      expect([splitCalls, planCalls]).toEqual([1, 1]);
      expect(await op(`task-${id}/plan/0`)).toMatchObject({ state: "done", result: { subtasks: ["Synthetic owner text"], plan: PLAN } });
      await runStep(id, data, start(), deps());
      expect([splitCalls, planCalls]).toEqual([1, 1]);
      expect(gh.issues).toHaveLength(1);
    });

    it("a failure between the split and the title node reuses the recorded split", async () => {
      const id = await newTask();
      const data = initialTaskData();
      let first = true;
      const planner: TaskGraphDeps["planner"] = {
        split: deps().planner.split,
        // The title node fails on its first call only.
        plan: async () => {
          if (first) {
            first = false;
            throw new Error("synthetic model outage");
          }
          planCalls += 1;
          return PLAN;
        },
      };
      await expect(runStep(id, data, start(), deps({ planner }))).rejects.toThrow("synthetic model outage");
      expect(splitCalls).toBe(1);
      await runStep(id, data, start(), deps({ planner }));
      expect(splitCalls).toBe(1); // the recorded split was reused
      expect(planCalls).toBe(1);
    });
  });

  describe("replan", () => {
    it("a replan the owner approves is a new operation: new planner call, new plan and issue keys", async () => {
      const id = await newTask();
      let first = true;
      const planner: TaskGraphDeps["planner"] = {
        split: deps().planner.split,
        plan: async () => {
          planCalls += 1;
          if (first) {
            first = false;
            throw new PlannerOutputError("public_title", "synthetic invalid output");
          }
          return PLAN;
        },
      };
      let d = await runStep(id, initialTaskData(), start(), deps({ planner }));
      expect(d).toMatchObject({ phase: "owner", retry: "plan" });
      await sql("UPDATE approvals SET status = 'approved', decided_at = now() WHERE id = $1", [d.approval_id]);
      d = await runStep(id, d, { kind: "decision", approval_id: d.approval_id!, decision: "approved", message_id: `m${++seq}` }, deps({ planner }));
      expect(d.phase).toBe("dev");
      expect(planCalls).toBe(2);
      expect(await keys(id)).toEqual([`task-${id}/dispatch/0`, `task-${id}/issue/1`, `task-${id}/plan/0`, `task-${id}/plan/1`]);
    });
  });

  describe("dispatch", () => {
    it("a lost dispatch response: the re-run finds the run and dispatches nothing", async () => {
      const id = await newTask();
      const data = initialTaskData();
      gh.failAfterNext("dispatchWorkflow");
      await expect(runStep(id, data, start(), deps())).rejects.toThrow(/dispatchWorkflow/);
      expect(gh.dispatches).toHaveLength(1);
      const next = await runStep(id, data, start(), deps());
      expect(gh.dispatches).toHaveLength(1);
      expect(next.phase).toBe("dev");
      expect(await op(`task-${id}/dispatch/0`)).toMatchObject({ state: "done", result: { runId: gh.dispatches[0]!.runId } });
      expect(await sql("SELECT run_id::float8 AS run_id FROM agent_dispatches WHERE task_id = $1", [id])).toEqual([{ run_id: gh.dispatches[0]!.runId }]);
    });

    it("a database failure after the dispatch: the re-run reuses the recorded run id", async () => {
      const id = await newTask();
      const data = initialTaskData();
      const flaky = failingAfter("addEvent");
      await expect(runStep(id, data, start(), deps({ store: flaky }))).rejects.toThrow("synthetic database failure");
      expect(gh.dispatches).toHaveLength(1);
      await runStep(id, data, start(), deps());
      expect(gh.dispatches).toHaveLength(1);
      expect(gh.calls.filter((c) => c.method === "findWorkflowRun")).toHaveLength(0);
    });

    it("a run that is not visible yet: no redispatch, a sweep waits, then the run is linked", async () => {
      const id = await newTask();
      const data = initialTaskData();
      gh.hideRuns = true;
      gh.failAfterNext("dispatchWorkflow");
      await expect(runStep(id, data, start(), deps())).rejects.toThrow(/dispatchWorkflow/);
      const waiting = await runStep(id, data, start(), deps());
      expect(gh.dispatches).toHaveLength(1);
      expect(waiting).toMatchObject({ phase: "queued", last_outcome: "unchanged", pending_dispatch: { role: "dev", mode: "implement" } });

      advance(5);
      const still = await runStep(id, waiting, sweep(), deps());
      expect(gh.dispatches).toHaveLength(1);
      expect(still).toMatchObject({ phase: "queued", last_outcome: "unchanged" });

      gh.hideRuns = false;
      advance(1);
      const found = await runStep(id, still, sweep(), deps());
      expect(gh.dispatches).toHaveLength(1);
      expect(found).toMatchObject({ phase: "dev", pending_dispatch: null, last_outcome: "applied" });
      expect((await store.getTask(id))).toBeTruthy();
      expect(await sql("SELECT task_id::int AS task_id FROM agent_dispatches WHERE run_id = $1", [gh.dispatches[0]!.runId])).toEqual([{ task_id: id }]);
    });

    it(`a run that never appears goes to the owner ${DISPATCH_UNKNOWN_MINUTES} minutes after the intent, not to a new dispatch`, async () => {
      const id = await newTask();
      const data = initialTaskData();
      gh.hideRuns = true;
      gh.failAfterNext("dispatchWorkflow");
      await expect(runStep(id, data, start(), deps())).rejects.toThrow(/dispatchWorkflow/);
      let d = await runStep(id, data, start(), deps());
      advance(DISPATCH_UNKNOWN_MINUTES - 1);
      d = await runStep(id, d, sweep(), deps());
      expect(d.phase).toBe("queued");
      advance(1);
      d = await runStep(id, d, sweep(), deps());
      expect(d).toMatchObject({ phase: "owner", owner_wait: "failure", retry: "dev", pending_dispatch: null });
      expect(gh.dispatches).toHaveLength(1);
      const [approval] = await sql<{ reasons: string[] }>("SELECT reasons FROM approvals WHERE id = $1", [d.approval_id]);
      expect(approval!.reasons[0]).toContain("dispatch outcome is unknown");
      expect(lines).toContain(`task-${id}: dispatch_outcome_unknown role=developer`);
    });

    it("a dispatch error before any effect is not retried blindly either: it waits like an unknown outcome", async () => {
      const id = await newTask();
      const data = initialTaskData();
      gh.failNext("dispatchWorkflow", 502);
      await expect(runStep(id, data, start(), deps())).rejects.toThrow(/dispatchWorkflow/);
      const d = await runStep(id, data, start(), deps());
      expect(d.pending_dispatch).toMatchObject({ role: "dev" });
      expect(gh.dispatches).toHaveLength(0);
    });

    it("a deliberate Developer retry is a new operation with a new key and does dispatch", async () => {
      const id = await newTask();
      let d = await runStep(id, initialTaskData(), start(), deps());
      expect(d.phase).toBe("dev");
      d = await runStep(id, d, { kind: "github", event: "pull_request", action: "opened", pr_number: 9, head_ref: `kcw/task-${id}`, head_sha: HEAD, merged: false, message_id: `m${++seq}` }, deps());
      expect(d.phase).toBe("ci");
      d = await runStep(
        id,
        d,
        { kind: "github", event: "workflow_run", action: "completed", run_id: 1, workflow_path: ".github/workflows/ci.yml", conclusion: "failure", trigger: "pull_request", head_sha: HEAD, pr_numbers: [9], message_id: `m${++seq}` },
        deps(),
      );
      expect(d).toMatchObject({ phase: "dev", dev_mode: "fix", attempts: 1 });
      expect(gh.dispatches.map((x) => x.inputs.mode)).toEqual(["implement", "fix"]);
      expect(await keys(id)).toEqual([`task-${id}/dispatch/0`, `task-${id}/dispatch/1`, `task-${id}/issue/0`, `task-${id}/plan/0`]);
    });
  });

  describe("merge", () => {
    const qaDone = (id: number): TaskData => ({
      ...initialTaskData(),
      phase: "qa",
      issue_number: 1,
      issue_title: "Add a healthz page",
      pr_number: 5,
      head_sha: HEAD,
      ci: { sha: HEAD, result: "success" },
      waiting_since: clock.toISOString(),
      children: [id],
    });
    const approve = (): TaskInput => ({ kind: "github", event: "pull_request_review", action: "submitted", pr_number: 5, review_state: "approved", commit_id: HEAD, message_id: `m${++seq}` });
    const setup = () => {
      gh.prs.set(5, { headSha: HEAD, author: "kcw-developer[bot]", files: [{ path: "apps/web/src/app/healthz/route.ts", status: "added" }] });
      gh.artifacts.set(HEAD, clean(5, HEAD));
    };

    it("a lost merge response: the re-run sees the PR merged and continues as a successful merge", async () => {
      const id = await newTask();
      setup();
      const data = qaDone(id);
      gh.failAfterNext("merge");
      await expect(runStep(id, data, approve(), deps())).rejects.toThrow(/merge/);
      expect(gh.merges).toHaveLength(1);
      const next = await runStep(id, data, approve(), deps());
      expect(gh.merges).toHaveLength(1);
      expect(gh.calls.filter((c) => c.method === "merge")).toHaveLength(1);
      expect(next.phase).toBe("done");
      expect(await sql("SELECT status FROM tasks WHERE id = $1", [id])).toEqual([{ status: "merged" }]);
      expect(await op(`task-${id}/merge/0`)).toMatchObject({ state: "done", result: { merged: true, sha: gh.merges[0]!.sha } });
      expect(await sql("SELECT detail FROM agent_events WHERE task_id = $1 AND event_type = 'merged'", [id])).toEqual([{ detail: { pr: 5, sha: gh.merges[0]!.sha } }]);
    });

    it("a failure after the merge was recorded: the re-run uses the record", async () => {
      const id = await newTask();
      setup();
      const data = qaDone(id);
      const flaky = failingAfter("addEvent", (_t, _a, type) => type === "merged");
      await expect(runStep(id, data, approve(), deps({ store: flaky }))).rejects.toThrow("synthetic database failure");
      await runStep(id, data, approve(), deps());
      expect(gh.calls.filter((c) => c.method === "merge")).toHaveLength(1);
      expect(gh.calls.filter((c) => c.method === "getPrMergeState")).toHaveLength(0);
    });

    it("an intent with the PR not merged: the re-run merges as before", async () => {
      const id = await newTask();
      setup();
      const data = qaDone(id);
      gh.failNext("merge", 503); // not merged, the answer is an error
      await expect(runStep(id, data, approve(), deps())).rejects.toThrow(/merge/);
      expect(gh.merges).toHaveLength(0);
      const next = await runStep(id, data, approve(), deps());
      expect(gh.merges).toHaveLength(1);
      expect(next.phase).toBe("done");
    });

    it("a refused merge is recorded; a later merge of the task is a new operation", async () => {
      const id = await newTask();
      setup();
      gh.prs.get(5)!.mergeable = false;
      const d = await runStep(id, qaDone(id), approve(), deps());
      expect(d).toMatchObject({ phase: "owner", owner_wait: "failure" });
      expect(await op(`task-${id}/merge/0`)).toMatchObject({ state: "done", result: { merged: false, reason: "not_mergeable" } });
      expect(d.ops?.merge).toBe(1);
    });
  });

  describe("contradictory request under one key", () => {
    it("goes to the owner and sends nothing", async () => {
      const id = await newTask();
      await sql("INSERT INTO github_operations (effect_key, task_id, kind, request_hash, state) VALUES ($1, $2, 'issue', 'another-request', 'intent')", [`task-${id}/issue/0`, id]);
      const d = await runStep(id, initialTaskData(), start(), deps());
      expect(d).toMatchObject({ phase: "owner", owner_wait: "failure", retry: "plan" });
      expect(gh.issues).toHaveLength(0);
      expect(gh.dispatches).toHaveLength(0);
      const [approval] = await sql<{ reasons: string[] }>("SELECT reasons FROM approvals WHERE id = $1", [d.approval_id]);
      expect(approval!.reasons[0]).toContain("contradicts");
      // The record is untouched.
      expect(await op(`task-${id}/issue/0`)).toMatchObject({ state: "intent" });
      expect(d.ops).toEqual({ issue: 1 });
    });
  });
});
