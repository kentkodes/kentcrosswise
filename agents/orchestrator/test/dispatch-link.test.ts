// RUN-ID-MAPPING-SPEC §2 and §4: every agent dispatch whose run id came back stores the run -> task
// link (agent_dispatches, migration 0010) before the task event, through the real PgTaskStore SQL
// as orch_rw; a null run id stores nothing. Plus: a late `requested` never regresses a completed run.
import { PGlite } from "@electric-sql/pglite";
import { fromPglite, migrate } from "@kcw/db";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGitHubClient } from "../src/github";
import {
  DispatchLinkConflictError,
  PgTaskStore,
  agentRoleOfWorkflow,
  initialTaskData,
  runStep,
  type TaskData,
  type TaskGraphDeps,
  type TaskInput,
  type TaskStore,
} from "../src/graph";

describe("dispatch links (agent_dispatches)", () => {
  let db: PGlite;
  let pgStore: PgTaskStore;
  let gh: FakeGitHubClient;
  let calls: string[];
  let lines: string[];
  const now = new Date("2026-10-28T12:00:00Z");
  const longAgo = "2026-10-28T08:00:00.000Z"; // past every wait limit

  /** Superuser SQL for setup and assertions; the store itself runs as orch_rw. */
  async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    await db.query("RESET ROLE");
    try {
      return (await db.query<T>(text, params)).rows;
    } finally {
      await db.query("SET ROLE orch_rw");
    }
  }

  /** The store with every method call recorded, so the order of effects can be checked. */
  function recording(store: TaskStore): TaskStore {
    return new Proxy(store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          calls.push(String(prop));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  }

  const deps = (): TaskGraphDeps => ({
    github: gh,
    store: recording(pgStore),
    planner: { split: async () => [], plan: async () => ({ title: "Synthetic", body: "Synthetic" }) },
    now: () => now,
    log: (l) => lines.push(l),
  });
  const sweep: TaskInput = { kind: "sweep", message_id: "sweep" };
  const links = () =>
    sql<{ run_id: number; task_id: number; role: string }>(
      "SELECT run_id::float8 AS run_id, task_id::int AS task_id, role FROM agent_dispatches ORDER BY dispatched_at, run_id",
    );

  beforeAll(async () => {
    db = new PGlite();
    await migrate(fromPglite(db));
    // Task ids 1..4 (identity).
    await db.query("INSERT INTO tasks (source, owner_text) SELECT 'console', 'Synthetic task' FROM generate_series(1, 4)");
    await db.query("SET ROLE orch_rw");
    pgStore = new PgTaskStore({ query: (text: string, params?: unknown[]) => db.query(text, params) } as unknown as pg.Pool);
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    gh = new FakeGitHubClient();
    calls = [];
    lines = [];
    await sql("DELETE FROM agent_dispatches");
    await sql("UPDATE system_flags SET value = 'false' WHERE key = 'agents_paused'");
  });

  /** The store calls of the step from the dispatch's link on: the link comes before the event and the phase change. */
  function expectLinkBeforeEvent(): void {
    const at = calls.indexOf("recordDispatch");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("addEvent")).toBeGreaterThan(at);
    expect(calls.indexOf("updateTask")).toBeGreaterThan(at);
  }

  it("maps every agent workflow file to its role, and nothing else", () => {
    expect(agentRoleOfWorkflow("agent-developer.yml")).toBe("developer");
    expect(agentRoleOfWorkflow("agent-qa.yml")).toBe("qa");
    expect(agentRoleOfWorkflow("agent-docs.yml")).toBe("docs");
    expect(agentRoleOfWorkflow("agent-scraper.yml")).toBe("scraper");
    for (const other of ["preview-gc.yml", "ci.yml", "agent-developer.yaml", ".github/workflows/agent-qa.yml", "agent-other.yml"]) {
      expect(agentRoleOfWorkflow(other)).toBeNull();
    }
  });

  it("dispatchDev records the developer link before the task event", async () => {
    const data: TaskData = { ...initialTaskData(), phase: "dev", waiting_since: longAgo, issue_number: 5 };
    const next = await runStep(1, data, sweep, deps());
    expect(gh.dispatches.map((d) => d.workflow)).toEqual(["agent-developer.yml"]);
    expect(next.redispatched).toBe(true);
    expectLinkBeforeEvent();
    expect(await links()).toEqual([{ run_id: gh.dispatches[0]!.runId, task_id: 1, role: "developer" }]);
  });

  it("dispatchQa records the qa link before the task event", async () => {
    const data: TaskData = { ...initialTaskData(), phase: "qa", waiting_since: longAgo, issue_number: 5, pr_number: 7 };
    await runStep(2, data, sweep, deps());
    expect(gh.dispatches.map((d) => d.workflow)).toEqual(["agent-qa.yml"]);
    expectLinkBeforeEvent();
    expect(await links()).toEqual([{ run_id: gh.dispatches[0]!.runId, task_id: 2, role: "qa" }]);
  });

  it("dispatchDocs records the docs link before the task event", async () => {
    const data: TaskData = { ...initialTaskData(), kind: "docs", docs_pr: 9, phase: "dev", waiting_since: longAgo };
    await runStep(3, data, sweep, deps());
    expect(gh.dispatches.map((d) => d.workflow)).toEqual(["agent-docs.yml"]);
    expectLinkBeforeEvent();
    expect(await links()).toEqual([{ run_id: gh.dispatches[0]!.runId, task_id: 3, role: "docs" }]);
  });

  it("a null run id stores no link; the dispatch, event and phase change still happen", async () => {
    gh.runIdMode = "null";
    const data: TaskData = { ...initialTaskData(), phase: "dev", waiting_since: longAgo, issue_number: 5 };
    const next = await runStep(1, data, sweep, deps());
    expect(gh.dispatches).toHaveLength(1);
    expect(calls).not.toContain("recordDispatch");
    expect(calls).toContain("addEvent");
    expect(next.redispatched).toBe(true);
    expect(await links()).toEqual([]);
  });

  it("recording the same link again is a no-op (a re-run step)", async () => {
    await pgStore.recordDispatch(500, 1, "developer");
    await pgStore.recordDispatch(500, 1, "developer");
    expect(await links()).toEqual([{ run_id: 500, task_id: 1, role: "developer" }]);
  });

  it.each([
    ["another task", 2, "developer"],
    ["another role", 1, "qa"],
  ] as const)("a conflicting link (%s) throws a fixed code and keeps the first row", async (_label, taskId, role) => {
    await pgStore.recordDispatch(600, 1, "developer");
    const err = await pgStore.recordDispatch(600, taskId, role).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DispatchLinkConflictError);
    expect(err).toMatchObject({ code: "dispatch_link_conflict", message: "dispatch_link_conflict" });
    expect(await links()).toEqual([{ run_id: 600, task_id: 1, role: "developer" }]);
  });

  it("a conflicting link is logged as dispatch_link_failed and the step continues (one dispatch)", async () => {
    gh = new FakeGitHubClient({ firstRunId: 880001 }); // the run id the dispatch below gets
    await pgStore.recordDispatch(880001, 4, "developer");
    const data: TaskData = { ...initialTaskData(), phase: "dev", waiting_since: longAgo, issue_number: 5 };
    const next = await runStep(1, data, sweep, deps());
    expect(gh.dispatches).toHaveLength(1);
    expect(calls.indexOf("addEvent")).toBeGreaterThan(calls.indexOf("recordDispatch"));
    expect(calls).toContain("updateTask");
    expect(next.redispatched).toBe(true);
    expect(next.phase).toBe("dev");
    expect(lines).toEqual(["task-1: dispatch_link_failed role=developer reason=conflict"]);
    expect(await links()).toEqual([{ run_id: 880001, task_id: 4, role: "developer" }]);
  });

  it("a database error while linking is logged with a fixed code only and the step continues", async () => {
    const store = recording(pgStore);
    const failing: TaskStore = Object.assign(Object.create(store) as TaskStore, {
      recordDispatch: async () => {
        calls.push("recordDispatch");
        throw Object.assign(new Error("synthetic connection detail 880002"), { name: "DatabaseError" });
      },
    });
    const data: TaskData = { ...initialTaskData(), phase: "qa", waiting_since: longAgo, issue_number: 5, pr_number: 7 };
    const next = await runStep(2, data, sweep, { ...deps(), store: failing });
    expect(gh.dispatches.map((d) => d.workflow)).toEqual(["agent-qa.yml"]);
    expect(calls.indexOf("addEvent")).toBeGreaterThan(calls.indexOf("recordDispatch"));
    expect(next.redispatched).toBe(true);
    expect(lines).toEqual(["task-2: dispatch_link_failed role=qa reason=db"]);
    expect(lines.join(" ")).not.toMatch(/synthetic|880002|DatabaseError/);
    expect(await links()).toEqual([]);
  });

  it("a step re-run for another failure after a failed link dispatches again and links the new run", async () => {
    // A failed link alone never fails the step (above). If a later effect fails (here the event
    // write), the message is retried and the step re-runs as a whole: a repeated dispatch is the
    // accepted cost (machine.ts header), and the new run gets its link.
    gh = new FakeGitHubClient({ firstRunId: 890001 });
    let linkFails = true;
    let eventFails = true;
    const store = recording(pgStore);
    const flaky: TaskStore = Object.assign(Object.create(store) as TaskStore, {
      recordDispatch: async (runId: number, taskId: number, role: "developer") => {
        if (linkFails) {
          linkFails = false;
          calls.push("recordDispatch");
          throw new Error("synthetic");
        }
        return store.recordDispatch(runId, taskId, role);
      },
      addEvent: async (...args: Parameters<TaskStore["addEvent"]>) => {
        if (eventFails) {
          eventFails = false;
          throw new Error("synthetic event failure");
        }
        return store.addEvent(...args);
      },
    });
    const data: TaskData = { ...initialTaskData(), phase: "dev", waiting_since: longAgo, issue_number: 5 };
    await expect(runStep(1, data, sweep, { ...deps(), store: flaky })).rejects.toThrow("synthetic event failure");
    const next = await runStep(1, data, sweep, { ...deps(), store: flaky });
    expect(next.redispatched).toBe(true);
    expect(gh.dispatches.map((d) => d.runId)).toEqual([890001, 890002]);
    expect(lines).toEqual(["task-1: dispatch_link_failed role=developer reason=db"]);
    expect(await links()).toEqual([{ run_id: 890002, task_id: 1, role: "developer" }]);
  });

  it("stores the link as orch_rw, which can read and insert but not update or delete it", async () => {
    await pgStore.recordDispatch(700, 1, "developer");
    await expect(db.query("UPDATE agent_dispatches SET task_id = 2 WHERE run_id = 700")).rejects.toThrow(/permission denied/);
    await expect(db.query("DELETE FROM agent_dispatches WHERE run_id = 700")).rejects.toThrow(/permission denied/);
  });
});

