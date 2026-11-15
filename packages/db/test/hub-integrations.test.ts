import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, type SqlClient } from "../src/index";
import { freshDb } from "./helpers";

// 0018 hub integrations: calendar suggestion columns, the one-per-note index, the delete trigger that closes
// the inbox item, the time-zone checks and the notified_at column.
describe("0018 hub integrations", () => {
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

  async function crmNote(): Promise<string> {
    const { rows } = await db.query<{ id: string }>("INSERT INTO crm_notes (body) VALUES ('synthetic note') RETURNING id");
    return rows[0]!.id;
  }

  // A calendar suggestion for a note, with its open inbox item as the route writes them.
  async function suggestionWithInbox(noteId: string): Promise<{ id: string }> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO calendar_suggestions (crm_note_id, title, start_at) VALUES ($1, 'Synthetic call', now()) RETURNING id`,
      [noteId],
    );
    const id = rows[0]!.id;
    await db.query(
      `INSERT INTO inbox_items (kind, ref_table, ref_id, title) VALUES ('calendar', 'calendar_suggestions', $1, 'Calendar: Synthetic call')`,
      [id],
    );
    return { id };
  }

  async function inboxStatus(refId: string): Promise<{ status: string; resolved: boolean }[]> {
    const { rows } = await db.query<{ status: string; resolved: boolean }>(
      `SELECT status, resolved_at IS NOT NULL AS resolved FROM inbox_items WHERE ref_table = 'calendar_suggestions' AND ref_id = $1`,
      [refId],
    );
    return rows;
  }

  it("is registered and creates the new columns and indexes", async () => {
    expect((await loadMigrations()).find((x) => x.version === "0018")?.name).toBe("hub_integrations");
    const { rows } = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname IN ('calendar_suggestions_note_uq', 'inbox_items_unnotified_idx')`,
    );
    expect(rows.map((r) => r.indexname).sort()).toEqual(["calendar_suggestions_note_uq", "inbox_items_unnotified_idx"]);
  });

  it("allows one calendar suggestion per crm note, and any number without a note", async () => {
    const note = await crmNote();
    await db.query("INSERT INTO calendar_suggestions (crm_note_id, title, start_at) VALUES ($1, 'A', now())", [note]);
    await expect(
      db.query("INSERT INTO calendar_suggestions (crm_note_id, title, start_at) VALUES ($1, 'B', now())", [note]),
    ).rejects.toThrow(/duplicate key|unique/i);
    await db.query("INSERT INTO calendar_suggestions (title, start_at) VALUES ('C', now()), ('D', now())");
  });

  it("deleting a crm note cascades to its suggestion and closes the inbox item, as web_rw", async () => {
    const note = await crmNote();
    const s = await suggestionWithInbox(note);
    await as("web_rw", "DELETE FROM crm_notes WHERE id = $1", [note]);
    const left = await db.query("SELECT 1 FROM calendar_suggestions WHERE id = $1", [s.id]);
    expect(left.rows).toHaveLength(0);
    const inbox = await inboxStatus(s.id);
    expect(inbox).toEqual([{ status: "done", resolved: true }]);
  });

  it("deleting a suggestion closes its open inbox item, and a closed item is left alone", async () => {
    const note = await crmNote();
    const s = await suggestionWithInbox(note);
    await db.query("UPDATE inbox_items SET status = 'done', resolved_at = '2026-01-01T00:00:00Z' WHERE ref_id = $1", [s.id]);
    await as("web_rw", "DELETE FROM calendar_suggestions WHERE id = $1", [s.id]);
    const inbox = await db.query<{ status: string; kept: boolean }>(
      "SELECT status, resolved_at = '2026-01-01T00:00:00Z'::timestamptz AS kept FROM inbox_items WHERE ref_id = $1",
      [s.id],
    );
    expect(inbox.rows).toEqual([{ status: "done", kept: true }]);
  });

  it("checks time_zone on entries and calendar_suggestions", async () => {
    for (const bad of ["''", `'${"x".repeat(65)}'`]) {
      await expect(db.query(`INSERT INTO entries (source, raw_text, time_zone) VALUES ('web', 'x', ${bad})`)).rejects.toThrow(
        /check constraint/,
      );
      await expect(
        db.query(`INSERT INTO calendar_suggestions (title, start_at, time_zone) VALUES ('x', now(), ${bad})`),
      ).rejects.toThrow(/check constraint/);
    }
    await db.query("INSERT INTO entries (source, raw_text, time_zone) VALUES ('web', 'x', 'Asia/Kolkata')");
    await db.query("INSERT INTO calendar_suggestions (title, start_at, time_zone) VALUES ('x', now(), 'America/New_York')");
  });

  it("an old-style insert without the new columns still works and gets safe defaults", async () => {
    const { rows: e } = await db.query<{ time_zone: string | null }>(
      "INSERT INTO entries (source, raw_text) VALUES ('web', 'old') RETURNING time_zone",
    );
    expect(e).toEqual([{ time_zone: null }]);
    const { rows: s } = await db.query<{ crm_note_id: string | null; all_day: boolean; time_zone: string | null; created: boolean }>(
      `INSERT INTO calendar_suggestions (title, start_at) VALUES ('old', now())
       RETURNING crm_note_id, all_day, time_zone, created_at IS NOT NULL AS created`,
    );
    expect(s).toEqual([{ crm_note_id: null, all_day: false, time_zone: null, created: true }]);
    const { rows: i } = await db.query<{ notified_at: string | null }>(
      "INSERT INTO inbox_items (kind, ref_table, ref_id, title) VALUES ('approval', 'tasks', '1', 'old') RETURNING notified_at",
    );
    expect(i).toEqual([{ notified_at: null }]);
  });
});
