import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, type SqlClient } from "../src/index";
import { freshDb } from "./helpers";

// 0012 github_operations (AR2 slice 2a). The queries are the ones in
// agents/orchestrator/src/graph/store.ts (beginOperation, updateOperation), run as a non-superuser
// login that is a plain member of orch_rw, like orch_app in prod (SET ROLE, as in outbox.test.ts).
const LOGIN = "orch_test_app";
const KEY = "task-1/dispatch/0";

describe("0012 github_operations", () => {
  let pg: PGlite;
  let db: SqlClient;
  beforeAll(async () => {
    ({ pg, db } = await freshDb());
    await db.exec(`CREATE ROLE ${LOGIN} LOGIN; GRANT orch_rw TO ${LOGIN};`);
  });
  afterAll(async () => {
    await pg.close();
  });

  async function asOrch<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    await db.exec(`SET ROLE ${LOGIN}`);
    try {
      const { rows } = await db.query<{ su: boolean }>("SELECT rolsuper AS su FROM pg_roles WHERE rolname = current_user");
      expect(rows).toEqual([{ su: false }]);
      return (await db.query<T>(sql, params)).rows;
    } finally {
      await db.exec("RESET ROLE");
    }
  }

  const begin = `INSERT INTO github_operations (effect_key, task_id, kind, request_hash, state, created_at)
       VALUES ($1, $2, $3, $4, 'intent', $5) ON CONFLICT (effect_key) DO NOTHING RETURNING effect_key`;

  it("has the spec's columns and no foreign key", async () => {
    const { rows } = await db.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'github_operations' ORDER BY ordinal_position`,
    );
    expect(rows.map((r) => `${r.column_name} ${r.data_type} ${r.is_nullable}`)).toEqual([
      "effect_key text NO",
      "task_id bigint NO",
      "kind text NO",
      "request_hash text NO",
      "state text NO",
      "result jsonb YES",
      "created_at timestamp with time zone NO",
      "updated_at timestamp with time zone NO",
    ]);
    const fk = await db.query("SELECT 1 FROM pg_constraint WHERE conrelid = 'public.github_operations'::regclass AND contype = 'f'");
    expect(fk.rows).toEqual([]);
    const m = (await loadMigrations()).find((x) => x.version === "0012");
    expect(m?.name).toBe("github_operations");
  });

  it("limits the key, kind and state", async () => {
    const bad = [
      "INSERT INTO github_operations (effect_key, task_id, kind, request_hash, state) VALUES ('', 1, 'issue', 'h', 'intent')",
      `INSERT INTO github_operations (effect_key, task_id, kind, request_hash, state) VALUES ('${"x".repeat(201)}', 1, 'issue', 'h', 'intent')`,
      "INSERT INTO github_operations (effect_key, task_id, kind, request_hash, state) VALUES ('k', 1, 'check', 'h', 'intent')",
      "INSERT INTO github_operations (effect_key, task_id, kind, request_hash, state) VALUES ('k', 1, 'issue', 'h', 'failed')",
    ];
    for (const sql of bad) await expect(db.exec(sql), sql).rejects.toThrow();
    await db.exec(`INSERT INTO github_operations (effect_key, task_id, kind, request_hash, state) VALUES ('${"x".repeat(200)}', 1, 'plan', 'h', 'done')`);
    await db.exec("DELETE FROM github_operations");
  });

  it("orch_rw runs the store's queries: one intent per key, then the result", async () => {
    const at = "2026-11-14T10:00:00.000Z";
    expect(await asOrch(begin, [KEY, 1, "dispatch", "h1", at])).toHaveLength(1);
    expect(await asOrch(begin, [KEY, 1, "dispatch", "h2", "2026-11-14T11:00:00.000Z"])).toEqual([]); // the key is taken
    const read = "SELECT effect_key, kind, request_hash, state, result, created_at FROM github_operations WHERE effect_key = $1";
    const [row] = await asOrch<{ request_hash: string; state: string; result: unknown; created_at: Date }>(read, [KEY]);
    expect(row).toMatchObject({ request_hash: "h1", state: "intent", result: null });
    expect(new Date(row!.created_at).toISOString()).toBe(at);
    await asOrch("UPDATE github_operations SET state = $2, result = $3, updated_at = now() WHERE effect_key = $1", [KEY, "done", JSON.stringify({ runId: 7 })]);
    expect((await asOrch<{ state: string; result: unknown }>(read, [KEY]))[0]).toMatchObject({ state: "done", result: { runId: 7 } });
  });

  it("orch_rw can neither rewrite a record's identity nor delete it; no other role touches it", async () => {
    const denied = [
      "UPDATE github_operations SET request_hash = 'x'",
      "UPDATE github_operations SET kind = 'merge'",
      "UPDATE github_operations SET task_id = 2",
      "UPDATE github_operations SET created_at = now()",
      "DELETE FROM github_operations",
    ];
    for (const sql of denied) await expect(asOrch(sql), sql).rejects.toThrow(/permission denied/);
    for (const role of ["web_public", "pipeline_rw", "web_rw", "relay_rw"]) {
      const { rows } = await db.query<{ any: boolean }>(
        `SELECT has_any_column_privilege($1, 'public.github_operations', 'SELECT')
             OR has_any_column_privilege($1, 'public.github_operations', 'INSERT') AS any`,
        [role],
      );
      expect(rows, role).toEqual([{ any: false }]);
    }
  });
});
