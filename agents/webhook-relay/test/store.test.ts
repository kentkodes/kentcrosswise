import { PGlite } from "@electric-sql/pglite";
import { fromPglite, migrate, type SqlClient } from "@kcw/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GITHUB_SOURCE, sqlRelayStore } from "../src/index";

describe("sqlRelayStore on PGlite (migrations applied, as orch_rw)", () => {
  let pg: PGlite;
  let db: SqlClient;

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
    `);
    await pg.exec("SET ROLE orch_rw");
  });
  afterAll(async () => {
    await pg.close();
  });

  it("claims a delivery once", async () => {
    const s = sqlRelayStore(db);
    expect(await s.claimDelivery("d-1", GITHUB_SOURCE)).toBe(true);
    expect(await s.claimDelivery("d-1", GITHUB_SOURCE)).toBe(false);
    const { rows } = await db.query<{ source: string }>("SELECT source FROM inbound_events WHERE delivery_id = 'd-1'");
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
    const { rows } = await db.query<{ dedupe_key: string; kind: string; agent: string; minutes: string; cost_usd: string; task_id: string | null; ts: Date }>(
      "SELECT dedupe_key, kind, agent, minutes, cost_usd, task_id, ts FROM usage_events ORDER BY dedupe_key",
    );
    expect(rows.map((r) => [r.dedupe_key, r.kind, r.agent, Number(r.minutes), Number(r.cost_usd), r.task_id === null ? null : Number(r.task_id)])).toEqual([
      ["github:workflow_run:7:1", "actions_minutes", "developer", 7.5, 0, 2],
      ["github:workflow_run:8:1", "actions_minutes", "developer", 7.5, 0, null],
      ["github:workflow_run:9:1", "actions_minutes", "developer", 7.5, 0, null],
    ]);
    expect(new Date(rows[0]!.ts).toISOString()).toBe("2026-10-22T10:07:30.000Z");
  });

  it("runs with the role's grants only", async () => {
    const { rows } = await db.query<{ current_user: string }>("SELECT current_user");
    expect(rows[0]!.current_user).toBe("orch_rw");
  });
});
