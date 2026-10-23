// P2-08 definition of done: a thread interrupted by one process resumes in a fresh process (new
// pool, checkpointer and graph instance) against Postgres. Postgres here is PGlite with migrations
// 0001-0002 applied, served over the wire protocol so the production path (node-postgres Pool ->
// PostgresSaver) runs unchanged, connected as orch_rw (the role the Lambda uses).
import { PGlite } from "@electric-sql/pglite";
import { fromPglite, migrate } from "@kcw/db";
import { createFakeSecrets } from "@kcw/secrets";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CheckpointSchemaMissingError,
  buildGraph,
  checkpointerFromPool,
  createHandler,
  setupCheckpointer,
  threadConfig,
  type SqsRecord,
} from "../src/index";
import { servePglite, type PgSocketServer } from "./pg-socket";

const SECRET = "kcw/prod/orchestrator";
const report = { task_id: 7, agent: "developer", event_type: "pr_opened" } as const;

const msg = (id: string, body: unknown, taskId: number): SqsRecord => ({
  messageId: id,
  body: JSON.stringify(body),
  attributes: { MessageGroupId: `task-${taskId}` },
});

describe("orchestrator on Postgres", () => {
  let db: PGlite;
  let srv: PgSocketServer;
  const pools: pg.Pool[] = [];

  // The server sets role orch_rw after every connection's startup. PGlite is one session shared by
  // all connections, so superuser checks reset the role and then restore it.
  const poolAsOrchRw = (url: string): pg.Pool => {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    pools.push(pool);
    return pool;
  };

  /** A new "process": its own handler, pool, checkpointer and graph. */
  const newProcess = (vars: Record<string, string> = {}, extra: Record<string, Record<string, string>> = {}) => {
    const lines: string[] = [];
    const env: Record<string, string | undefined> = { KCW_ORCHESTRATOR_SECRET: SECRET, ...vars };
    const { store } = createFakeSecrets({ [SECRET]: { db_url: srv.url }, ...extra });
    const handler = createHandler({
      env,
      secrets: store,
      makePool: poolAsOrchRw,
      log: (l) => lines.push(l),
    });
    return { handler, lines, env };
  };

  const asSuperuser = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    await db.query("RESET ROLE");
    try {
      return (await db.query<T>(sql, params)).rows;
    } finally {
      await db.query("SET ROLE orch_rw");
    }
  };

  beforeAll(async () => {
    db = await PGlite.create();
    await migrate(fromPglite(db));
    srv = await servePglite(db, { role: "orch_rw" });
  }, 60_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
    await srv.close();
    await db.close();
  });

  it("interrupts in one process and resumes in a fresh one", async () => {
    // Process A: task.created runs the graph to its interrupt.
    const a = newProcess();
    expect(await a.handler({ Records: [msg("m1", { type: "task.created", task_id: 7 }, 7)] })).toEqual({
      batchItemFailures: [],
    });
    expect(a.lines).toEqual(["message m1: started"]);

    // The checkpoint is in schema lg, in tables orch_rw created and owns.
    const tables = await asSuperuser<{ tablename: string; tableowner: string }>(
      "SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'lg' ORDER BY tablename",
    );
    expect(tables.map((t) => t.tablename)).toEqual([
      "checkpoint_blobs",
      "checkpoint_migrations",
      "checkpoint_writes",
      "checkpoints",
    ]);
    expect(new Set(tables.map((t) => t.tableowner))).toEqual(new Set(["orch_rw"]));
    const [count] = await asSuperuser<{ n: number }>(
      "SELECT count(*)::int AS n FROM lg.checkpoints WHERE thread_id = 'task-7'",
    );
    expect(count?.n).toBeGreaterThan(0);

    // Process B: a new graph instance on a new pool resumes the thread with the report.
    const b = newProcess();
    await b.handler({ Records: [msg("m2", report, 7)] });
    expect(b.lines).toEqual(["message m2: resumed"]);

    // Process C reads the final state.
    const graph = buildGraph(checkpointerFromPool(poolAsOrchRw(srv.url)));
    const state = await graph.getState(threadConfig(7));
    expect(state.next).toEqual([]);
    expect(state.values).toEqual({ task_id: 7, status: "done", waiting_on: null, reports: [report] });
  });

  it("exposes what the thread waits on while interrupted", async () => {
    const p = newProcess();
    await p.handler({ Records: [msg("m1", { type: "task.created", task_id: 8 }, 8)] });
    const graph = buildGraph(checkpointerFromPool(poolAsOrchRw(srv.url)));
    const state = await graph.getState(threadConfig(8));
    expect(state.next).toEqual(["await_report"]);
    expect(state.values).toMatchObject({ task_id: 8, status: "waiting", waiting_on: "dev", reports: [] });
    expect(state.tasks.flatMap((t) => t.interrupts.map((i) => i.value))).toEqual([{ waiting_on: "dev" }]);
  });

  it("ignores duplicate starts and reports for threads that are not waiting", async () => {
    const p = newProcess();
    await p.handler({
      Records: [
        msg("m1", { type: "task.created", task_id: 9 }, 9),
        msg("m2", { type: "task.created", task_id: 9 }, 9), // redelivered start
        msg("m3", { ...report, task_id: 9 }, 9),
        msg("m4", { ...report, task_id: 9, event_type: "ci_running" }, 9), // thread already done
        msg("m5", { ...report, task_id: 404 }, 404), // no such thread
      ],
    });
    expect(p.lines).toEqual([
      "message m1: started",
      "message m2: duplicate_start",
      "message m3: resumed",
      "message m4: stale",
      "message m5: stale",
    ]);
    const rows = await asSuperuser("SELECT 1 FROM lg.checkpoints WHERE thread_id = 'task-404'");
    expect(rows).toEqual([]);
  });

  it("needs setupCheckpointer: the library's own setup() is refused for orch_rw", async () => {
    // Postgres checks CREATE on the database before IF NOT EXISTS (see setupCheckpointer).
    await expect(checkpointerFromPool(poolAsOrchRw(srv.url)).setup()).rejects.toThrow(/permission denied for database/);
  });

  it("copies the LangSmith key from the models secret when tracing is on", async () => {
    const p = newProcess(
      { LANGSMITH_TRACING: "true", KCW_MODELS_SECRET: "kcw/prod/models" },
      { "kcw/prod/models": { langsmith_api_key: "ls-test-key" } },
    );
    await p.handler({ Records: [] });
    expect(p.env.LANGSMITH_API_KEY).toBe("ls-test-key");
    expect(p.env.LANGSMITH_TRACING).toBe("true");
  });

  it("turns tracing off when the models secret has no LangSmith key", async () => {
    const p = newProcess(
      { LANGSMITH_TRACING: "true", KCW_MODELS_SECRET: "kcw/prod/models" },
      { "kcw/prod/models": {} },
    );
    await p.handler({ Records: [] });
    expect(p.env.LANGSMITH_API_KEY).toBeUndefined();
    expect(p.env.LANGSMITH_TRACING).toBe("false");
    expect(p.lines).toEqual(["langsmith_api_key missing: tracing off"]);
  });
});

describe("setupCheckpointer without migrations", () => {
  it("fails clearly when schema lg does not exist", async () => {
    const db = await PGlite.create();
    const srv = await servePglite(db);
    const pool = new pg.Pool({ connectionString: srv.url, max: 1 });
    try {
      await expect(setupCheckpointer(pool)).rejects.toThrow(CheckpointSchemaMissingError);
    } finally {
      await pool.end();
      await srv.close();
      await db.close();
    }
  });
});
