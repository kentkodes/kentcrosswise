import type { PGlite } from "@electric-sql/pglite";
import type { SendMessageCommand } from "@aws-sdk/client-sqs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createTask,
  decideApproval,
  decidedApproval,
  getFlags,
  InputError,
  listApprovals,
  listEvents,
  listTasks,
  parseTaskId,
  queuedTaskExists,
  setFlag,
} from "../src/server/console";
import { runAs, type Queryable } from "../src/server/db";
import {
  disabledQueue,
  ownerDecisionMessage,
  queueFromEnv,
  taskCreatedMessage,
  trySend,
  type SqsLike,
} from "../src/server/orchestrator-queue";
import { freshDb, pglitePool } from "./pglite";

const SEED_APPROVAL_1 = "5eed0000-0000-4000-8000-000000000001";
const SEED_APPROVAL_2 = "5eed0000-0000-4000-8000-000000000002";

describe("console data as web_rw", () => {
  let pg: PGlite;
  const asRw = <T>(fn: (db: Queryable) => Promise<T>) => runAs(pglitePool(pg), "web_rw", fn);

  beforeAll(async () => {
    pg = await freshDb({ seed: true });
  });
  afterAll(async () => {
    await pg.close();
  });

  it("creates a queued console task with its thread id, private unless told otherwise", async () => {
    const id = await asRw((db) => createTask(db, { ownerText: "  Add a /healthz page  ", isPrivate: true }));
    const pub = await asRw((db) => createTask(db, { ownerText: "Public one", isPrivate: false }));
    const { rows } = await pg.query<{ source: string; status: string; thread_id: string; is_private: boolean; owner_text: string }>(
      "SELECT source, status, thread_id, is_private, owner_text FROM tasks WHERE id = ANY($1::bigint[]) ORDER BY id",
      [[id, pub]],
    );
    expect(rows).toEqual([
      { source: "console", status: "queued", thread_id: `task-${id}`, is_private: true, owner_text: "Add a /healthz page" },
      { source: "console", status: "queued", thread_id: `task-${pub}`, is_private: false, owner_text: "Public one" },
    ]);
    // A console task with no public title is "Private task" in the public view either way.
    const view = await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM tasks WHERE id = $1 AND public_title IS NULL", [pub]);
    expect(view.rows[0]!.n).toBe(1);
    await expect(asRw((db) => queuedTaskExists(db, id))).resolves.toBe(true);
  });

  it("rejects empty and oversized task text", async () => {
    await expect(asRw((db) => createTask(db, { ownerText: "   ", isPrivate: true }))).rejects.toBeInstanceOf(InputError);
    await expect(asRw((db) => createTask(db, { ownerText: "x".repeat(4001), isPrivate: true }))).rejects.toBeInstanceOf(InputError);
  });

  it("lists tasks newest first with their events", async () => {
    const tasks = await asRw((db) => listTasks(db));
    expect(tasks.length).toBeGreaterThanOrEqual(5);
    expect(tasks.map((t) => t.id)).toEqual([...tasks.map((t) => t.id)].sort((a, b) => b - a));
    const seeded = tasks.find((t) => t.publicTitle === "Add a health check page")!;
    expect(seeded.waitingOn).toBe("owner");
    const events = await asRw((db) => listEvents(db, [seeded.id], 3));
    // The latest 3, oldest first.
    expect(events.map((e) => e.type)).toEqual(["qa_reviewing", "approved", "waiting_on_owner"]);
    await expect(asRw((db) => listEvents(db, []))).resolves.toEqual([]);
  });

  it("marks docs tasks (children of a merged task, source github) and never resends them", async () => {
    const merged = await asRw((db) => createTask(db, { ownerText: "Merged work", isPrivate: true }));
    const { rows } = await pg.query<{ id: string }>(
      "INSERT INTO tasks (parent_id, source, owner_text, is_private) VALUES ($1, 'github', 'Docs-keeper update after PR #9.', true) RETURNING id",
      [merged],
    );
    const docs = Number(rows[0]!.id);
    const subtask = Number(
      (await pg.query<{ id: string }>("INSERT INTO tasks (parent_id, source, owner_text) VALUES ($1, 'console', 'Part') RETURNING id", [merged]))
        .rows[0]!.id,
    );
    const tasks = await asRw((db) => listTasks(db));
    expect(tasks.find((t) => t.id === docs)).toMatchObject({ parentId: merged, isDocs: true, status: "queued" });
    expect(tasks.find((t) => t.id === subtask)).toMatchObject({ parentId: merged, isDocs: false });
    expect(tasks.find((t) => t.id === merged)).toMatchObject({ parentId: null, isDocs: false });
    await expect(asRw((db) => queuedTaskExists(db, docs))).resolves.toBe(false);
    await expect(asRw((db) => queuedTaskExists(db, subtask))).resolves.toBe(true);
    await pg.query("DELETE FROM tasks WHERE id = ANY($1::bigint[])", [[docs, subtask, merged]]);
  });

  it("reads and sets the two pause switches", async () => {
    await expect(asRw(getFlags)).resolves.toEqual({ agents_paused: false, pipelines_paused: false });
    await asRw((db) => setFlag(db, "agents_paused", true));
    await expect(asRw(getFlags)).resolves.toEqual({ agents_paused: true, pipelines_paused: false });
    await asRw((db) => setFlag(db, "agents_paused", false));
    await expect(asRw((db) => setFlag(db, "other" as "agents_paused", true))).rejects.toBeInstanceOf(InputError);
    const { rows } = await pg.query<{ value: unknown }>("SELECT value FROM system_flags WHERE key = 'agents_paused'");
    expect(rows[0]!.value).toBe(false);
  });

  it("decides a pending approval once, closes its inbox item, and lists it as decided", async () => {
    await pg.query(
      "INSERT INTO inbox_items (kind, ref_table, ref_id, title) VALUES ('approval', 'approvals', $1, 'Critical PR')",
      [SEED_APPROVAL_1],
    );
    const before = await asRw((db) => listApprovals(db));
    expect(before.pending.map((a) => a.id)).toEqual([SEED_APPROVAL_1, SEED_APPROVAL_2]);
    expect(before.pending[0]!.reasons).toEqual(["seed: infra/prod changed"]);
    expect(before.pending[0]!.taskText).toContain("[seed]");

    const res = await asRw((db) => decideApproval(db, { id: SEED_APPROVAL_1, decision: "approved", note: " ok " }));
    expect(res.decided).toBe(true);
    expect(await asRw((db) => decideApproval(db, { id: SEED_APPROVAL_1, decision: "rejected" }))).toEqual({ decided: false });

    const after = await asRw((db) => listApprovals(db));
    expect(after.pending.map((a) => a.id)).toEqual([SEED_APPROVAL_2]);
    expect(after.decided[0]).toMatchObject({ id: SEED_APPROVAL_1, status: "approved", note: "ok" });
    const inbox = await pg.query<{ status: string }>("SELECT status FROM inbox_items WHERE ref_id = $1", [SEED_APPROVAL_1]);
    expect(inbox.rows[0]!.status).toBe("done");
    await expect(asRw((db) => decidedApproval(db, SEED_APPROVAL_1))).resolves.toMatchObject({ decision: "approved" });
    await expect(asRw((db) => decidedApproval(db, SEED_APPROVAL_2))).resolves.toBeUndefined();
  });

  it("rejects bad approval ids and decisions", async () => {
    await expect(asRw((db) => decideApproval(db, { id: "1; DROP TABLE x", decision: "approved" }))).rejects.toBeInstanceOf(InputError);
    await expect(
      asRw((db) => decideApproval(db, { id: SEED_APPROVAL_2, decision: "maybe" as "approved" })),
    ).rejects.toBeInstanceOf(InputError);
  });

  it("web_public cannot read tasks or approvals (console data stays owner-only)", async () => {
    await expect(runAs(pglitePool(pg), "web_public", (db) => listTasks(db))).rejects.toThrow(/permission denied/);
    await expect(runAs(pglitePool(pg), "web_public", (db) => listApprovals(db))).rejects.toThrow(/permission denied/);
  });
});

