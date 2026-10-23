import type { PGlite } from "@electric-sql/pglite";
import { generateDemoData } from "@kcw/demo-data";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemo } from "../seeds/seed";
import type { SqlClient } from "../src/index";
import { freshDb } from "./helpers";

const OPTS = { seed: "ci-test", days: 20, contacts: 6 };

describe("seedDemo on PGlite", () => {
  let pg: PGlite;
  let db: SqlClient;
  beforeAll(async () => {
    ({ pg, db } = await freshDb());
  });
  afterAll(async () => {
    await pg.close();
  });

  it("inserts every generated row", async () => {
    const data = generateDemoData(OPTS);
    const { inserted } = await seedDemo(db, OPTS);
    expect(inserted).toMatchObject({
      contacts: data.contacts.length,
      entries: data.entries.length,
      diary_entries: 20,
      mood_scores: 20,
      social_snapshots: 60,
      projects: 1,
      essay_prefs: 1,
      tasks: 3,
      agent_events: 13,
      approvals: 2,
    });
    const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM crm_notes WHERE contact_id IS NOT NULL");
    expect(rows[0]?.n).toBe(data.crmNotes.length);
  });

  it("is idempotent", async () => {
    const { inserted } = await seedDemo(db, OPTS);
    expect(Object.values(inserted).every((n) => n === 0)).toBe(true);
  });

  it("seeds agent events whose public titles hide private tasks", async () => {
    const { rows } = await db.query<{ title: string }>("SELECT DISTINCT title FROM v_public_agent_events ORDER BY title");
    expect(rows.map((r) => r.title)).toEqual(["Add a health check page", "Private task"]);
    const pending = await db.query("SELECT 1 FROM approvals WHERE status = 'pending'");
    expect(pending.rows).toHaveLength(2);
  });

  it("stores the same values the generator produced", async () => {
    const data = generateDemoData(OPTS);
    const { rows } = await db.query<{ name: string }>("SELECT name FROM contacts ORDER BY name");
    expect(rows.map((r) => r.name)).toEqual(data.contacts.map((c) => c.name).sort());
  });
});
