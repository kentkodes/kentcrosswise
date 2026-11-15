// AR2 slice 1: the outbox drain (sweeper part `outbox`) and the consumer's receipts, end to end on
// PGlite as orch_rw (served over the wire protocol, like task-graph.test.ts) with a fake FIFO queue.
// The writers' side (relay, web) is in the relay's and web's own tests; here a row is inserted the
// way they commit it, and "a crash after the commit" is simply a row that nobody sent yet.
import { PGlite } from "@electric-sql/pglite";
import { fromPglite, migrate } from "@kcw/db";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkpointerFromPool, setupCheckpointer } from "../src/index";
import { FakeGitHubClient } from "../src/github";
import { PgReceiptStore, PgTaskStore, buildTaskGraph, handleTaskSqsEvent, type TaskGraph } from "../src/graph";
import { runSweep, sqlSweeperStore, type QueuedMessage, type SweeperStore } from "../src/sweeper";
import { servePglite, type PgSocketServer } from "./pg-socket";

/** A FIFO queue: refuses chosen groups, deduplicates by id while the window is open, then the consumer drains it. */
class FakeFifo {
  inflight: QueuedMessage[] = [];
  failGroups = new Set<string>();
  dedupeWindowOpen = true;
  readonly seen = new Set<string>();
  readonly attempted: string[] = [];
  async send(m: QueuedMessage) {
    this.attempted.push(m.dedupeId);
    if (this.failGroups.has(m.groupId)) throw Object.assign(new Error("synthetic"), { name: "ThrottlingException" });
    if (this.dedupeWindowOpen && this.seen.has(m.dedupeId)) return; // accepted, dropped by SQS
    this.seen.add(m.dedupeId);
    this.inflight.push(m);
  }
}

