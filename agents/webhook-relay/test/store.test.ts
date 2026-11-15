import { PGlite } from "@electric-sql/pglite";
import { fromPglite, migrate, type SqlClient } from "@kcw/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GITHUB_SOURCE, sqlRelayStore } from "../src/index";

// Runs as a login that is a plain member of relay_rw (migration 0005), like relay_app in prod, so the
// store's real queries are checked against the relay's grants. Read-backs run as the superuser.
// SET ROLE, not SET SESSION AUTHORIZATION: PGlite 0.5.11 does not undo the latter on RESET.
const LOGIN = "relay_test_app";

describe("sqlRelayStore on PGlite (migrations applied, as a relay_rw member)", () => {
  let pg: PGlite;
  let db: SqlClient;

  /** Runs a check query as PGlite's superuser (relay_rw cannot read these rows back). */
  async function asSuperuser<R>(sql: string): Promise<R[]> {
    await pg.exec("RESET ROLE");
    try {
      return (await db.query<R>(sql)).rows;
    } finally {
      await pg.exec(`SET ROLE ${LOGIN}`);
    }
  }

  beforeAll(async () => {
    pg = new PGlite();
    db = fromPglite(pg);
    await migrate(db);
    // Task ids are identities: 1, 2, 3.
    await db.exec(`
      INSERT INTO tasks (source, owner_text, pr_number, github_issue) VALUES
        ('console', 'synthetic', 12, 11),
        ('console', 'synthetic', NULL, 21),
        ('console', 'synthetic', 12, NULL);
      CREATE ROLE ${LOGIN} LOGIN;
      GRANT relay_rw TO ${LOGIN};
    `);
    await pg.exec(`SET ROLE ${LOGIN}`);
  });
  afterAll(async () => {
    await pg.close();
  });

  it("claims a delivery and its outbox row in one statement, once", async () => {
    const s = sqlRelayStore(db);
    const id = await s.claimAndEnqueue("d-1", GITHUB_SOURCE, "task-1", '{"a":1}');
    expect(id).toEqual(expect.any(Number));
    expect(await s.claimAndEnqueue("d-1", GITHUB_SOURCE, "task-1", '{"a":1}')).toBeNull();
    expect(await asSuperuser<{ source: string }>("SELECT source FROM inbound_events WHERE delivery_id = 'd-1'")).toEqual([
      { source: "github" },
    ]);
    const rows = await asSuperuser<{ id: number; message_key: string; group_id: string; body: string; sent_at: Date | null; attempts: number }>(
      "SELECT id, message_key, group_id, body, sent_at, attempts FROM orchestrator_outbox",
    );
    expect(rows).toEqual([{ id: Number(id), message_key: "d-1", group_id: "task-1", body: '{"a":1}', sent_at: null, attempts: 0 }]);
  });

  it("marks an outbox row sent once", async () => {
    const s = sqlRelayStore(db);
    const id = await s.claimAndEnqueue("d-2", GITHUB_SOURCE, "task-2", "{}");
    await s.markOutboxSent(id!);
    await s.markOutboxSent(id!); // already sent: no change
    const rows = await asSuperuser<{ sent: boolean }>(`SELECT sent_at IS NOT NULL AS sent FROM orchestrator_outbox WHERE id = ${id}`);
    expect(rows).toEqual([{ sent: true }]);
  });

  it("cannot release a claim any more (no DELETE on inbound_events)", async () => {
    await expect(db.query("DELETE FROM inbound_events WHERE delivery_id = $1", ["d-2"])).rejects.toThrow(/permission denied/);
  });

  it("finds the newest task by PR number and by issue number", async () => {
    const s = sqlRelayStore(db);
    expect(await s.findTaskByPr(12)).toBe(3);
    expect(await s.findTaskByPr(99)).toBeNull();
    expect(await s.findTaskByIssue(11)).toBe(1);
    expect(await s.findTaskByIssue(21)).toBe(2);
    expect(await s.findTaskByIssue(99)).toBeNull();
  });

  it("records Actions minutes once per dedupe key, cost 0, linking only existing tasks", async () => {
    const s = sqlRelayStore(db);
    const u = { dedupeKey: "github:workflow_run:7:1", agent: "developer" as const, minutes: 7.5, ts: "2026-10-22T10:07:30.000Z" };
    expect(await s.recordActionsMinutes(u, 2)).toBe(true);
    expect(await s.recordActionsMinutes(u, 2)).toBe(false);
    // A task-like branch whose task row does not exist: recorded without a task.
    expect(await s.recordActionsMinutes({ ...u, dedupeKey: "github:workflow_run:8:1" }, 999)).toBe(true);
    expect(await s.recordActionsMinutes({ ...u, dedupeKey: "github:workflow_run:9:1" }, null)).toBe(true);
    const rows = await asSuperuser<{ dedupe_key: string; kind: string; agent: string; minutes: string; cost_usd: string; task_id: string | null; ts: Date }>(
      "SELECT dedupe_key, kind, agent, minutes, cost_usd, task_id, ts FROM usage_events ORDER BY dedupe_key",
    );
    expect(rows.map((r) => [r.dedupe_key, r.kind, r.agent, Number(r.minutes), Number(r.cost_usd), r.task_id === null ? null : Number(r.task_id)])).toEqual([
      ["github:workflow_run:7:1", "actions_minutes", "developer", 7.5, 0, 2],
      ["github:workflow_run:8:1", "actions_minutes", "developer", 7.5, 0, null],
      ["github:workflow_run:9:1", "actions_minutes", "developer", 7.5, 0, null],
    ]);
    expect(new Date(rows[0]!.ts).toISOString()).toBe("2026-10-22T10:07:30.000Z");
  });

  it("finds a dispatch link by run id with the three granted columns only (0010)", async () => {
    await asSuperuser(
      "INSERT INTO agent_dispatches (run_id, task_id, role) VALUES (40526955264, 3, 'developer'), (9007199254740991, 2, 'qa')",
    );
    const s = sqlRelayStore(db);
    expect(await s.findDispatch(40526955264)).toEqual({ task_id: 3, role: "developer" });
    expect(await s.findDispatch(Number.MAX_SAFE_INTEGER)).toEqual({ task_id: 2, role: "qa" });
    expect(await s.findDispatch(1)).toBeNull();
    await expect(db.query("SELECT dispatched_at FROM agent_dispatches")).rejects.toThrow(/permission denied/);
  });

  it("runs with the relay_rw grants only", async () => {
    const { rows } = await db.query<{ u: string; member: boolean; orch: boolean }>(
      "SELECT current_user AS u, pg_has_role(current_user, 'relay_rw', 'MEMBER') AS member, pg_has_role(current_user, 'orch_rw', 'MEMBER') AS orch",
    );
    expect(rows).toEqual([{ u: LOGIN, member: true, orch: false }]);
    await expect(db.query("SELECT owner_text FROM tasks")).rejects.toThrow(/permission denied/);
    await expect(db.query("SELECT * FROM inbound_events")).rejects.toThrow(/permission denied/);
  });
});
