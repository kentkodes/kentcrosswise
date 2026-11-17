import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, type SqlClient } from "../src/index";
import { freshDb } from "./helpers";

// 0021 task_revisions, task_attempts, task_evidence (AR5b). The queries are the ones in
// agents/orchestrator/src/graph/store.ts, run as a non-superuser login that is a plain member of
// orch_rw, like orch_app in prod (SET ROLE, as in github-operations.test.ts).
const LOGIN = "orch_rev_test_app";
const HASH = "a".repeat(64);
const SHA = "b".repeat(40);
const KEY = "task-1/dispatch/0";

describe("0021 task revisions, attempts and evidence", () => {
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

  const cols = async (table: string) =>
    (
      await db.query<{ column_name: string; data_type: string; is_nullable: string }>(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
        [table],
      )
    ).rows.map((r) => `${r.column_name} ${r.data_type} ${r.is_nullable}`);

  const insRevision =
    "INSERT INTO task_revisions (task_id, revision, contract_hash, contract) VALUES ($1, $2, $3, $4) ON CONFLICT (task_id, revision) DO NOTHING";
  const insAttempt = `INSERT INTO task_attempts (effect_key, task_id, revision, role, op, contract_hash, base_sha, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (effect_key) DO NOTHING`;
  const insEvidence = `INSERT INTO task_evidence (effect_key, task_id, revision, kind, head_sha, outcome, attempt_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (effect_key) DO NOTHING`;

  it("has the spec's columns and no foreign key", async () => {
    expect(await cols("task_revisions")).toEqual([
      "task_id bigint NO",
      "revision integer NO",
      "contract_hash text NO",
      "contract jsonb NO",
      "created_at timestamp with time zone NO",
      "superseded_at timestamp with time zone YES",
    ]);
    expect(await cols("task_attempts")).toEqual([
      "effect_key text NO",
      "task_id bigint NO",
      "revision integer YES",
      "role text NO",
      "op integer NO",
      "contract_hash text YES",
      "base_sha text YES",
      "run_id bigint YES",
      "started_at timestamp with time zone YES",
      "ended_at timestamp with time zone YES",
      "outcome text YES",
      "created_at timestamp with time zone NO",
    ]);
    expect(await cols("task_evidence")).toEqual([
      "effect_key text NO",
      "task_id bigint NO",
      "revision integer YES",
      "kind text NO",
      "head_sha text NO",
      "outcome text NO",
      "attempt_key text YES",
      "created_at timestamp with time zone NO",
      "superseded_at timestamp with time zone YES",
    ]);
    for (const t of ["task_revisions", "task_attempts", "task_evidence"]) {
      const fk = await db.query(`SELECT 1 FROM pg_constraint WHERE conrelid = 'public.${t}'::regclass AND contype = 'f'`);
      expect(fk.rows, t).toEqual([]);
    }
    const idx = await db.query<{ tablename: string }>(
      "SELECT tablename FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('task_attempts_task_id_idx', 'task_evidence_task_id_idx') ORDER BY tablename",
    );
    expect(idx.rows.map((r) => r.tablename)).toEqual(["task_attempts", "task_evidence"]);
    expect((await loadMigrations()).find((x) => x.version === "0021")?.name).toBe("task_revisions");
  });

  it("limits hashes, revisions, roles, outcomes and the kind and outcome pair", async () => {
    const bad = [
      `INSERT INTO task_revisions (task_id, revision, contract_hash, contract) VALUES (1, 0, '${HASH}', '{}')`,
      "INSERT INTO task_revisions (task_id, revision, contract_hash, contract) VALUES (1, 1, 'xyz', '{}')",
      `INSERT INTO task_attempts (effect_key, task_id, role, op) VALUES ('', 1, 'qa', 0)`,
      `INSERT INTO task_attempts (effect_key, task_id, role, op) VALUES ('k', 1, 'scraper', 0)`,
      `INSERT INTO task_attempts (effect_key, task_id, role, op) VALUES ('k', 1, 'qa', -1)`,
      `INSERT INTO task_attempts (effect_key, task_id, role, op, outcome) VALUES ('k', 1, 'qa', 0, 'done')`,
      `INSERT INTO task_attempts (effect_key, task_id, role, op, base_sha) VALUES ('k', 1, 'qa', 0, 'abc')`,
      `INSERT INTO task_attempts (effect_key, task_id, role, op, contract_hash) VALUES ('k', 1, 'qa', 0, 'abc')`,
      `INSERT INTO task_attempts (effect_key, task_id, revision, role, op) VALUES ('k', 1, 0, 'qa', 0)`,
      `INSERT INTO task_evidence (effect_key, task_id, kind, head_sha, outcome) VALUES ('k', 1, 'ci', '${SHA}', 'approved')`,
      `INSERT INTO task_evidence (effect_key, task_id, kind, head_sha, outcome) VALUES ('k', 1, 'qa', '${SHA}', 'success')`,
      `INSERT INTO task_evidence (effect_key, task_id, kind, head_sha, outcome) VALUES ('k', 1, 'lint', '${SHA}', 'success')`,
      `INSERT INTO task_evidence (effect_key, task_id, kind, head_sha, outcome) VALUES ('k', 1, 'ci', '', 'success')`,
    ];
    for (const sql of bad) await expect(db.exec(sql), sql).rejects.toThrow();
    // A docs task has no revision and no hash.
    await db.exec(`INSERT INTO task_attempts (effect_key, task_id, role, op) VALUES ('docs', 1, 'docs', 0)`);
    await db.exec("DELETE FROM task_attempts");
  });

  it("orch_rw runs the store's queries; a second insert under one key writes nothing", async () => {
    const at = "2026-11-17T10:00:00.000Z";
    await asOrch(insRevision, [1, 1, HASH, JSON.stringify({ v: 1 })]);
    await asOrch(insRevision, [1, 1, "c".repeat(64), JSON.stringify({ v: 2 })]);
    expect(await asOrch<{ contract_hash: string }>("SELECT contract_hash FROM task_revisions WHERE task_id = 1")).toEqual([{ contract_hash: HASH }]);

    await asOrch(insAttempt, [KEY, 1, 1, "qa", 0, HASH, SHA, at]);
    await asOrch(insAttempt, [KEY, 1, 1, "qa", 0, HASH, SHA, at]);
    // updateAttempt: each field set once, the start guarded by the attempt's hash.
    const upd = `UPDATE task_attempts SET
         run_id = COALESCE(run_id, $2),
         started_at = CASE WHEN $3::timestamptz IS NOT NULL AND contract_hash IS NOT DISTINCT FROM $4 THEN COALESCE(started_at, $3::timestamptz) ELSE started_at END,
         ended_at = COALESCE(ended_at, $5::timestamptz),
         outcome = COALESCE(outcome, $6)
       WHERE effect_key = $1`;
    await asOrch(upd, [KEY, 77, at, "c".repeat(64), null, null]); // another revision's hash: no start
    await asOrch(upd, [KEY, null, at, HASH, null, null]);
    await asOrch(upd, [KEY, 78, "2026-11-17T11:00:00.000Z", HASH, at, "succeeded"]);
    const [a] = await asOrch<{ run_id: number; started_at: Date; outcome: string; ended_at: Date }>("SELECT run_id, started_at, ended_at, outcome FROM task_attempts WHERE effect_key = $1", [KEY]);
    expect(a).toMatchObject({ run_id: 77, outcome: "succeeded" });
    expect(new Date(a!.started_at).toISOString()).toBe(at);

    await asOrch(insEvidence, ["task-1/evidence/qa/h/1/0", 1, 1, "qa", SHA, "approved", KEY, at]);
    await asOrch(insEvidence, ["task-1/evidence/qa/h/1/0", 1, 1, "qa", SHA, "changes_requested", KEY, at]);
    expect(await asOrch("SELECT outcome FROM task_evidence")).toEqual([{ outcome: "approved" }]);

    // supersedeRevision's statements.
    await asOrch("UPDATE task_revisions SET superseded_at = now() WHERE task_id = $1 AND revision = $2 AND superseded_at IS NULL", [1, 1]);
    await asOrch("UPDATE task_attempts SET outcome = 'superseded', ended_at = now() WHERE task_id = $1 AND revision = $2 AND outcome IS NULL", [1, 1]);
    await asOrch("UPDATE task_evidence SET superseded_at = now() WHERE task_id = $1 AND revision = $2 AND kind = 'qa' AND superseded_at IS NULL", [1, 1]);
    expect((await asOrch<{ s: boolean }>("SELECT superseded_at IS NOT NULL AS s FROM task_evidence"))[0]).toEqual({ s: true });
    // loadValidity's reads.
    await asOrch("SELECT revision, superseded_at FROM task_revisions WHERE task_id = $1 ORDER BY revision", [1]);
    await asOrch("SELECT effect_key, revision, op, started_at FROM task_attempts WHERE task_id = $1 AND role = 'qa' AND revision IS NOT DISTINCT FROM $2 ORDER BY op", [1, 1]);
    await asOrch("SELECT kind, revision, head_sha, outcome, attempt_key, superseded_at FROM task_evidence WHERE task_id = $1 AND head_sha = $2 ORDER BY created_at", [1, SHA]);
  });

  it("orch_rw cannot rewrite identities or delete; no other role has any right", async () => {
    const denied = [
      "UPDATE task_revisions SET contract_hash = 'x'",
      "UPDATE task_revisions SET contract = '{}'",
      "UPDATE task_attempts SET task_id = 2",
      "UPDATE task_attempts SET contract_hash = NULL",
      "UPDATE task_attempts SET base_sha = NULL",
      "UPDATE task_attempts SET revision = 2",
      "UPDATE task_evidence SET outcome = 'approved'",
      "UPDATE task_evidence SET head_sha = 'x'",
      "UPDATE task_evidence SET attempt_key = NULL",
      "DELETE FROM task_revisions",
      "DELETE FROM task_attempts",
      "DELETE FROM task_evidence",
    ];
    for (const sql of denied) await expect(asOrch(sql), sql).rejects.toThrow(/permission denied/);
    for (const table of ["task_revisions", "task_attempts", "task_evidence"]) {
      for (const role of ["web_public", "pipeline_rw", "web_rw", "relay_rw"]) {
        const { rows } = await db.query<{ any: boolean }>(
          `SELECT has_any_column_privilege($1, $2, 'SELECT')
               OR has_any_column_privilege($1, $2, 'INSERT')
               OR has_any_column_privilege($1, $2, 'UPDATE') AS any`,
          [role, `public.${table}`],
        );
        expect(rows, `${role} ${table}`).toEqual([{ any: false }]);
      }
    }
  });
});
