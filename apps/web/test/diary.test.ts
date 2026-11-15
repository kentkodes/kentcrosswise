// H6 diary: body parsing, save, edit (a changed body drops the stale score), delete, list order, the capture-made
// rows (entry_id set), the mood summary line and the mood points query. PGlite only.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { saveEntry } from "../src/server/capture";
import {
  MAX_DIARY_CHARS,
  createDiaryEntry,
  deleteDiaryEntry,
  getDiary,
  isDiaryId,
  listDiary,
  listMoodPoints,
  moodSummaryLine,
  parseDiaryBody,
  updateDiaryBody,
} from "../src/server/diary";
import { runAs } from "../src/server/db";
import type { DbRun } from "../src/server/router";
import { DIARY_NOTICES, diaryNoticeText, savedNotice, scoreNotice } from "../src/app/(owner)/diary/notices";
import { freshDb, pglitePool } from "./pglite";

describe("parseDiaryBody", () => {
  it("refuses empty and whitespace, converts CRLF, and enforces the length limit", () => {
    expect(parseDiaryBody("  \n ")).toEqual({ ok: false, error: "empty" });
    expect(parseDiaryBody(null)).toEqual({ ok: false, error: "empty" });
    expect(parseDiaryBody("a\r\nb")).toEqual({ ok: true, body: "a\nb" });
    expect(parseDiaryBody("x".repeat(MAX_DIARY_CHARS)).ok).toBe(true);
    expect(parseDiaryBody("x".repeat(MAX_DIARY_CHARS + 1))).toEqual({ ok: false, error: "too-long" });
    expect(isDiaryId("8f14e45f-ceea-4671-9d3f-0b1f5c1e2a3b")).toBe(true);
    expect(isDiaryId("x")).toBe(false);
  });
});

describe("notices", () => {
  it("maps every outcome to a known fixed text", () => {
    for (const r of ["scored", "cap", "failed", "changed", "not-found", "off", "none"] as const) {
      expect(Object.hasOwn(DIARY_NOTICES, savedNotice(r))).toBe(true);
    }
    for (const r of ["scored", "cap", "failed", "changed", "gone", "not-found", "off"] as const) {
      expect(Object.hasOwn(DIARY_NOTICES, scoreNotice(r))).toBe(true);
    }
    expect(savedNotice("off")).toBe("saved-score-off");
    expect(scoreNotice("gone")).toBe("not-found");
    expect(diaryNoticeText("<script>")).toBeUndefined();
    expect(diaryNoticeText("__proto__")).toBeUndefined();
  });
});

