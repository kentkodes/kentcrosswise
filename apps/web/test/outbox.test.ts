import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTaskMessage } from "../../../agents/orchestrator/src/graph/messages";
import { runSweep, sqlSweeperStore, type QueuedMessage as SweepMessage } from "../../../agents/orchestrator/src/sweeper";
import { fromPglite } from "@kcw/db";
import { createTask, decideApproval } from "../src/server/console";
import { runAs, type DbRole, type Queryable } from "../src/server/db";
import type * as DbModule from "../src/server/db";
import { disabledQueue, ownerDecisionMessage, taskCreatedMessage, type OrchestratorQueue, type QueuedMessage } from "../src/server/orchestrator-queue";
import { deliverQueued } from "../src/server/outbox";
import { freshDb, pglitePool } from "./pglite";

// withDb (the process-wide pool) is replaced by runAs on the PGlite of this file; `failMark` makes
// the next withDb call fail, like a database that went away between the send and the mark.
const h = vi.hoisted(() => ({ pg: undefined as PGlite | undefined, failMark: false }));
vi.mock("../src/server/db", async (orig) => {
  const real = await orig<typeof DbModule>();
  return {
    ...real,
    withDb: async <T>(role: DbRole, fn: (db: Queryable) => Promise<T>, opts: { readOnly?: boolean } = {}) => {
      if (h.failMark) {
        h.failMark = false;
        throw Object.assign(new Error("postgres://user:pw@host/db"), { name: "ConnectionError" });
      }
      return real.runAs(pglitePool(h.pg!), role, fn, opts);
    },
  };
});

const SEED_APPROVAL_1 = "5eed0000-0000-4000-8000-000000000001";

class FakeQueue implements OrchestratorQueue {
  readonly enabled = true;
  sent: QueuedMessage[] = [];
  failWith: Error | undefined;
  async send(m: QueuedMessage) {
    if (this.failWith) throw this.failWith;
    this.sent.push(m);
    return "sent" as const;
  }
}

describe("web outbox delivery (AR2 slice 1)", () => {
  let pg: PGlite;
  const asRw = <T>(fn: (db: Queryable) => Promise<T>) => runAs(pglitePool(pg), "web_rw", fn);
  const sentAt = async (key: string) =>
    (await pg.query<{ sent: boolean }>("SELECT sent_at IS NOT NULL AS sent FROM orchestrator_outbox WHERE message_key = $1", [key])).rows[0]?.sent;

  /** What the sweeper does on its next run: the row is old enough and orch_rw sends it. */
  async function sweepNow(): Promise<{ sent: SweepMessage[]; report: Awaited<ReturnType<typeof runSweep>> }> {
    await pg.query("UPDATE orchestrator_outbox SET created_at = now() - interval '5 minutes' WHERE sent_at IS NULL");
    const sent: SweepMessage[] = [];
    await pg.query("SET ROLE orch_rw");
    try {
      const now = new Date();
      const store = Object.assign(Object.create(sqlSweeperStore(fromPglite(pg))), { listSweepTasks: async () => [] });
      const report = await runSweep({
        store,
        queue: { send: async (m) => void sent.push(m) },
        github: async () => {
          throw new Error("not used");
        },
        scheduledTime: now,
        now,
        log: () => undefined,
      });
      return { sent, report };
    } finally {
      await pg.query("RESET ROLE");
    }
  }

  beforeAll(async () => {
    pg = await freshDb({ seed: true });
    h.pg = pg;
  });
  afterAll(async () => {
    await pg.close();
  });
  beforeEach(() => {
    h.failMark = false;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("sent: the queue accepts the message and the row is marked", async () => {
    const id = await asRw((db) => createTask(db, { ownerText: "Send me", isPrivate: true }));
    const queue = new FakeQueue();
    await expect(deliverQueued(queue, taskCreatedMessage(id))).resolves.toBe("sent");
    expect(queue.sent).toHaveLength(1);
    expect(await sentAt(`task-created-${id}`)).toBe(true);
    expect((await sweepNow()).sent).toEqual([]);
  });

  it("a task created while the send fails stays in the outbox and the sweeper delivers it", async () => {
    const id = await asRw((db) => createTask(db, { ownerText: "Lost send", isPrivate: true }));
    const queue = new FakeQueue();
    queue.failWith = Object.assign(new Error("synthetic"), { name: "AccessDenied" });
    await expect(deliverQueued(queue, taskCreatedMessage(id))).resolves.toBe("queued");
    expect(await sentAt(`task-created-${id}`)).toBe(false);

    const { sent, report } = await sweepNow();
    expect(report).toMatchObject({ outboxSent: 1, outboxFailed: 0 });
    expect(sent).toEqual([
      { body: JSON.stringify(taskCreatedMessage(id).body), groupId: `task-${id}`, dedupeId: `task-created-${id}` },
    ]);
    // The consumer accepts the stored body and sees the logical key.
    expect(parseTaskMessage(sent[0]!.body, sent[0]!.groupId, "sqs-1")).toMatchObject({ task_id: id, message_key: `task-created-${id}` });
    expect(await sentAt(`task-created-${id}`)).toBe(true);
  });

  it("an owner decision whose send fails is recovered the same way, once", async () => {
    await asRw(async (db) => {
      await db.query("INSERT INTO inbox_items (kind, ref_table, ref_id, title) VALUES ('approval', 'approvals', $1, 'Critical PR')", [SEED_APPROVAL_1]);
    });
    const res = await asRw((db) => decideApproval(db, { id: SEED_APPROVAL_1, decision: "approved" }));
    if (!res.decided || res.taskId === null) throw new Error("seed approval has a task");
    const queue = new FakeQueue();
    queue.failWith = new Error("synthetic");
    await expect(deliverQueued(queue, ownerDecisionMessage(res.taskId, SEED_APPROVAL_1, "approved"))).resolves.toBe("queued");

    const { sent } = await sweepNow();
    expect(sent).toHaveLength(1);
    expect(parseTaskMessage(sent[0]!.body, sent[0]!.groupId, "sqs-2")).toMatchObject({
      task_id: res.taskId,
      input: { kind: "decision", approval_id: SEED_APPROVAL_1, decision: "approved" },
      message_key: `approval-${SEED_APPROVAL_1}`,
    });
    // A second click is a no-op: no second row, nothing more to send.
    expect(await asRw((db) => decideApproval(db, { id: SEED_APPROVAL_1, decision: "approved" }))).toEqual({ decided: false });
    expect((await sweepNow()).sent).toEqual([]);
  });

  it("queued when the send succeeded but marking failed: the sweeper resends the same key", async () => {
    const id = await asRw((db) => createTask(db, { ownerText: "Mark fails", isPrivate: true }));
    const queue = new FakeQueue();
    h.failMark = true;
    await expect(deliverQueued(queue, taskCreatedMessage(id))).resolves.toBe("queued");
    expect(queue.sent).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith("[orchestrator-queue] mark sent failed (ConnectionError)");
    expect(await sentAt(`task-created-${id}`)).toBe(false);
    const { sent } = await sweepNow();
    expect(sent.map((m) => m.dedupeId)).toEqual([queue.sent[0]!.dedupId]);
  });

  it("disabled (previews): nothing is sent, the row stays", async () => {
    const id = await asRw((db) => createTask(db, { ownerText: "Preview", isPrivate: true }));
    await expect(deliverQueued(disabledQueue, taskCreatedMessage(id))).resolves.toBe("disabled");
    expect(await sentAt(`task-created-${id}`)).toBe(false);
  });
});
