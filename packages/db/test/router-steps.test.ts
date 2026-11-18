import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, type SqlClient } from "../src/index";
import { freshDb } from "./helpers";

// 0025: router step rows in agent_events (public log slice PL2, DESIGN §4.6). Synthetic text only.
describe("0025 router_steps", () => {
  let pg: PGlite;
  let db: SqlClient;
  let entry: string;
  let task: number;
  beforeAll(async () => {
    ({ pg, db } = await freshDb());
    entry = (await db.query<{ id: string }>("INSERT INTO entries (source, raw_text) VALUES ('web', 'synthetic') RETURNING id")).rows[0]!.id;
    task = Number((await db.query<{ id: string }>("INSERT INTO tasks (source, owner_text) VALUES ('console', 't') RETURNING id")).rows[0]!.id);
  });
  afterAll(async () => {
    await pg.close();
  });

  const insert = (agent: string, type: string, entryId: string | null, taskId: number | null) =>
    db.query("INSERT INTO agent_events (agent, event_type, entry_id, task_id) VALUES ($1, $2, $3, $4)", [agent, type, entryId, taskId]);
  const count = async (sql: string, params: unknown[] = []) => Number((await db.query<{ n: string | number }>(sql, params)).rows[0]!.n);

  it("is migration 0025", async () => {
    expect((await loadMigrations()).find((m) => m.version === "0025")?.name).toBe("router_steps");
  });

  it("accepts every router step for an entry", async () => {
    for (const type of [
      "captured", "routed", "needs_owner", "route_failed", "derived", "contact_linked", "mood_scored",
      "calendar_suggested", "corrected", "confirmed", "contact_chosen", "calendar_added", "calendar_dismissed",
    ]) {
      await insert("router", type, entry, null);
    }
    expect(await count("SELECT count(*) AS n FROM agent_events WHERE entry_id = $1", [entry])).toBe(13);
  });

  it.each([
    ["a router step without an entry", "router", "routed", false, false],
    ["a router step with a task", "router", "routed", true, true],
    ["a development event type for an entry", "router", "merged", true, false],
    ["a development agent with an entry", "developer", "routed", true, false],
    ["a development agent using a router step type", "developer", "routed", false, true],
    ["an unknown type", "router", "nonsense", true, false],
  ])("rejects %s", async (_name, agent, type, withEntry, withTask) => {
    await expect(insert(agent, type, withEntry ? entry : null, withTask ? task : null)).rejects.toThrow();
  });

  it("keeps development events as they were", async () => {
    await insert("developer", "coding", null, task);
    await insert("orchestrator", "failed", null, task);
    expect(await count("SELECT count(*) AS n FROM agent_events WHERE task_id = $1", [task])).toBe(2);
  });

  it("leaves router steps out of the public agent feed and the office outbox", async () => {
    const before = await count("SELECT count(*) AS n FROM office_outbox WHERE source_table = 'agent_events'");
    await insert("router", "captured", entry, null);
    expect(await count("SELECT count(*) AS n FROM office_outbox WHERE source_table = 'agent_events'")).toBe(before);
    expect(await count("SELECT count(*) AS n FROM v_public_agent_events WHERE agent = 'router'")).toBe(0);
    await insert("qa", "approved", null, task);
    expect(await count("SELECT count(*) AS n FROM office_outbox WHERE source_table = 'agent_events'")).toBe(before + 1);
    expect(await count("SELECT count(*) AS n FROM v_public_agent_events WHERE task_no = $1", [task])).toBe(3);
  });

  it("deletes an entry's steps with the entry", async () => {
    const other = (await db.query<{ id: string }>("INSERT INTO entries (source, raw_text) VALUES ('web', 'gone') RETURNING id")).rows[0]!.id;
    await insert("router", "captured", other, null);
    await db.query("DELETE FROM entries WHERE id = $1", [other]);
    expect(await count("SELECT count(*) AS n FROM agent_events WHERE entry_id = $1", [other])).toBe(0);
  });

  it("lets web_rw write a step", async () => {
    await db.exec("BEGIN; SET LOCAL ROLE web_rw;");
    try {
      await insert("router", "routed", entry, null);
    } finally {
      await db.exec("ROLLBACK");
    }
  });
});
