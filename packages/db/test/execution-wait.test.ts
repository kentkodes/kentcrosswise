import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, type SqlClient } from "../src/index";
import { freshDb } from "./helpers";

// 0022 execution_wait (AR6 slice 2). The statements are the ones the console (web_rw) and the
// orchestrator (orch_rw) run: a read of the column and an update of the column alone.
const ORCH = "orch_wait_app";
const WEB = "web_wait_app";

describe("0022 execution_wait", () => {
  let pg: PGlite;
  let db: SqlClient;
  let task: number;
  beforeAll(async () => {
    ({ pg, db } = await freshDb());
    await db.exec(`CREATE ROLE ${ORCH} LOGIN; GRANT orch_rw TO ${ORCH};`);
    await db.exec(`CREATE ROLE ${WEB} LOGIN; GRANT web_rw TO ${WEB};`);
    const { rows } = await db.query<{ id: number }>(
      "INSERT INTO tasks (source, owner_text, status, waiting_on) VALUES ('console', 'synthetic', 'planning', NULL) RETURNING id",
    );
    task = Number(rows[0]!.id);
  });
  afterAll(async () => {
    await pg.close();
  });

  async function as<T = Record<string, unknown>>(role: string, sql: string, params?: unknown[]): Promise<T[]> {
    await db.exec(`SET ROLE ${role}`);
    try {
      return (await db.query<T>(sql, params)).rows;
    } finally {
      await db.exec("RESET ROLE");
    }
  }

  const setWait = "UPDATE tasks SET execution_wait = $2 WHERE id = $1";
  const readWait = "SELECT execution_wait AS w FROM tasks WHERE id = $1";

  it("is migration 0022", async () => {
    expect((await loadMigrations()).find((m) => m.version === "0022")?.name).toBe("execution_wait");
  });

  it("adds a nullable column that starts NULL on every existing row", async () => {
    const col = await db.query<{ is_nullable: string; data_type: string }>(
      "SELECT is_nullable, data_type FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'execution_wait'",
    );
    expect(col.rows).toEqual([{ is_nullable: "YES", data_type: "text" }]);
    expect(await as(ORCH, readWait, [task])).toEqual([{ w: null }]);
  });

  it("refuses any value outside developer, qa and docs", async () => {
    for (const bad of ["dev", "ci", "owner", "Developer", ""]) {
      await expect(as(ORCH, setWait, [task, bad])).rejects.toThrow(/check constraint|execution_wait/);
    }
    await expect(as(WEB, setWait, [task, "dev"])).rejects.toThrow(/check constraint|execution_wait/);
  });

  it("lets orch_rw and web_rw set, read and clear each allowed value", async () => {
    for (const role of [ORCH, WEB]) {
      for (const value of ["developer", "qa", "docs"]) {
        await as(role, setWait, [task, value]);
        expect(await as(role, readWait, [task])).toEqual([{ w: value }]);
      }
      await as(role, setWait, [task, null]);
      expect(await as(role, readWait, [task])).toEqual([{ w: null }]);
    }
  });

  it("writes no office_outbox row for an update of execution_wait alone", async () => {
    const count = async () => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM office_outbox WHERE source_table = 'tasks' AND source_key = $1", [String(task)])).rows[0]!.n;
    const before = await count();
    const version = (await db.query<{ v: string }>("SELECT office_version::text AS v FROM tasks WHERE id = $1", [task])).rows[0]!.v;
    await as(ORCH, setWait, [task, "developer"]);
    await as(WEB, setWait, [task, null]);
    expect(await count()).toBe(before);
    const after = (await db.query<{ v: string }>("SELECT office_version::text AS v FROM tasks WHERE id = $1", [task])).rows[0]!.v;
    expect(after).toBe(version);
  });
});