describe("orchestrator outbox drain and consumer receipts", () => {
  let db: PGlite;
  let srv: PgSocketServer;
  let pool: pg.Pool;
  let graph: TaskGraph;
  let gh: FakeGitHubClient;
  let store: SweeperStore;
  let receipts: PgReceiptStore;
  let q: FakeFifo;
  let seq = 0;

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
    // No sweep messages: these tests are about the outbox part only.
    store = Object.assign(Object.create(sqlSweeperStore(pool)) as SweeperStore, { listSweepTasks: async () => [] });
    receipts = new PgReceiptStore(pool);
  }, 60_000);

  afterAll(async () => {
    await pool.end().catch(() => undefined);
    await srv.close();
    await db.close();
  });

  beforeEach(async () => {
    gh = new FakeGitHubClient();
    graph = buildTaskGraph(checkpointerFromPool(pool), {
      github: gh,
      store: new PgTaskStore(pool),
      planner: { split: async (r) => [r.owner_text], plan: async () => ({ title: "Add a page", body: "Add it." }) },
    });
    q = new FakeFifo();
    // Earlier tests leave tasks in flight; finish them so each start finds a free slot.
    await sql("UPDATE tasks SET status = 'done' WHERE status IN ('planning', 'in_progress', 'waiting')");
    await sql("DELETE FROM orchestrator_outbox");
    await sql("DELETE FROM orchestrator_receipts");
  });

  async function newTask(): Promise<number> {
    const [row] = await sql<{ id: string }>("INSERT INTO tasks (source, owner_text, is_private) VALUES ('console', 'Add a page', true) RETURNING id");
    const id = Number(row!.id);
    await sql("UPDATE tasks SET thread_id = 'task-' || id WHERE id = $1", [id]);
    return id;
  }

  /** What the web commits with the task: key task-created-<id>, group task-<id>, body with message_key. */
  async function outboxRow(taskId: number, minutesOld = 5): Promise<string> {
    const key = `task-created-${taskId}`;
    await sql(
      "INSERT INTO orchestrator_outbox (message_key, group_id, body, created_at) VALUES ($1, $2, $3, now() - make_interval(mins => $4))",
      [key, `task-${taskId}`, JSON.stringify({ type: "task.created", task_id: taskId, message_key: key }), minutesOld],
    );
    return key;
  }

  const sweep = (over: Partial<Parameters<typeof runSweep>[0]> = {}) => {
    const now = new Date();
    return runSweep({ store, queue: q, github: async () => { throw new Error("not used"); }, scheduledTime: now, now, log: () => undefined, ...over });
  };

  /** The consumer: each in-flight message is its own SQS message (own message id), receipts on. */
  async function consume(): Promise<string[]> {
    const outcomes: string[] = [];
    const messages = q.inflight;
    q.inflight = [];
    for (const m of messages) {
      const lines: string[] = [];
      const res = await handleTaskSqsEvent(
        { Records: [{ messageId: `sqs-${++seq}`, body: m.body, attributes: { MessageGroupId: m.groupId } }] },
        { graph, receipts, log: (l) => lines.push(l) },
      );
      outcomes.push(res.batchItemFailures.length > 0 ? "failed" : lines.at(-1)!.slice(lines.at(-1)!.indexOf(": ") + 2));
    }
    return outcomes;
  }

  const row = async (key: string) =>
    (await sql<{ sent: boolean; attempts: number; last_error: string | null; wait_minutes: number }>(
      `SELECT sent_at IS NOT NULL AS sent, attempts, last_error,
              (extract(epoch FROM next_attempt_at - now()) / 60)::float8 AS wait_minutes FROM orchestrator_outbox WHERE message_key = $1`,
      [key],
    ))[0]!;
  const receiptKeys = async () => (await sql<{ message_key: string }>("SELECT message_key FROM orchestrator_receipts ORDER BY 1")).map((r) => r.message_key);

  it("crash after the DB commit before the send: the sweeper sends the pending row and the consumer processes it", async () => {
    const id = await newTask();
    const key = await outboxRow(id);
    const r = await sweep();
    expect(r).toMatchObject({ outboxSent: 1, outboxFailed: 0, failed: {} });
    expect(q.inflight).toEqual([{ body: expect.stringContaining(`"message_key":"${key}"`), groupId: `task-${id}`, dedupeId: key }]);
    expect((await row(key)).sent).toBe(true);
    expect(await consume()).toEqual(["started"]);
    expect(await receiptKeys()).toEqual([key]);
    expect(gh.issues).toHaveLength(1);
    // Nothing left to send.
    expect((await sweep()).outboxSent).toBe(0);
  });

  it("a send that succeeded but was not marked is resent, and the consumer processes it once (receipt)", async () => {
    const id = await newTask();
    const key = await outboxRow(id);
    // The writer's send reached SQS, then its mark-sent failed: the row stays unsent.
    await q.send({ body: JSON.stringify({ type: "task.created", task_id: id, message_key: key }), groupId: `task-${id}`, dedupeId: key });
    // Inside the dedupe window SQS drops the sweeper's resend.
    await sweep();
    expect(q.inflight).toHaveLength(1);
    expect(await consume()).toEqual(["started"]);
    // After the window the same key arrives again (new SQS message id): the receipt drops it.
    await sql("UPDATE orchestrator_outbox SET sent_at = NULL WHERE message_key = $1", [key]);
    q.dedupeWindowOpen = false;
    await sweep();
    expect(q.inflight).toHaveLength(1);
    expect(await consume()).toEqual(["duplicate"]);
    expect(gh.issues).toHaveLength(1);
    expect(await receiptKeys()).toEqual([key]);
  });

  it("the writer's send and the sweeper's drain of the same key at the same time process the message once", async () => {
    const id = await newTask();
    const key = await outboxRow(id);
    q.dedupeWindowOpen = false; // worst case: both copies reach the queue
    await Promise.all([
      q.send({ body: JSON.stringify({ type: "task.created", task_id: id, message_key: key }), groupId: `task-${id}`, dedupeId: key }),
      sweep(),
    ]);
    expect(q.inflight).toHaveLength(2);
    expect((await consume()).sort()).toEqual(["duplicate", "started"]);
    expect(gh.issues).toHaveLength(1);
  });

  it("a message without a key (sweep) is processed as before and records no receipt", async () => {
    const id = await newTask();
    q.inflight.push({ body: JSON.stringify({ type: "task.created", task_id: id }), groupId: `task-${id}`, dedupeId: "legacy" });
    expect(await consume()).toEqual(["started"]);
    q.inflight.push({ body: JSON.stringify({ type: "sweep", task_id: id, thread_id: `task-${id}` }), groupId: `task-${id}`, dedupeId: "s1" });
    await consume();
    expect(await receiptKeys()).toEqual([]);
  });

  it("a failed message is not recorded, so its redelivery is processed", async () => {
    const id = await newTask();
    const key = await outboxRow(id);
    q.inflight.push({ body: JSON.stringify({ type: "task.created", task_id: id, message_key: key }), groupId: `task-${id}`, dedupeId: key });
    const failing = new FakeGitHubClient();
    failing.createIssue = async () => {
      throw new Error("github down");
    };
    graph = buildTaskGraph(checkpointerFromPool(pool), {
      github: failing,
      store: new PgTaskStore(pool),
      planner: { split: async (r) => [r.owner_text], plan: async () => ({ title: "Add a page", body: "Add it." }) },
    });
    expect(await consume()).toEqual(["failed"]);
    expect(await receiptKeys()).toEqual([]);
  });

  it("a failed send backs off (15 min doubling, 6 h cap) with the error class only, and skips the rest of its group", async () => {
    const a = await newTask();
    const b = await newTask();
    const a1 = await outboxRow(a);
    await sql("INSERT INTO orchestrator_outbox (message_key, group_id, body, created_at) VALUES ('a-second', $1, '{}', now() - interval '4 minutes')", [`task-${a}`]);
    const b1 = await outboxRow(b);
    q.failGroups.add(`task-${a}`);

    const r = await sweep();
    expect(r).toMatchObject({ outboxSent: 1, outboxFailed: 1, failed: { outbox: "ThrottlingException" } });
    expect(q.attempted).toEqual([a1, b1]); // a-second was skipped, not tried
    const first = await row(a1);
    expect(first).toMatchObject({ sent: false, attempts: 1, last_error: "ThrottlingException" });
    expect(first.wait_minutes).toBeGreaterThan(14);
    expect(first.wait_minutes).toBeLessThanOrEqual(15);
    expect(await row("a-second")).toMatchObject({ sent: false, attempts: 0, last_error: null });
    expect((await row(b1)).sent).toBe(true);

    // Not due: the next run tries nothing, and the later row does not overtake the one backing off.
    q.attempted.length = 0;
    expect(await sweep()).toMatchObject({ outboxSent: 0, outboxFailed: 0, failed: {} });
    expect(q.attempted).toEqual([]);

    // Due again, still failing: attempts 2 -> 30 minutes.
    await sql("UPDATE orchestrator_outbox SET next_attempt_at = now() WHERE message_key = $1", [a1]);
    await sweep();
    const second = await row(a1);
    expect(second.attempts).toBe(2);
    expect(second.wait_minutes).toBeGreaterThan(29);
    expect(second.wait_minutes).toBeLessThanOrEqual(30);

    // The cap: attempts 9 -> 15 min * 2^9 would be 5.3 days; capped at 6 h.
    await sql("UPDATE orchestrator_outbox SET attempts = 9, next_attempt_at = now() WHERE message_key = $1", [a1]);
    await sweep();
    const capped = await row(a1);
    expect(capped.attempts).toBe(10);
    expect(capped.wait_minutes).toBeGreaterThan(359);
    expect(capped.wait_minutes).toBeLessThanOrEqual(360);

    // Recovered: both rows go out in id order.
    q.failGroups.clear();
    await sql("UPDATE orchestrator_outbox SET next_attempt_at = now() WHERE message_key = $1", [a1]);
    expect(await sweep()).toMatchObject({ outboxSent: 2, outboxFailed: 0 });
    expect(q.attempted.slice(-2)).toEqual([a1, "a-second"]);
  });

  it("leaves rows younger than 2 minutes to their writer", async () => {
    const id = await newTask();
    const key = await outboxRow(id, 1);
    expect(await sweep()).toMatchObject({ outboxSent: 0 });
    expect((await row(key)).sent).toBe(false);
    await sql("UPDATE orchestrator_outbox SET created_at = now() - interval '3 minutes' WHERE message_key = $1", [key]);
    expect(await sweep()).toMatchObject({ outboxSent: 1 });
  });

  it("runs whatever the spend part does", async () => {
    const id = await newTask();
    await outboxRow(id);
    const gated: SweeperStore = Object.assign(Object.create(store) as SweeperStore, {
      monthUsage: async () => {
        throw new TypeError("spend unknown");
      },
    });
    expect(await sweep({ store: gated })).toMatchObject({ outboxSent: 1, failed: { spend: "TypeError" } });
  });
});