describe("parseTaskId", () => {
  it("accepts positive integers only", () => {
    expect(parseTaskId("12")).toBe(12);
    for (const bad of ["0", "-1", "1.2", "x", "", null, 3]) expect(parseTaskId(bad)).toBeUndefined();
  });
});

describe("orchestrator queue", () => {
  it("task.created matches the orchestrator handler's format and FIFO group", () => {
    expect(taskCreatedMessage(7)).toEqual({
      body: { type: "task.created", task_id: 7 },
      groupId: "task-7",
      dedupId: "task-created-7",
    });
  });

  it("owner decisions carry the §4.3 resume value", () => {
    expect(ownerDecisionMessage(7, SEED_APPROVAL_1, "rejected")).toEqual({
      body: {
        type: "owner.decision",
        task_id: 7,
        thread_id: "task-7",
        resume: { approval_id: SEED_APPROVAL_1, decision: "rejected" },
      },
      groupId: "task-7",
      dedupId: `approval-${SEED_APPROVAL_1}`,
    });
  });

  it("sends to SQS when KCW_ORCHESTRATOR_QUEUE_URL is set", async () => {
    const sent: SendMessageCommand[] = [];
    const client: SqsLike = { send: async (c) => void sent.push(c) };
    const url = "https://sqs.us-east-1.amazonaws.com/000000000000/kcw-prod-orchestrator-in.fifo";
    const queue = queueFromEnv({ KCW_ORCHESTRATOR_QUEUE_URL: url }, client);
    expect(queue.enabled).toBe(true);
    await expect(queue.send(taskCreatedMessage(3))).resolves.toBe("sent");
    expect(sent[0]!.input).toEqual({
      QueueUrl: url,
      MessageBody: '{"type":"task.created","task_id":3}',
      MessageGroupId: "task-3",
      MessageDeduplicationId: "task-created-3",
    });
  });

  it("is disabled without the URL (previews) and sends nothing", async () => {
    const queue = queueFromEnv({});
    expect(queue).toBe(disabledQueue);
    await expect(queue.send(taskCreatedMessage(3))).resolves.toBe("disabled");
  });

  it("trySend turns a send error into 'failed' with a one-line log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = queueFromEnv({ KCW_ORCHESTRATOR_QUEUE_URL: "https://example.invalid/q.fifo" }, {
      send: async () => Promise.reject(Object.assign(new Error("secret detail"), { name: "AccessDenied" })),
    });
    await expect(trySend(failing, taskCreatedMessage(1))).resolves.toBe("failed");
    expect(log).toHaveBeenCalledWith("[orchestrator-queue] send failed (AccessDenied)");
    log.mockRestore();
  });
});
