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

  it("runs with the role's grants only", async () => {
    const { rows } = await db.query<{ current_user: string }>("SELECT current_user");
    expect(rows[0]!.current_user).toBe("orch_rw");
  });
});
