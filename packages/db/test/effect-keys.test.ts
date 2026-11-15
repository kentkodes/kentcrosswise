import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, type SqlClient } from "../src/index";
import { freshDb } from "./helpers";

// 0013 effect keys (AR2 slice 3). The queries are the ones in agents/orchestrator/src/graph/store.ts
// (insertEvent, createApproval, recordReport), run as a non-superuser member of orch_rw.
const LOGIN = "orch_keys_app";

describe("0013 effect keys", () => {
  let pg: PGlite;
  let db: SqlClient;
  let task: number;
  beforeAll(async () => {
    ({ pg, db } = await freshDb());
    await db.exec(`CREATE ROLE ${LOGIN} LOGIN; GRANT orch_rw TO ${LOGIN};`);
    const { rows } = await db.query<{ id: number }>("INSERT INTO tasks (source, owner_text) VALUES ('console', 'synthetic') RETURNING id");
    task = Number(rows[0]!.id);
  });
  afterAll(async () => {
    await pg.close();
  });

  async function asOrch<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    await db.exec(`SET ROLE ${LOGIN}`);
    try {
      return (await db.query<T>(sql, params)).rows;
    } finally {
      await db.exec("RESET ROLE");
    }
  }

  const event = "INSERT INTO agent_events (task_id, agent, event_type, detail, effect_key) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (effect_key) DO NOTHING";
  const approval = "INSERT INTO approvals (task_id, kind, reasons, effect_key) VALUES ($1, $2, $3, $4) ON CONFLICT (effect_key) DO NOTHING RETURNING id";
  const usage = `INSERT INTO usage_events (kind, agent, provider, model, input_tokens, output_tokens, task_id, dedupe_key)
             VALUES ('model', $1, $2, $3, $4, $5, $6, $7) ON CONFLICT (dedupe_key) DO NOTHING`;
  const receipt = "INSERT INTO orchestrator_receipts (message_key) VALUES ($1) ON CONFLICT (message_key) DO NOTHING RETURNING message_key";

  it("is migration 0013", async () => {
    expect((await loadMigrations()).find((m) => m.version === "0013")?.name).toBe("effect_keys");
  });

  it("writes a keyed event once and unkeyed events every time", async () => {
    for (let i = 0; i < 2; i++) {
      await asOrch(event, [task, "orchestrator", "ci_running", "{}", "task-1/m1/event/ci_running/0"]);
      await asOrch(event, [task, "orchestrator", "ci_running", "{}", null]);
    }
    const rows = await db.query<{ k: string | null; n: number }>(
      "SELECT effect_key AS k, count(*)::int AS n FROM agent_events WHERE task_id = $1 GROUP BY effect_key ORDER BY effect_key NULLS LAST", [task]);
    expect(rows.rows).toEqual([{ k: "task-1/m1/event/ci_running/0", n: 1 }, { k: null, n: 2 }]);
  });

  it("returns no row for a repeated approval key, and orch_rw can read it back", async () => {
    const key = "task-1/m1/approval/critical_pr/0";
    const first = await asOrch<{ id: string }>(approval, [task, "critical_pr", ["synthetic"], key]);
    expect(first).toHaveLength(1);
    expect(await asOrch(approval, [task, "critical_pr", ["synthetic"], key])).toEqual([]);
    expect(await asOrch("SELECT id FROM approvals WHERE effect_key = $1", [key])).toEqual(first);
  });

  it("lets orch_rw write a report receipt and keyed usage once", async () => {
    expect(await asOrch(receipt, ["report:1:1:end"])).toEqual([{ message_key: "report:1:1:end" }]);
    expect(await asOrch(receipt, ["report:1:1:end"])).toEqual([]);
    for (let i = 0; i < 2; i++) await asOrch(usage, ["qa", "anthropic", "m", 1, 1, task, "report:1:1:review:0"]);
    expect((await db.query("SELECT 1 FROM usage_events WHERE dedupe_key = 'report:1:1:review:0'")).rows).toHaveLength(1);
  });
});
