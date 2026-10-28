import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromPglite, migrate, type SqlClient } from "../src/index";
import { freshDb } from "./helpers";

// 0005: relay_rw holds exactly what the webhook relay runs (agents/webhook-relay/src/store.ts; its
// store test runs the real queries as a relay_rw member). Like relay_app in prod, the test login is
// a plain member (INHERIT); SET ROLE runs the checks as that login. (Not SET SESSION AUTHORIZATION:
// in PGlite 0.5.11, RESET SESSION AUTHORIZATION leaves the session as that login.)
const LOGIN = "relay_test_app";

describe("0005 relay_rw", () => {
  let pg: PGlite;
  let db: SqlClient;
  beforeAll(async () => {
    ({ pg, db } = await freshDb());
    await db.exec(`
      CREATE ROLE ${LOGIN} LOGIN;
      GRANT relay_rw TO ${LOGIN};
      INSERT INTO tasks (source, owner_text, pr_number, github_issue) VALUES ('console', 'synthetic', 12, 11);
      INSERT INTO inbound_events (delivery_id, source) VALUES ('d-existing', 'github');
    `);
  });
  afterAll(async () => {
    await pg.close();
  });

  async function asRelay<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    await db.exec(`SET ROLE ${LOGIN}`);
    try {
      return (await db.query<T>(sql, params)).rows;
    } finally {
      await db.exec("RESET ROLE");
    }
  }

  it("is a NOLOGIN group role that belongs to no other role", async () => {
    const { rows } = await db.query<{ rolcanlogin: boolean; member_of: number }>(
      `SELECT rolcanlogin, (SELECT count(*)::int FROM pg_auth_members WHERE member = r.oid) AS member_of
         FROM pg_roles r WHERE rolname = 'relay_rw'`,
    );
    expect(rows).toEqual([{ rolcanlogin: false, member_of: 0 }]);
  });

  it("has exactly the relay's grants and nothing more", async () => {
    const tables = await db.query<{ obj: string; priv: string }>(
      `SELECT c.relname AS obj, a.privilege_type AS priv
         FROM pg_class c, aclexplode(c.relacl) a
        WHERE a.grantee = 'relay_rw'::regrole ORDER BY 1, 2`,
    );
    expect(tables.rows).toEqual([{ obj: "inbound_events", priv: "DELETE" }]);

    const columns = await db.query<{ obj: string; priv: string }>(
      `SELECT c.relname || '.' || at.attname AS obj, a.privilege_type AS priv
         FROM pg_attribute at JOIN pg_class c ON c.oid = at.attrelid, aclexplode(at.attacl) a
        WHERE a.grantee = 'relay_rw'::regrole`,
    );
    expect(columns.rows.map((r) => `${r.priv} ${r.obj}`).sort()).toEqual([
      // 0010: the relay maps agent runs by run id (agents/webhook-relay/src/store.ts findDispatch).
      "SELECT agent_dispatches.role",
      "SELECT agent_dispatches.run_id",
      "SELECT agent_dispatches.task_id",
      "INSERT inbound_events.delivery_id",
      "SELECT inbound_events.delivery_id",
      "INSERT inbound_events.source",
      "SELECT tasks.github_issue",
      "SELECT tasks.id",
      "SELECT tasks.pr_number",
      "INSERT usage_events.agent",
      "INSERT usage_events.cost_usd",
      "SELECT usage_events.dedupe_key",
      "INSERT usage_events.dedupe_key",
      "SELECT usage_events.id",
      "INSERT usage_events.kind",
      "INSERT usage_events.minutes",
      "INSERT usage_events.task_id",
      "INSERT usage_events.ts",
    ].sort());

    const schemas = await db.query<{ obj: string; priv: string }>(
      `SELECT n.nspname AS obj, a.privilege_type AS priv
         FROM pg_namespace n, aclexplode(n.nspacl) a
        WHERE a.grantee = 'relay_rw'::regrole ORDER BY 1, 2`,
    );
    expect(schemas.rows).toEqual([{ obj: "public", priv: "USAGE" }]);
  });

  it("runs every statement the relay runs", async () => {
    const claim =
      "INSERT INTO inbound_events (delivery_id, source) VALUES ($1, $2) ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id";
    expect(await asRelay(claim, ["d-1", "github"])).toEqual([{ delivery_id: "d-1" }]);
    expect(await asRelay(claim, ["d-1", "github"])).toEqual([]);
    await asRelay("DELETE FROM inbound_events WHERE delivery_id = $1", ["d-1"]);
    for (const col of ["pr_number", "github_issue"]) {
      const rows = await asRelay<{ id: number }>(`SELECT id FROM tasks WHERE ${col} = $1 ORDER BY id DESC LIMIT 1`, [
        col === "pr_number" ? 12 : 11,
      ]);
      expect(rows.map((r) => Number(r.id))).toEqual([1]);
    }
    const usage = `INSERT INTO usage_events (ts, kind, agent, minutes, cost_usd, task_id, dedupe_key)
      SELECT $1::timestamptz, 'actions_minutes', $2, $3, 0, (SELECT id FROM tasks WHERE id = $4::bigint), $5
      ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`;
    const params = ["2026-10-22T10:07:30.000Z", "developer", 7.5, 1, "github:workflow_run:7:1"];
    expect(await asRelay(usage, params)).toHaveLength(1);
    expect(await asRelay(usage, params)).toEqual([]);
    // Back as the superuser: the rows landed with their defaults, linked to the existing task.
    const { rows } = await db.query<{ n: number; task_id: number; claims: number }>(
      `SELECT count(*)::int AS n, max(task_id)::int AS task_id,
              (SELECT count(*)::int FROM inbound_events WHERE delivery_id = 'd-1') AS claims
         FROM usage_events WHERE id IS NOT NULL`,
    );
    expect(rows).toEqual([{ n: 1, task_id: 1, claims: 0 }]);
    // 0010: the dispatch link lookup.
    await db.exec("INSERT INTO agent_dispatches (run_id, task_id, role) VALUES (40526955264, 1, 'developer')");
    const link = await asRelay<{ task_id: number; role: string }>("SELECT task_id, role FROM agent_dispatches WHERE run_id = $1", [40526955264]);
    expect(link.map((r) => [Number(r.task_id), r.role])).toEqual([[1, "developer"]]);
  });

  it("is refused on other columns of its tables", async () => {
    const denied = [
      "SELECT * FROM inbound_events",
      "SELECT received_at FROM inbound_events",
      "INSERT INTO inbound_events (delivery_id, source, received_at) VALUES ('d-2', 'github', now())",
      "UPDATE inbound_events SET source = 'x'",
      "SELECT owner_text FROM tasks",
      "SELECT * FROM tasks",
      "INSERT INTO tasks (source, owner_text) VALUES ('github', 'x')",
      "UPDATE tasks SET status = 'done'",
      "DELETE FROM tasks",
      "SELECT * FROM usage_events",
      "SELECT cost_usd FROM usage_events",
      "INSERT INTO usage_events (id, kind, agent, minutes, cost_usd) VALUES (gen_random_uuid(), 'actions_minutes', 'qa', 1, 0)",
      "INSERT INTO usage_events (kind, agent, provider, model, cost_usd) VALUES ('model', 'qa', 'p', 'm', 0)",
      "UPDATE usage_events SET cost_usd = 0",
      "DELETE FROM usage_events",
    ];
    for (const sql of denied) await expect(asRelay(sql), sql).rejects.toThrow(/permission denied/);
  });

  it("is refused on every other table, the lg schema and DDL", async () => {
    const denied = [
      "SELECT * FROM agent_events",
      "INSERT INTO agent_events (agent, event_type) VALUES ('qa', 'coding')",
      "SELECT * FROM approvals",
      "SELECT * FROM system_flags",
      "UPDATE system_flags SET value = 'false'",
      "SELECT * FROM model_prices",
      "SELECT * FROM v_public_agent_events",
      "INSERT INTO inbox_items (kind) VALUES ('approval')",
      "SELECT name FROM contacts",
      "SELECT * FROM diary_entries",
      "SELECT * FROM schema_migrations",
      "CREATE TABLE lg.probe (id int)",
      "CREATE TABLE public.probe (id int)",
    ];
    for (const sql of denied) await expect(asRelay(sql), sql).rejects.toThrow(/permission denied/);
  });
});

describe("0005 role creation", () => {
  it("keeps an existing relay_rw role (idempotent like 0001)", async () => {
    const pg = new PGlite();
    try {
      await pg.exec("CREATE ROLE relay_rw NOLOGIN");
      const res = await migrate(fromPglite(pg));
      expect(res.applied).toContain("0005");
      const { rows } = await pg.query<{ ok: boolean }>(
        "SELECT has_column_privilege('relay_rw', 'tasks', 'pr_number', 'SELECT') AS ok",
      );
      expect(rows).toEqual([{ ok: true }]);
    } finally {
      await pg.close();
    }
  });
});
