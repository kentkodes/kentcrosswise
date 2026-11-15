// Diary (H6): long entries the owner writes here, plus entries that the capture box routes to the diary.
// Owner pages only; runs as web_rw. Diary text is private: nothing here logs it. Mood scores live in mood.ts.
import type { Queryable } from "./db";

export const MAX_DIARY_CHARS = 50000;
export const LIST_LIMIT = 200;

export type DiaryParse = { ok: true; body: string } | { ok: false; error: "empty" | "too-long" };

/** A body that is only whitespace is empty. Stored as typed, except CRLF becomes LF. */
export function parseDiaryBody(raw: unknown): DiaryParse {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, error: "empty" };
  const body = raw.replaceAll("\r\n", "\n");
  if (body.length > MAX_DIARY_CHARS) return { ok: false, error: "too-long" };
  return { ok: true, body };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isDiaryId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export const MOOD_KEYS = ["energy", "stress", "happiness", "satisfaction", "sadness", "anger", "anxiety", "gratitude"] as const;
export type MoodKey = (typeof MOOD_KEYS)[number];
export type MoodValues = Record<MoodKey, number> & { sentiment: number };

export interface DiaryRow {
  id: string;
  body: string;
  writtenAt: string;
  /** Null for entries written on the diary page. */
  entryId: string | null;
  mood: (MoodValues & { model: string }) | null;
}

type Raw = {
  id: string;
  body: string;
  written_at: Date | string;
  entry_id: string | null;
  scored: string | null;
  model: string | null;
} & Record<MoodKey | "sentiment", string | null>;

const SELECT = `
SELECT d.id, d.body, d.written_at, d.entry_id, m.diary_entry_id AS scored, m.model,
       m.energy, m.stress, m.happiness, m.satisfaction, m.sadness, m.anger, m.anxiety, m.gratitude, m.sentiment
  FROM diary_entries d
  LEFT JOIN mood_scores m ON m.diary_entry_id = d.id`;

function toRow(r: Raw): DiaryRow {
  const mood =
    r.scored === null
      ? null
      : {
          ...(Object.fromEntries([...MOOD_KEYS, "sentiment" as const].map((k) => [k, Number(r[k])])) as MoodValues),
          model: r.model ?? "",
        };
  return { id: r.id, body: r.body, writtenAt: new Date(r.written_at).toISOString(), entryId: r.entry_id, mood };
}

/** Newest first, at most LIST_LIMIT. */
export async function listDiary(db: Queryable): Promise<DiaryRow[]> {
  const { rows } = await db.query<Raw>(`${SELECT} ORDER BY d.written_at DESC, d.id DESC LIMIT ${LIST_LIMIT}`);
  return rows.map(toRow);
}

export async function getDiary(db: Queryable, id: string): Promise<DiaryRow | undefined> {
  const { rows } = await db.query<Raw>(`${SELECT} WHERE d.id = $1`, [id]);
  return rows[0] ? toRow(rows[0]) : undefined;
}

/** A diary entry written on the diary page (entry_id stays null). */
export async function createDiaryEntry(db: Queryable, body: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>("INSERT INTO diary_entries (body) VALUES ($1) RETURNING id", [body]);
  return rows[0]!.id;
}

/**
 * Replaces the body. A changed body drops the old score in the same transaction (it no longer describes the
 * text), so a failed re-score leaves the entry unscored, never wrongly scored.
 */
export async function updateDiaryBody(db: Queryable, id: string, body: string): Promise<"changed" | "unchanged" | "not-found"> {
  const { rows } = await db.query<{ body: string }>("SELECT body FROM diary_entries WHERE id = $1 FOR UPDATE", [id]);
  if (!rows[0]) return "not-found";
  if (rows[0].body === body) return "unchanged";
  await db.query("UPDATE diary_entries SET body = $2 WHERE id = $1", [id, body]);
  await db.query("DELETE FROM mood_scores WHERE diary_entry_id = $1", [id]);
  return "changed";
}

/** Deletes the entry; its score goes with it (ON DELETE CASCADE). */
export async function deleteDiaryEntry(db: Queryable, id: string): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>("DELETE FROM diary_entries WHERE id = $1 RETURNING id", [id]);
  return rows.length > 0;
}

/** One line for the list: "Sentiment +0.40 · Happiness 0.70 · Stress 0.20", or "Not scored". */
export function moodSummaryLine(mood: DiaryRow["mood"]): string {
  if (!mood) return "Not scored";
  const sign = mood.sentiment > 0 ? "+" : "";
  return `Sentiment ${sign}${mood.sentiment.toFixed(2)} · Happiness ${mood.happiness.toFixed(2)} · Stress ${mood.stress.toFixed(2)}`;
}

export interface MoodPoint extends MoodValues {
  id: string;
  /** UTC ISO time the entry was written. */
  at: string;
}

/** Scored entries oldest first; `since` (ISO) limits the range, undefined means all. */
export async function listMoodPoints(db: Queryable, since?: string): Promise<MoodPoint[]> {
  const { rows } = await db.query<Raw>(
    `${SELECT} WHERE m.diary_entry_id IS NOT NULL AND ($1::timestamptz IS NULL OR d.written_at >= $1::timestamptz)
      ORDER BY d.written_at, d.id`,
    [since ?? null],
  );
  return rows.map((r) => {
    const row = toRow(r);
    return { id: row.id, at: row.writtenAt, ...row.mood! };
  });
}
