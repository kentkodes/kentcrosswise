import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, type SqlClient } from "../src/index";
import { freshDb } from "./helpers";

// 0023 task_releases (AR8a): grants match the sweeper store (orch_rw) and the console reader (web_rw).
const SHA = "a".repeat(40);

describe("0023 task_releases", () => {
  let pg: PGlite;
  let db: SqlClient;
  beforeAll(async () => {
    ({ pg, db } = await freshDb());
    await db.exec("CREATE ROLE rel_orch LOGIN; GRANT orch_rw TO rel_orch; CREATE ROLE rel_web LOGIN; GRANT web_rw TO rel_web;");
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

  const insert = "INSERT INTO task_releases (merge_sha, task_id, pr_number, merged_at) VALUES ($1, 1, 2, now())";

  it("exists, is numbered 0023 and has no foreign key", async () => {
    expect((await loadMigrations()).find((x) => x.version === "0023")?.name).toBe("release_states");
    const fk = await db.query("SELECT 1 FROM pg_constraint WHERE conrelid = 'public.task_releases'::regclass AND contype = 'f'");
    expect(fk.rows).toEqual([]);
  });

  it("refuses a merge sha that is not 40 lowercase hex", async () => {
    for (const bad of ["unknown", "A".repeat(40), "a".repeat(39), "g".repeat(40)]) {
      await expect(db.query(insert, [bad])).rejects.toThrow();
    }
    await as("rel_orch", insert, [SHA]);
    await expect(as("rel_orch", "UPDATE task_releases SET build_id = 'bad id' WHERE merge_sha = $1", [SHA])).rejects.toThrow();
    await expect(as("rel_orch", "UPDATE task_releases SET deploy_sha = 'x' WHERE merge_sha = $1", [SHA])).rejects.toThrow();
    // The failed statements above leave the row untouched.
    expect((await as<{ build_id: string | null }>("rel_orch", "SELECT build_id FROM task_releases"))[0]!.build_id).toBeNull();
  });

  it("orch_rw updates only the evidence columns", async () => {
    await as(
      "rel_orch",
      `UPDATE task_releases SET deploy_run_id = 5, deploy_attempt = 1, deploy_sha = $1, build_id = 'b-1',
              deployed_at = now(), verified_at = now(), failed_at = NULL, checked_at = now() WHERE merge_sha = $1`,
      [SHA],
    );
    await expect(as("rel_orch", "UPDATE task_releases SET merge_sha = $1 WHERE merge_sha = $2", ["b".repeat(40), SHA])).rejects.toThrow(/permission denied/);
    await expect(as("rel_orch", "UPDATE task_releases SET merged_at = now()")).rejects.toThrow(/permission denied/);
    await expect(as("rel_orch", "UPDATE task_releases SET task_id = 9")).rejects.toThrow(/permission denied/);
    await expect(as("rel_orch", "DELETE FROM task_releases")).rejects.toThrow(/permission denied/);
    await expect(as("rel_orch", "INSERT INTO task_releases (merge_sha, task_id, merged_at, verified_at) VALUES ($1, 1, now(), now())", ["c".repeat(40)])).rejects.toThrow(/permission denied/);
  });

  it("web_rw can only select; web_public and others cannot read", async () => {
    expect((await as("rel_web", "SELECT merge_sha FROM task_releases")).length).toBe(1);
    await expect(as("rel_web", insert, ["d".repeat(40)])).rejects.toThrow(/permission denied/);
    await expect(as("rel_web", "UPDATE task_releases SET checked_at = now()")).rejects.toThrow(/permission denied/);
    await expect(as("rel_web", "DELETE FROM task_releases")).rejects.toThrow(/permission denied/);
    for (const role of ["web_public", "pipeline_rw", "relay_rw"]) {
      const { rows } = await db.query<{ any: boolean }>(
        `SELECT has_any_column_privilege($1, 'public.task_releases', 'SELECT')
             OR has_any_column_privilege($1, 'public.task_releases', 'INSERT')
             OR has_any_column_privilege($1, 'public.task_releases', 'UPDATE') AS any`,
        [role],
      );
      expect(rows, role).toEqual([{ any: false }]);
    }
  });
});
