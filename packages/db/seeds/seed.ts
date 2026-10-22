// Synthetic seed for CI preview branches and local dev. Data comes only from
// @kcw/demo-data (deterministic, fake people). Never put real data here.
import { generateDemoData, type DemoData, type GenerateOptions } from "@kcw/demo-data";
import type { SqlClient } from "../src/client";

export interface SeedResult {
  /** Rows inserted per table (0 for rows that already existed). */
  inserted: Record<string, number>;
}

type Row = readonly unknown[];

function isDemoData(x: DemoData | GenerateOptions): x is DemoData {
  return Array.isArray((x as Partial<DemoData>).entries);
}

async function insertMany(db: SqlClient, table: string, columns: readonly string[], rows: readonly Row[], conflict: string) {
  let n = 0;
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT ${conflict} DO NOTHING RETURNING 1`;
  for (const row of rows) {
    const res = await db.query(sql, row);
    n += res.rows.length;
  }
  return n;
}

/**
 * Inserts the demo data. Idempotent: ids are deterministic, so a second run inserts nothing.
 * Runs in one transaction.
 */
export async function seedDemo(db: SqlClient, input: DemoData | GenerateOptions = {}): Promise<SeedResult> {
  const d = isDemoData(input) ? input : generateDemoData(input);
  const inserted: Record<string, number> = {};
  await db.exec("BEGIN");
  try {
    inserted.contacts = await insertMany(
      db,
      "contacts",
      ["id", "name", "aliases", "how_known", "birthday", "notes", "tags"],
      d.contacts.map((c) => [c.id, c.name, c.aliases, c.howKnown, c.birthday, c.notes, c.tags]),
      "(id)",
    );
    inserted.entries = await insertMany(
      db,
      "entries",
      ["id", "created_at", "source", "raw_text", "route_kind", "route_confidence", "route_model", "routed_by", "status"],
      d.entries.map((e) => [
        e.id, e.createdAt, e.source, e.rawText, e.routeKind, e.routeConfidence, e.routeModel, e.routedBy, e.status,
      ]),
      "(id)",
    );
    inserted.crm_notes = await insertMany(
      db,
      "crm_notes",
      ["id", "entry_id", "contact_id", "body", "link_status"],
      d.crmNotes.map((n) => [n.id, n.entryId, n.contactId, n.body, n.linkStatus]),
      "(id)",
    );
    inserted.diary_entries = await insertMany(
      db,
      "diary_entries",
      ["id", "entry_id", "body", "written_at"],
      d.diaryEntries.map((x) => [x.id, x.entryId, x.body, x.writtenAt]),
      "(id)",
    );
    inserted.mood_scores = await insertMany(
      db,
      "mood_scores",
      [
        "diary_entry_id", "energy", "stress", "happiness", "satisfaction", "sadness", "anger", "anxiety",
        "gratitude", "sentiment", "model", "scored_at",
      ],
      d.moods.map((m) => [
        m.diaryEntryId, m.energy, m.stress, m.happiness, m.satisfaction, m.sadness, m.anger, m.anxiety,
        m.gratitude, m.sentiment, m.model, m.scoredAt,
      ]),
      "(diary_entry_id)",
    );
    inserted.todos = await insertMany(
      db,
      "todos",
      ["id", "entry_id", "body", "done", "created_at"],
      d.todos.map((t) => [t.id, t.entryId, t.body, t.done, t.createdAt]),
      "(id)",
    );
    inserted.ideas = await insertMany(
      db,
      "ideas",
      ["id", "entry_id", "body", "status", "created_at"],
      d.ideas.map((i) => [i.id, i.entryId, i.body, i.status, i.createdAt]),
      "(id)",
    );
    inserted.social_accounts = await insertMany(
      db,
      "social_accounts",
      ["id", "platform", "handle", "ingest"],
      d.socialAccounts.map((a) => [a.id, a.platform, a.handle, a.ingest]),
      "(id)",
    );
    inserted.social_snapshots = await insertMany(
      db,
      "social_snapshots",
      ["account_id", "day", "followers", "views", "followers_exact"],
      d.socialSnapshots.map((s) => [s.accountId, s.day, s.followers, s.views, s.followersExact]),
      "(account_id, day)",
    );
    inserted.projects = await insertMany(
      db,
      "projects",
      ["slug", "title", "sort"],
      d.projects.map((p) => [p.slug, p.title, p.sort]),
      "(slug)",
    );
    inserted.essay_prefs = await insertMany(
      db,
      "essay_prefs",
      ["id", "types", "lengths"],
      [[1, ["argumentative", "personal_memoir", "science_nature"], ["short", "medium"]]],
      "(id)",
    );
    await db.exec("COMMIT");
  } catch (err) {
    await db.exec("ROLLBACK");
    throw err;
  }
  return { inserted };
}
