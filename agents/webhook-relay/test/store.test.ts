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

  it("claims a delivery once", async () => {
    const s = sqlRelayStore(db);
    expect(await s.claimDelivery("d-1", GITHUB_SOURCE)).toBe(true);
    expect(await s.claimDelivery("d-1", GITHUB_SOURCE)).toBe(false);
    const rows = await asSuperuser<{ source: string }>("SELECT source FROM inbound_events WHERE delivery_id = 'd-1'");
    expect(rows).toEqual([{ source: "github" }]);
  });

  it("releases a claim", async () => {
    const s = sqlRelayStore(db);
    expect(await s.claimDelivery("d-2", GITHUB_SOURCE)).toBe(true);
    await s.releaseDelivery("d-2");
    expect(await s.claimDelivery("d-2", GITHUB_SOURCE)).toBe(true);
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

  it("runs with the relay_rw grants only", async () => {
    const { rows } = await db.query<{ u: string; member: boolean; orch: boolean }>(
      "SELECT current_user AS u, pg_has_role(current_user, 'relay_rw', 'MEMBER') AS member, pg_has_role(current_user, 'orch_rw', 'MEMBER') AS orch",
    );
    expect(rows).toEqual([{ u: LOGIN, member: true, orch: false }]);
    await expect(db.query("SELECT owner_text FROM tasks")).rejects.toThrow(/permission denied/);
    await expect(db.query("SELECT * FROM inbound_events")).rejects.toThrow(/permission denied/);
  });
});
