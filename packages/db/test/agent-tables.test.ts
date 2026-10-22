import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SqlClient } from "../src/index";
import { freshDb } from "./helpers";

const AGENT_TABLES = [
  "tasks",
  "agent_events",
  "approvals",
  "usage_events",
  "model_prices",
  "inbound_events",
  "system_flags",
];

describe("0002 agent system", () => {
  let pg: PGlite;
  let db: SqlClient;
  beforeAll(async () => {
    ({ pg, db } = await freshDb());
  });
  afterAll(async () => {
    await pg.close();
  });

  async function as<T>(role: string, sql: string, params?: unknown[]): Promise<T[]> {
    await db.exec(`SET ROLE ${role}`);
    try {
      return (await db.query<T>(sql, params)).rows;
    } finally {
      await db.exec("RESET ROLE");
    }
  }

  async function task(fields: { public_title?: string | null; is_private?: boolean } = {}): Promise<number> {
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO tasks (source, owner_text, public_title, is_private)
       VALUES ('console', 'synthetic owner text', $1, $2) RETURNING id::int`,
      [fields.public_title ?? null, fields.is_private ?? false],
    );
    return rows[0]!.id;
  }

  async function event(taskId: number | null, type = "coding"): Promise<number> {
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO agent_events (task_id, agent, event_type, detail)
       VALUES ($1, 'developer', $2, '{"note": "synthetic private detail"}') RETURNING id::int`,
      [taskId, type],
    );
    return rows[0]!.id;
  }

  async function titleOf(eventId: number): Promise<string | undefined> {
    const rows = await as<{ title: string }>("web_public", "SELECT title FROM v_public_agent_events WHERE id = $1", [
      eventId,
    ]);
    return rows[0]?.title;
  }

  it("creates the §3.2 tables and the view", async () => {
    const { rows } = await db.query<{ t: string | null }>(
      "SELECT to_regclass(x)::text AS t FROM unnest($1::text[]) AS x",
      [[...AGENT_TABLES, "v_public_agent_events"]],
    );
    expect(rows.map((r) => r.t)).toEqual([...AGENT_TABLES, "v_public_agent_events"]);
  });

  it("seeds both pause switches, off", async () => {
    const { rows } = await db.query<{ key: string; value: unknown }>("SELECT key, value FROM system_flags ORDER BY key");
    expect(rows).toEqual([
      { key: "agents_paused", value: false },
      { key: "pipelines_paused", value: false },
    ]);
  });

  it("the view shows the public title of a public task", async () => {
    const e = await event(await task({ public_title: "Add a health page" }));
    expect(await titleOf(e)).toBe("Add a health page");
  });

  it("the view returns 'Private task' for private tasks", async () => {
    const e = await event(await task({ public_title: "Something the owner keeps private", is_private: true }));
    expect(await titleOf(e)).toBe("Private task");
  });

  it("the view returns 'Private task' for a null public title", async () => {
    const e = await event(await task({ public_title: null }));
    expect(await titleOf(e)).toBe("Private task");
  });

  it("the view returns 'Private task' for an event without a task", async () => {
    expect(await titleOf(await event(null, "deployed"))).toBe("Private task");
  });

  it("the view exposes only id, ts, agent, event_type, task_no and title", async () => {
    const t = await task({ public_title: "Public title" });
    const e = await event(t, "pr_opened");
    const rows = await as<Record<string, unknown>>("web_public", "SELECT * FROM v_public_agent_events WHERE id = $1", [e]);
    expect(Object.keys(rows[0]!).sort()).toEqual(["agent", "event_type", "id", "task_no", "title", "ts"]);
    expect(rows[0]).toMatchObject({ id: e, agent: "developer", event_type: "pr_opened", title: "Public title" });
    expect(Number(rows[0]!.task_no)).toBe(t);
  });

  it("web_public can select the view", async () => {
    await expect(as("web_public", "SELECT count(*) FROM v_public_agent_events")).resolves.toHaveLength(1);
  });

  it("web_public can read nothing else", async () => {
    // Every table, view, sequence and materialized view outside the system schemas.
    const { rows } = await db.query<{ rel: string; kind: string }>(
      `SELECT format('%I.%I', n.nspname, c.relname) AS rel, c.relkind::text AS kind
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'v', 'm', 'S', 'p', 'f')
         AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'`,
    );
    expect(rows.length).toBeGreaterThan(30);
    const readable: string[] = [];
    for (const { rel, kind } of rows) {
      const privs = kind === "S" ? ["SELECT", "USAGE", "UPDATE"] : ["SELECT", "INSERT", "UPDATE", "DELETE"];
      for (const p of privs) {
        const fn = kind === "S" ? "has_sequence_privilege" : "has_table_privilege";
        const { rows: r } = await db.query<{ ok: boolean }>(`SELECT ${fn}('web_public', $1, $2) AS ok`, [rel, p]);
        if (r[0]!.ok) readable.push(`${p} ${rel}`);
      }
    }
    expect(readable).toEqual(["SELECT public.v_public_agent_events"]);
    // Column-level grants would not show up above (the view's own grant is listed per column too).
    const { rows: cols } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.column_privileges
       WHERE grantee = 'web_public' AND table_name <> 'v_public_agent_events'`,
    );
    expect(cols[0]!.n).toBe(0);
  });

  it("web_public is refused on the tables behind the view", async () => {
    for (const t of [...AGENT_TABLES, "contacts", "schema_migrations"]) {
      await expect(as("web_public", `SELECT * FROM ${t}`), t).rejects.toThrow(/permission denied/);
    }
    await expect(
      as("web_public", "INSERT INTO agent_events (agent, event_type) VALUES ('qa', 'approved')"),
    ).rejects.toThrow(/permission denied/);
  });

  it("orch_rw and web_rw read and write the agent tables", async () => {
    for (const role of ["orch_rw", "web_rw"]) {
      const rows = await as<{ id: number }>(
        role,
        "INSERT INTO tasks (source, owner_text) VALUES ('console', 'synthetic') RETURNING id::int",
      );
      await as(role, "UPDATE tasks SET status = 'planning', waiting_on = 'dev' WHERE id = $1", [rows[0]!.id]);
      await as(role, "INSERT INTO agent_events (task_id, agent, event_type) VALUES ($1, 'orchestrator', 'task_assigned')", [
        rows[0]!.id,
      ]);
      await as(role, "UPDATE system_flags SET value = 'true', updated_at = now() WHERE key = 'agents_paused'");
      for (const t of AGENT_TABLES) await expect(as(role, `SELECT * FROM ${t}`), `${role} ${t}`).resolves.toBeDefined();
    }
  });

  it("orch_rw can create tables in the lg schema but not read owner data", async () => {
    await as("orch_rw", "CREATE TABLE lg.probe (id int)");
    await expect(as("orch_rw", "SELECT * FROM diary_entries")).rejects.toThrow(/permission denied/);
  });

  it("pipeline_rw can insert tasks and events but not read them", async () => {
    await as("pipeline_rw", "INSERT INTO tasks (source, owner_text) VALUES ('pipeline', 'synthetic')");
    await as("pipeline_rw", "INSERT INTO agent_events (agent, event_type) VALUES ('scraper', 'coding')");
    await expect(as("pipeline_rw", "SELECT * FROM tasks")).rejects.toThrow(/permission denied/);
    await expect(as("pipeline_rw", "SELECT * FROM approvals")).rejects.toThrow(/permission denied/);
  });

  it("rejects unknown event types, agents, statuses and over-long public titles", async () => {
    const t = await task();
    await expect(event(t, "exploded")).rejects.toThrow(/check constraint/);
    await expect(
      db.query("INSERT INTO agent_events (agent, event_type) VALUES ('intern', 'coding')"),
    ).rejects.toThrow(/check constraint/);
    await expect(db.query("UPDATE tasks SET status = 'sleeping' WHERE id = $1", [t])).rejects.toThrow(/check constraint/);
    await expect(
      db.query("UPDATE tasks SET public_title = $2 WHERE id = $1", [t, "x".repeat(61)]),
    ).rejects.toThrow(/check constraint/);
  });

  it("tasks default to private and queued", async () => {
    const { rows } = await db.query<{ is_private: boolean; status: string; attempts: number }>(
      "INSERT INTO tasks (source, owner_text) VALUES ('agent_request', 'synthetic') RETURNING is_private, status, attempts",
    );
    expect(rows[0]).toEqual({ is_private: true, status: "queued", attempts: 0 });
  });

  it("thread ids and inbound delivery ids are unique", async () => {
    await db.query("INSERT INTO tasks (source, owner_text, thread_id) VALUES ('console', 's', 'task-x')");
    await expect(
      db.query("INSERT INTO tasks (source, owner_text, thread_id) VALUES ('console', 's', 'task-x')"),
    ).rejects.toThrow(/duplicate key/);
    await db.query("INSERT INTO inbound_events (delivery_id, source) VALUES ('d-1', 'github')");
    await expect(
      db.query("INSERT INTO inbound_events (delivery_id, source) VALUES ('d-1', 'github')"),
    ).rejects.toThrow(/duplicate key/);
  });

  it("approvals have decided_at exactly when decided", async () => {
    await expect(
      db.query("INSERT INTO approvals (kind, status) VALUES ('critical_pr', 'approved')"),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.query("INSERT INTO approvals (kind, reasons) VALUES ('critical_pr', '{\"infra/prod changed\"}')"),
    ).resolves.toBeDefined();
  });

  it("usage events need provider and model for model usage, minutes for Actions", async () => {
    await expect(
      db.query("INSERT INTO usage_events (kind, agent, input_tokens) VALUES ('model', 'qa', 10)"),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.query("INSERT INTO usage_events (kind, agent) VALUES ('actions_minutes', 'qa')"),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.query(
        "INSERT INTO usage_events (kind, agent, provider, model, input_tokens, output_tokens) VALUES ('model', 'qa', 'anthropic', 'claude-haiku-5-5', 10, 2)",
      ),
    ).resolves.toBeDefined();
  });
});