describe("diary store (web_rw on PGlite)", () => {
  let pg: PGlite;
  const run: DbRun = (fn) => runAs(pglitePool(pg), "web_rw", fn);
  const q = <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => pg.query<R>(sql, params);

  beforeAll(async () => {
    pg = await freshDb();
  });
  afterAll(async () => {
    await pg.close();
  });

  const score = (id: string, sentiment = 0.5, at?: string) =>
    q(
      `INSERT INTO mood_scores (diary_entry_id, energy, stress, happiness, satisfaction, sadness, anger, anxiety, gratitude, sentiment, model)
       VALUES ($1, 0.5, 0.2, 0.7, 0.5, 0.1, 0, 0.3, 1, $2, 'm')`,
      [id, sentiment],
    ).then(() => (at ? q("UPDATE diary_entries SET written_at = $2 WHERE id = $1", [id, at]) : undefined));

  it("saves an entry with a null entry_id and no score", async () => {
    const id = await run((db) => createDiaryEntry(db, "First\n\nSecond"));
    const row = await run((db) => getDiary(db, id));
    expect(row).toMatchObject({ id, body: "First\n\nSecond", entryId: null, mood: null });
    expect(moodSummaryLine(row!.mood)).toBe("Not scored");
  });

  it("lists newest first, with capture-made rows (entry_id set) alongside", async () => {
    const entry = await run((db) => saveEntry(db, "captured text"));
    await q("INSERT INTO diary_entries (entry_id, body, written_at) VALUES ($1, 'from capture', '2030-01-01T00:00:00Z')", [entry]);
    await q("INSERT INTO diary_entries (body, written_at) VALUES ('oldest', '2000-01-01T00:00:00Z')");
    const rows = await run((db) => listDiary(db));
    expect(rows[0]).toMatchObject({ body: "from capture", entryId: entry });
    expect(rows.at(-1)?.body).toBe("oldest");
    const times = rows.map((r) => r.writtenAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it("editing the body drops the old score; the same body keeps it; an unknown id is not-found", async () => {
    const id = await run((db) => createDiaryEntry(db, "v1"));
    await score(id);
    await expect(run((db) => updateDiaryBody(db, id, "v1"))).resolves.toBe("unchanged");
    expect((await run((db) => getDiary(db, id)))?.mood).not.toBeNull();
    await expect(run((db) => updateDiaryBody(db, id, "v2"))).resolves.toBe("changed");
    const after = await run((db) => getDiary(db, id));
    expect(after).toMatchObject({ body: "v2", mood: null });
    await expect(run((db) => updateDiaryBody(db, "8f14e45f-ceea-4671-9d3f-0b1f5c1e2a3b", "x"))).resolves.toBe("not-found");
  });

  it("deletes the entry and cascades the score; deleting twice reports false", async () => {
    const id = await run((db) => createDiaryEntry(db, "to delete"));
    await score(id);
    await expect(run((db) => deleteDiaryEntry(db, id))).resolves.toBe(true);
    expect((await q("SELECT 1 FROM mood_scores WHERE diary_entry_id = $1", [id])).rows).toHaveLength(0);
    expect(await run((db) => getDiary(db, id))).toBeUndefined();
    await expect(run((db) => deleteDiaryEntry(db, id))).resolves.toBe(false);
  });

  it("formats the one-line mood summary", async () => {
    const id = await run((db) => createDiaryEntry(db, "scored"));
    await score(id, -0.4);
    const row = await run((db) => getDiary(db, id));
    expect(moodSummaryLine(row!.mood)).toBe("Sentiment -0.40 · Happiness 0.70 · Stress 0.20");
    expect(moodSummaryLine({ ...row!.mood!, sentiment: 0.4 })).toContain("Sentiment +0.40");
  });

  it("lists mood points oldest first, only scored entries, limited by since", async () => {
    const a = await run((db) => createDiaryEntry(db, "a"));
    const b = await run((db) => createDiaryEntry(db, "b"));
    await run((db) => createDiaryEntry(db, "unscored"));
    await score(a, 0.1, "2031-03-01T00:00:00Z");
    await score(b, 0.9, "2031-03-05T00:00:00Z");
    const all = (await run((db) => listMoodPoints(db))).filter((p) => p.at.startsWith("2031"));
    expect(all.map((p) => p.id)).toEqual([a, b]);
    expect(all[1]).toMatchObject({ sentiment: 0.9, energy: 0.5, gratitude: 1 });
    // The default range starts at 00:00 UTC: an entry one second before the boundary is out, at the boundary it is in.
    const before = await run((db) => createDiaryEntry(db, "just before"));
    const at = await run((db) => createDiaryEntry(db, "at boundary"));
    await score(before, 0.2, "2031-04-09T23:59:59Z");
    await score(at, 0.3, "2031-04-10T00:00:00Z");
    const cut = await run((db) => listMoodPoints(db, "2031-04-10T00:00:00.000Z"));
    expect(cut.map((p) => p.id)).toEqual([at]);
    const since = await run((db) => listMoodPoints(db, "2031-03-03T00:00:00Z"));
    expect(since.map((p) => p.id).filter((id) => id === a || id === b)).toEqual([b]);
  });
});