describe("a requested delivery after completed (redelivery order, spec §4)", () => {
  let db: PGlite;
  let store: PgTaskStore;
  const observation = (action: "requested" | "completed", messageId: string): TaskInput => ({
    kind: "github",
    event: "workflow_run",
    action,
    run_id: 40526955264,
    run_attempt: 1,
    agent_task_id: 1,
    workflow_path: ".github/workflows/agent-developer.yml",
    head_branch: "main",
    trigger: "workflow_dispatch",
    head_sha: "a".repeat(40),
    pr_numbers: [],
    run_started_at: "2026-10-28T10:00:02Z",
    updated_at: "2026-10-28T10:20:00Z",
    conclusion: action === "completed" ? "success" : null,
    message_id: messageId,
  });

  beforeAll(async () => {
    db = new PGlite();
    await migrate(fromPglite(db));
    await db.query("INSERT INTO tasks (source, owner_text) VALUES ('console', 'Synthetic task')");
    await db.query("SET ROLE orch_rw");
    store = new PgTaskStore({ query: (text: string, params?: unknown[]) => db.query(text, params) } as unknown as pg.Pool);
  });
  afterAll(async () => {
    await db.close();
  });

  it("does not regress the completed run or the task state", async () => {
    const deps: TaskGraphDeps = {
      github: new FakeGitHubClient(),
      store,
      planner: { split: async () => [], plan: async () => ({ title: "Synthetic", body: "Synthetic" }) },
    };
    const data: TaskData = { ...initialTaskData(), phase: "qa", pr_number: 7, waiting_since: "2026-10-28T10:00:00.000Z" };
    const afterCompleted = await runStep(1, data, observation("completed", "m-completed"), deps);
    const read = () =>
      db.query<Record<string, unknown>>(
        `SELECT requested_at, completed_at, conclusion, office_version::int AS v FROM agent_runs WHERE run_id = 40526955264 AND run_attempt = 1`,
      );
    const before = (await read()).rows;
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ requested_at: null, conclusion: "success", v: 1 });

    const afterRequested = await runStep(1, afterCompleted, observation("requested", "m-requested"), deps);
    expect((await read()).rows).toEqual(before);
    expect(afterRequested.last_outcome).toBe("unchanged");
    const { last_message_id: _a, last_outcome: _b, ...restBefore } = afterCompleted;
    const { last_message_id: _c, last_outcome: _d, ...restAfter } = afterRequested;
    expect(restAfter).toEqual(restBefore);
    expect(restAfter.phase).toBe("qa");
  });
});
