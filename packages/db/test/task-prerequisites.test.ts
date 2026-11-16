import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, type SqlClient } from "../src/index";
import { freshDb } from "./helpers";

// 0020 task prerequisites (AR4). The statements are the orchestrator's (agents/orchestrator/src/graph/store.ts
// createSubtasks and mergeTask), run as a non-superuser member of orch_rw.
const ORCH = "orch_prereq_app";

describe("0020 task prerequisites", () => {
  let pg: PGlite;
  let db: SqlClient;
  beforeAll(async () => {
    ({ pg, db } = await freshDb());
    await db.exec(`CREATE ROLE ${ORCH} LOGIN; GRANT orch_rw TO ${ORCH};`);
  });
  afterAll(async () => {
    await pg.close();
  });

  async function asOrch<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    await db.exec(`SET ROLE ${ORCH}`);
    try {
      return (await db.query<T>(sql, params)).rows;
    } finally {
      await db.exec("RESET ROLE");
    }
  }

  it("is migration 0020 and bounds its lock wait (first statement)", async () => {
    const m = (await loadMigrations()).find((x) => x.version === "0020");
    expect(m?.name).toBe("task_prerequisites");
    const first = m!.sql.split("\n").find((line) => line.trim() !== "" && !line.trim().startsWith("--"));
    expect(first).toBe("SET LOCAL lock_timeout = '5s';");
  });

  it("adds prerequisites (empty by default) and merge_sha (null by default)", async () => {
    await db.exec("INSERT INTO tasks (source, owner_text) VALUES ('console', 'Synthetic task')");
    const { rows } = await db.query<{ prerequisites: unknown; merge_sha: string | null }>("SELECT prerequisites, merge_sha FROM tasks");
    expect(rows).toEqual([{ prerequisites: [], merge_sha: null }]);
  });

  it("orch_rw stores prerequisites and a task's own merge commit, and enqueues a child start once", async () => {
    const [parent] = await asOrch<{ id: number }>("INSERT INTO tasks (source, owner_text) VALUES ('console', 'Parent') RETURNING id");
    const kids = await asOrch<{ id: number }>(
      "INSERT INTO tasks (parent_id, source, owner_text) VALUES ($1, 'console', 'A'), ($1, 'console', 'B') RETURNING id",
      [parent!.id],
    );
    const [a, b] = kids.map((k) => Number(k.id)) as [number, number];
    await asOrch("UPDATE tasks SET prerequisites = $2::bigint[] WHERE id = $1", [b, [a]]);
    await asOrch("UPDATE tasks SET merge_sha = $2 WHERE id = $1", [a, "a".repeat(40)]);
    const enqueue = `INSERT INTO orchestrator_outbox (message_key, group_id, body)
      SELECT 'task-' || c.id || '/start', 'task-' || c.id,
             json_build_object('type', 'task.created', 'task_id', c.id, 'message_key', 'task-' || c.id || '/start')::text
        FROM tasks c WHERE c.id = ANY($1::bigint[])
      ON CONFLICT (message_key) DO NOTHING`;
    await asOrch(enqueue, [[b]]);
    await asOrch(enqueue, [[b]]);
    const { rows } = await db.query<{ message_key: string; group_id: string; body: string }>(
      "SELECT message_key, group_id, body FROM orchestrator_outbox",
    );
    expect(rows).toEqual([{ message_key: `task-${b}/start`, group_id: `task-${b}`, body: expect.any(String) }]);
    expect(JSON.parse(rows[0]!.body)).toEqual({ type: "task.created", task_id: b, message_key: `task-${b}/start` });
    const [row] = await asOrch<{ prerequisites: number[] }>("SELECT prerequisites FROM tasks WHERE id = $1", [b]);
    expect(row).toEqual({ prerequisites: [a] });
    const [merged] = await asOrch<{ merge_sha: string }>("SELECT merge_sha FROM tasks WHERE id = $1", [a]);
    expect(merged).toEqual({ merge_sha: "a".repeat(40) });
    // Still no outbox reads beyond the drain's columns, no delete.
    for (const sql of ["SELECT last_error FROM orchestrator_outbox", "DELETE FROM orchestrator_outbox"]) {
      await expect(asOrch(sql), sql).rejects.toThrow(/permission denied/);
    }
  });
});
