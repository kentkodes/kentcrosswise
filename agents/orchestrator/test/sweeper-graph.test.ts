// What the task graph does with the sweeper's messages for stale `planning` tasks (P2-17): a start
// whose step failed and whose message is used up is completed by the next sweep, without a second
// issue; a sweep for a task without a thread changes nothing. PGlite + the real graph, fake GitHub.
import { PGlite } from "@electric-sql/pglite";
import { fromPglite, migrate } from "@kcw/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkpointerFromPool, setupCheckpointer } from "../src/index";
import { FakeGitHubClient } from "../src/github";
import { PgTaskStore, buildTaskGraph, handleTaskSqsEvent, type TaskGraph, type TaskGraphDeps } from "../src/graph";
import { sqlSweeperStore, sweepDedupeId, runSweep, type QueuedMessage } from "../src/sweeper";
import { servePglite, type PgSocketServer } from "./pg-socket";

describe("sweeps for stale planning tasks", () => {
  let db: PGlite;
  let srv: PgSocketServer;
  let pool: pg.Pool;
  let graph: TaskGraph;
  const gh = new FakeGitHubClient();
  const clock = new Date("2026-10-23T10:00:00Z");
  const deps: TaskGraphDeps = {
    github: gh,
    store: undefined as unknown as PgTaskStore,
    planner: { plan: async () => ({ title: "Add a healthz page", body: "Add a /healthz route that returns ok." }) },
    now: () => clock,
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
    srv = await servePglite(db, { role: "orch_rw" });
    pool = new pg.Pool({ connectionString: srv.url, max: 1 });
    await setupCheckpointer(pool);
    deps.store = new PgTaskStore(pool);
    graph = buildTaskGraph(checkpointerFromPool(pool), deps);
  }, 60_000);

  afterAll(async () => {
    await pool.end().catch(() => undefined);
    await srv.close();
    await db.close();
  });

  async function send(taskId: number, m: { body: string; groupId?: string }, messageId: string): Promise<string> {
    const lines: string[] = [];
    const res = await handleTaskSqsEvent(
      { Records: [{ messageId, body: m.body, attributes: { MessageGroupId: m.groupId ?? `task-${taskId}` } }] },
      { graph, log: (l) => lines.push(l) },
    );
    if (res.batchItemFailures.length > 0) return "failed";
    const last = lines.at(-1)!;
    return last.slice(last.indexOf(": ") + 2);
  }

  async function newTask(): Promise<number> {
    const [row] = await sql<{ id: string }>("INSERT INTO tasks (source, owner_text) VALUES ('console', 'synthetic') RETURNING id");
    const id = Number(row!.id);
    await sql("UPDATE tasks SET thread_id = 'task-' || id WHERE id = $1", [id]);
    return id;
  }

  /** One sweeper run against the same database (as orch_rw); returns the messages it sent. */
  async function sweep(): Promise<QueuedMessage[]> {
    const sent: QueuedMessage[] = [];
    await runSweep({
      store: sqlSweeperStore(pool),
      queue: { send: async (m) => void sent.push(m) },
      github: () => Promise.reject(new Error("not used")),
      scheduledTime: new Date("2026-10-23T10:30:00Z"),
      now: new Date("2026-10-23T10:30:00Z"),
      log: () => undefined,
    });
    return sent;
  }

  it("a failed start left in planning is completed by the next sweep, with one issue", async () => {
    const id = await newTask();
    gh.failNext("dispatchWorkflow", 502);
    const created = JSON.stringify({ type: "task.created", task_id: id });
    expect(await send(id, { body: created }, "start-1")).toBe("failed");
    expect((await sql<{ status: string }>("SELECT status FROM tasks WHERE id = $1", [id]))[0]!.status).toBe("planning");
    expect(gh.issues).toHaveLength(1);

    // Its message went to the DLQ; 16 minutes later the sweeper picks the task up.
    await sql("UPDATE tasks SET updated_at = now() - interval '16 minutes' WHERE id = $1", [id]);
    const sent = (await sweep()).filter((m) => m.groupId === `task-${id}`);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.dedupeId).toBe(sweepDedupeId(id, new Date("2026-10-23T10:30:00Z")));

    // The sweep completes the held start; the sweep itself is then a no-op in phase dev.
    expect(await send(id, sent[0]!, "sweep-1")).toBe("unchanged");
    expect(gh.issues).toHaveLength(1);
    const [task] = await sql<{ status: string; waiting_on: string }>("SELECT status, waiting_on FROM tasks WHERE id = $1", [id]);
    expect(task).toEqual({ status: "waiting", waiting_on: "dev" });
  });

  it("a planning task without a thread (its task.created never arrived): the sweep changes nothing", async () => {
    const id = await newTask();
    await sql("UPDATE tasks SET status = 'planning', updated_at = now() - interval '20 minutes' WHERE id = $1", [id]);
    const sent = (await sweep()).filter((m) => m.groupId === `task-${id}`);
    expect(sent).toHaveLength(1);
    expect(await send(id, sent[0]!, "sweep-2")).toBe("no_thread");
    expect((await sql<{ status: string }>("SELECT status FROM tasks WHERE id = $1", [id]))[0]!.status).toBe("planning");
  });
});
