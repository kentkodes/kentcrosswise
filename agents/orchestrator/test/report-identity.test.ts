// AR2 slice 3 evidence: atomic reports and accounting identities, on the real store as orch_rw
// (PGlite over the wire protocol) through the SQS handler with consumer receipts. A pool wrapper
// fails one chosen statement once, to cut a report or a step part-way.
import { PGlite } from "@electric-sql/pglite";
import { fromPglite, migrate } from "@kcw/db";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGitHubClient } from "../src/github";
import {
  PgReceiptStore,
  PgTaskStore,
  WAIT_LIMIT_MINUTES,
  buildTaskGraph,
  handleTaskSqsEvent,
  initialTaskData,
  type TaskGraph,
  type TaskGraphDeps,
} from "../src/graph";
import { checkpointerFromPool, setupCheckpointer, threadConfig } from "../src/index";
import { servePglite, type PgSocketServer } from "./pg-socket";

const PLAN = { title: "Add a healthz page", body: "Add a /healthz route that returns ok." };
const line = (model: string, input: number) => ({ kind: "model", provider: "anthropic", model, input_tokens: input, output_tokens: 1 });

describe("agent reports (AR2 slice 3)", () => {
  let db: PGlite;
  let srv: PgSocketServer;
  let pool: pg.Pool;
  let graph: TaskGraph;
  let gh: FakeGitHubClient;
  let clock: Date;
  /** The next statement matching this pattern throws once (through pool.query or a client). */
  let failOn: RegExp | null = null;
  let plan = PLAN;
  let seq = 0;
  let runSeq = 7000;
  const deps: TaskGraphDeps = {
    github: new FakeGitHubClient(),
    store: undefined as unknown as PgTaskStore,
    planner: { split: async (r) => [r.owner_text], plan: async () => plan },
    now: () => clock,
  };

  const maybeFail = (text: unknown) => {
    if (failOn !== null && typeof text === "string" && failOn.test(text)) {
      failOn = null;
      throw new Error("synthetic failure part-way");
    }
  };

  const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => {
    await db.query("RESET ROLE");
    try {
      return (await db.query<T>(text, params)).rows;
    } finally {
      await db.query("SET ROLE orch_rw");
    }
  };

  beforeAll(async () => {
    db = await PGlite.create();
    await migrate(fromPglite(db));
    await db.query("INSERT INTO contacts (name, aliases) VALUES ('Jane Doe', '{Janie}')"); // synthetic
    srv = await servePglite(db, { role: "orch_rw" });
    pool = new pg.Pool({ connectionString: srv.url, max: 1 });
    await setupCheckpointer(pool);
    const failing = {
      query: (text: string, params?: unknown[]) => {
        maybeFail(text);
        return pool.query(text, params);
      },
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (text: string, params?: unknown[]) => {
            maybeFail(text);
            return client.query(text, params);
          },
          release: () => client.release(),
        };
      },
    } as unknown as pg.Pool;
    deps.store = new PgTaskStore(failing);
    graph = buildTaskGraph(checkpointerFromPool(pool), deps);
  }, 60_000);

  afterAll(async () => {
    await pool.end().catch(() => undefined);
    await srv.close();
    await db.close();
  });

  beforeEach(async () => {
    gh = new FakeGitHubClient();
    deps.github = gh;
    clock = new Date("2026-11-14T10:00:00Z");
    gh.now = () => clock;
    failOn = null;
    plan = PLAN;
    await sql("UPDATE tasks SET status = 'done' WHERE status IN ('planning', 'in_progress', 'waiting')");
  });

  /** One message through the handler with consumer receipts; its outcome, or "failed" (back to the queue). */
  async function send(taskId: number, body: unknown, messageId = `m${++seq}`, receipts = true): Promise<string> {
    const lines: string[] = [];
    const res = await handleTaskSqsEvent(
      { Records: [{ messageId, body: JSON.stringify(body), attributes: { MessageGroupId: `task-${taskId}` } }] },
      { graph, log: (l) => lines.push(l), ...(receipts && { receipts: new PgReceiptStore(pool) }) },
    );
    if (res.batchItemFailures.length > 0) return "failed";
    const last = lines.at(-1)!;
    return last.slice(last.indexOf(": ") + 2);
  }

  async function newTask(): Promise<number> {
    const [row] = await sql<{ id: string }>("INSERT INTO tasks (source, owner_text, is_private) VALUES ('console', 'Add a healthz page please', true) RETURNING id");
    const id = Number(row!.id);
    await sql("UPDATE tasks SET thread_id = 'task-' || id WHERE id = $1", [id]);
    return id;
  }

  /** A task started and waiting on the Developer (its first dispatch is op 0). */
  async function inDev(): Promise<number> {
    const id = await newTask();
    expect(await send(id, { type: "task.created", task_id: id })).toBe("started");
    return id;
  }

  const report = (taskId: number, fields: Record<string, unknown>) => ({
    task_id: taskId, agent: "developer", run_id: ++runSeq, run_attempt: 1, job: "end", op: 0, ...fields,
  });
  const usageRows = (taskId: number) =>
    sql<{ dedupe_key: string; model: string; input_tokens: number }>(
      "SELECT dedupe_key, model, input_tokens FROM usage_events WHERE task_id = $1 ORDER BY dedupe_key", [taskId]);
  const events = async (taskId: number, type: string) =>
    (await sql<{ n: number }>("SELECT count(*)::int AS n FROM agent_events WHERE task_id = $1 AND event_type = $2", [taskId, type]))[0]!.n;
  const receipt = async (key: string) =>
    (await sql("SELECT 1 FROM orchestrator_receipts WHERE message_key = $1", [key])).length;

  it("a multi-line report that fails part-way writes nothing; its redelivery completes it exactly once", async () => {
    const id = await inDev();
    const body = report(id, {
      event_type: "failed",
      usage: [
        { ...line("model-a", 10), call: { job: "work", index: 0 } },
        { ...line("model-a", 20), call: { job: "work", index: 1 } }, // same model, separate call
        { ...line("model-b", 30), call: { job: "review", index: 0 } },
      ],
    });
    const key = `report:${body.run_id}:1:end`;
    failOn = /INSERT INTO usage_events/;
    expect(await send(id, body, "r-1")).toBe("failed");
    failOn = /INSERT INTO agent_events/; // the event, after all three usage lines
    expect(await send(id, body, "r-1")).toBe("failed");
    expect(await usageRows(id)).toEqual([]);
    expect(await events(id, "failed")).toBe(0);
    expect(await receipt(key)).toBe(0);

    expect(await send(id, body, "r-1")).toBe("recovered"); // SQS redelivers the same message
    const rows = [
      { dedupe_key: `report:${body.run_id}:1:review:0`, model: "model-b", input_tokens: 30 },
      { dedupe_key: `report:${body.run_id}:1:work:0`, model: "model-a", input_tokens: 10 },
      { dedupe_key: `report:${body.run_id}:1:work:1`, model: "model-a", input_tokens: 20 },
    ];
    expect(await usageRows(id)).toEqual(rows);
    expect(await events(id, "failed")).toBe(1);
    expect(await receipt(key)).toBe(1);

    // A retry under a new SQS message id (a resend after the dedupe window), with and without the
    // consumer's receipt check, writes nothing twice.
    expect(await send(id, body, "r-2")).toBe("duplicate");
    expect(await send(id, body, "r-3", false)).toBe("duplicate");
    expect(await usageRows(id)).toEqual(rows);
    expect(await events(id, "failed")).toBe(1);
  });

  it("a genuine re-run (a new run attempt) counts separately; the same attempt does not", async () => {
    const id = await inDev();
    const first = report(id, { usage: [{ ...line("model-a", 10), call: { job: "work", index: 0 } }] });
    expect(await send(id, first)).toBe("unchanged");
    expect(await send(id, first)).toBe("duplicate");
    expect(await send(id, { ...first, run_attempt: 2 })).toBe("unchanged");
    expect((await usageRows(id)).map((r) => r.dedupe_key)).toEqual([`report:${first.run_id}:1:work:0`, `report:${first.run_id}:2:work:0`]);
  });

  it("late usage after the task ended is recorded once and changes nothing else", async () => {
    const id = await newTask();
    await sql("UPDATE tasks SET status = 'merged' WHERE id = $1", [id]);
    await graph.invoke({ task_id: id, task: { ...initialTaskData(), phase: "done" }, input: { kind: "sweep", message_id: "ended" } }, threadConfig(id));
    const late = report(id, { agent: "qa", event_type: "failed", usage: [{ ...line("model-q", 5), call: { job: "review", index: 0 } }] });
    expect(await send(id, late)).toBe("stale");
    expect(await send(id, late)).toBe("duplicate");
    expect(await send(id, { ...late, run_id: ++runSeq, event_type: undefined })).toBe("unchanged"); // usage-only
    expect(await usageRows(id)).toHaveLength(2);
    expect(await events(id, "failed")).toBe(0);
    expect(await sql("SELECT status FROM tasks WHERE id = $1", [id])).toEqual([{ status: "merged" }]);
    expect((await graph.getState(threadConfig(id))).values.task.phase).toBe("done");
  });

  it("a report from an obsolete op records its usage but has no lifecycle effect", async () => {
    const id = await inDev();
    clock = new Date(clock.getTime() + (WAIT_LIMIT_MINUTES.dev + 1) * 60_000);
    expect(await send(id, { type: "sweep", task_id: id, thread_id: `task-${id}` })).toBe("applied"); // redispatch: op 1
    expect(gh.dispatches.map((d) => d.inputs.op)).toEqual(["0", "1"]);

    const old = report(id, { op: 0, event_type: "coding", usage: [{ ...line("model-a", 3), call: { job: "work", index: 0 } }] });
    expect(await send(id, old)).toBe("stale");
    expect(await events(id, "coding")).toBe(0);
    expect(await usageRows(id)).toHaveLength(1);
    const current = report(id, { op: 1, job: "start", event_type: "coding" });
    expect(await send(id, current)).toBe("applied");
    expect(await events(id, "coding")).toBe(1);
    expect(await sql("SELECT status, waiting_on FROM tasks WHERE id = $1", [id])).toEqual([{ status: "waiting", waiting_on: "dev" }]);
  });

  it("a step re-run after a crash writes its approval, inbox item and event once", async () => {
    plan = { title: "Healthz", body: "Ask Jane Doe about the route." }; // fails the sanitizer: issue_text approval
    const id = await newTask();
    failOn = /UPDATE tasks SET status = \$/; // enter("owner"), after the approval and its event
    expect(await send(id, { type: "task.created", task_id: id }, "c-1")).toBe("failed");
    expect(await send(id, { type: "task.created", task_id: id }, "c-1")).toBe("recovered");
    const approvals = await sql<{ id: string }>("SELECT id FROM approvals WHERE task_id = $1", [id]);
    expect(approvals).toHaveLength(1);
    expect(await sql("SELECT count(*)::int AS n FROM inbox_items WHERE ref_id = $1", [approvals[0]!.id])).toEqual([{ n: 1 }]);
    expect(await events(id, "waiting_on_owner")).toBe(1);
    const task = (await graph.getState(threadConfig(id))).values.task;
    expect(task).toMatchObject({ phase: "owner", approval_id: approvals[0]!.id });
  });
});
