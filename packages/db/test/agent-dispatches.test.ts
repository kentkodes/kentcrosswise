import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, type SqlClient } from "../src/index";
import { freshDb } from "./helpers";

// 0010 agent_dispatches (RUN-ID-MAPPING-SPEC §2): the orchestrator stores run id -> task links,
// the relay reads three columns. Grants are checked as non-superuser logins that are plain members
// of orch_rw / relay_rw, like orch_app and relay_app in prod (SET ROLE, as in relay-role.test.ts:
// PGlite 0.5.11 does not undo SET SESSION AUTHORIZATION on RESET).
const ORCH = "orch_test_app";
const RELAY = "relay_test_app";

describe("0010 agent_dispatches", () => {
  let pg: PGlite;
  let db: SqlClient;
  beforeAll(async () => {
    ({ pg, db } = await freshDb());
    await db.exec(`
      CREATE ROLE ${ORCH} LOGIN;
      GRANT orch_rw TO ${ORCH};
      CREATE ROLE ${RELAY} LOGIN;
      GRANT relay_rw TO ${RELAY};
      INSERT INTO tasks (source, owner_text) VALUES ('console', 'synthetic'), ('console', 'synthetic');
    `);
  });
  afterAll(async () => {
    await pg.close();
  });

  async function as<T = Record<string, unknown>>(login: string, sql: string, params?: unknown[]): Promise<T[]> {
    await db.exec(`SET ROLE ${login}`);
    try {
      const { rows } = await db.query<{ su: boolean }>("SELECT rolsuper AS su FROM pg_roles WHERE rolname = current_user");
      expect(rows).toEqual([{ su: false }]);
      return (await db.query<T>(sql, params)).rows;
    } finally {
      await db.exec("RESET ROLE");
    }
  }

  it("bounds its lock wait like 0007 (first statement)", async () => {
    const m = (await loadMigrations()).find((x) => x.version === "0010");
    expect(m?.name).toBe("agent_dispatches");
    const first = m!.sql.split("\n").find((line) => line.trim() !== "" && !line.trim().startsWith("--"));
    expect(first).toBe("SET LOCAL lock_timeout = '5s';");
  });

  it("has the spec's columns and constraints", async () => {
    const { rows } = await db.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'agent_dispatches' ORDER BY ordinal_position`,
    );
    expect(rows).toEqual([
      { column_name: "run_id", data_type: "bigint", is_nullable: "NO" },
      { column_name: "task_id", data_type: "bigint", is_nullable: "NO" },
      { column_name: "role", data_type: "text", is_nullable: "NO" },
      { column_name: "dispatched_at", data_type: "timestamp with time zone", is_nullable: "NO" },
    ]);
    const bad = [
      "INSERT INTO agent_dispatches (run_id, task_id, role) VALUES (0, 1, 'developer')",
      "INSERT INTO agent_dispatches (run_id, task_id, role) VALUES (-1, 1, 'developer')",
      "INSERT INTO agent_dispatches (run_id, task_id, role) VALUES (1, 1, 'orchestrator')",
      "INSERT INTO agent_dispatches (run_id, task_id, role) VALUES (1, 999, 'developer')",
      "INSERT INTO agent_dispatches (run_id, task_id, role) VALUES (NULL, 1, 'developer')",
    ];
    for (const sql of bad) await expect(db.exec(sql), sql).rejects.toThrow();
    await db.exec("INSERT INTO agent_dispatches (run_id, task_id, role) VALUES (9007199254740991, 1, 'developer')");
    await expect(db.exec("INSERT INTO agent_dispatches (run_id, task_id, role) VALUES (9007199254740991, 2, 'qa')")).rejects.toThrow(/duplicate key/);
    await db.exec("DELETE FROM agent_dispatches");
  });

  it("grants exactly orch_rw SELECT, INSERT and relay_rw SELECT on three columns", async () => {
    const table = await db.query<{ grantee: string; priv: string }>(
      `SELECT a.grantee::regrole::text AS grantee, a.privilege_type AS priv
         FROM pg_class c, aclexplode(c.relacl) a
        WHERE c.oid = 'public.agent_dispatches'::regclass AND a.grantee <> c.relowner ORDER BY 1, 2`,
    );
    expect(table.rows).toEqual([
      { grantee: "orch_rw", priv: "INSERT" },
      { grantee: "orch_rw", priv: "SELECT" },
    ]);
    const columns = await db.query<{ grantee: string; obj: string; priv: string }>(
      `SELECT a.grantee::regrole::text AS grantee, at.attname AS obj, a.privilege_type AS priv
         FROM pg_attribute at, aclexplode(at.attacl) a
        WHERE at.attrelid = 'public.agent_dispatches'::regclass ORDER BY 1, 2, 3`,
    );
    expect(columns.rows).toEqual([
      { grantee: "relay_rw", obj: "role", priv: "SELECT" },
      { grantee: "relay_rw", obj: "run_id", priv: "SELECT" },
      { grantee: "relay_rw", obj: "task_id", priv: "SELECT" },
    ]);
    for (const role of ["web_rw", "web_public", "pipeline_rw"]) {
      const { rows } = await db.query<{ any: boolean }>(
        `SELECT has_any_column_privilege($1, 'public.agent_dispatches', 'SELECT')
             OR has_any_column_privilege($1, 'public.agent_dispatches', 'INSERT')
             OR has_any_column_privilege($1, 'public.agent_dispatches', 'UPDATE') AS any`,
        [role],
      );
      expect(rows, role).toEqual([{ any: false }]);
    }
  });

  it("orch_rw (as a non-superuser login) can insert with ON CONFLICT DO NOTHING and read back, never update or delete", async () => {
    const insert = "INSERT INTO agent_dispatches (run_id, task_id, role) VALUES ($1, $2, $3) ON CONFLICT (run_id) DO NOTHING";
    await as(ORCH, insert, [40526955264, 1, "developer"]);
    await as(ORCH, insert, [40526955264, 2, "qa"]); // conflict: kept as is
    expect(
      await as<{ task_id: number; role: string; recent: boolean }>(
        ORCH,
        "SELECT task_id::int AS task_id, role, dispatched_at > now() - interval '1 minute' AS recent FROM agent_dispatches WHERE run_id = $1",
        [40526955264],
      ),
    ).toEqual([{ task_id: 1, role: "developer", recent: true }]);
    await expect(as(ORCH, "UPDATE agent_dispatches SET task_id = 2")).rejects.toThrow(/permission denied/);
    await expect(as(ORCH, "DELETE FROM agent_dispatches")).rejects.toThrow(/permission denied/);
    await expect(as(ORCH, "TRUNCATE agent_dispatches")).rejects.toThrow(/permission denied/);
  });

  it("relay_rw (as a non-superuser login) can read only run_id, task_id and role, and cannot write", async () => {
    await db.exec("INSERT INTO agent_dispatches (run_id, task_id, role) VALUES (777, 2, 'qa') ON CONFLICT DO NOTHING");
    expect(
      await as<{ run_id: number; task_id: number; role: string }>(
        RELAY,
        "SELECT run_id::float8 AS run_id, task_id::int AS task_id, role FROM agent_dispatches WHERE run_id = $1",
        [777],
      ),
    ).toEqual([{ run_id: 777, task_id: 2, role: "qa" }]);
    const denied = [
      "SELECT * FROM agent_dispatches",
      "SELECT dispatched_at FROM agent_dispatches",
      "SELECT run_id FROM agent_dispatches ORDER BY dispatched_at",
      "INSERT INTO agent_dispatches (run_id, task_id, role) VALUES (778, 1, 'developer')",
      "UPDATE agent_dispatches SET role = 'developer'",
      "DELETE FROM agent_dispatches",
    ];
    for (const sql of denied) await expect(as(RELAY, sql), sql).rejects.toThrow(/permission denied/);
  });
});
