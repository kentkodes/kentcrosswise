import type { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InputError } from "../src/server/console";
import { runAs, type Queryable } from "../src/server/db";
import {
  EssayNotFoundError,
  authorSurname,
  countFeed,
  externalHref,
  feedHref,
  getReaderEssay,
  likePattern,
  linkSearchHref,
  listFeed,
  listRecommendations,
  parseKind,
  parsePrefs,
  parseRating,
  parseSearch,
  parseShow,
  readPrefs,
  readingMinutesOf,
  saveRating,
  savePrefs,
  surnameInitial,
  type Prefs,
} from "../src/server/essay-library";
import { freshDb, pglitePool } from "./pglite";

interface Fixture {
  title: string;
  author: string;
  year?: number | null;
  words?: number | null;
  types: string[];
  status?: "active" | "quarantined" | "pending_category";
  kind?: "full" | "link";
  hook?: string | null;
  sourceUrl?: string | null;
  createdAt: string;
}

describe("essay library as web_rw", () => {
  let pg: PGlite;
  const asRw = <T>(fn: (db: Queryable) => Promise<T>, opts?: { readOnly?: boolean }) => runAs(pglitePool(pg), "web_rw", fn, opts);

  async function addEssay(f: Fixture): Promise<string> {
    const link = f.kind === "link";
    const { rows } = await pg.query<{ id: string }>(
      `INSERT INTO essays (kind, title, author, year, word_count, hook, source_url, text_hash, text_s3_key, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        link ? "link" : "full",
        f.title,
        f.author,
        f.year ?? null,
        f.words ?? null,
        f.hook ?? null,
        f.sourceUrl ?? null,
        link ? null : randomUUID(),
        link ? null : `essays/text/${randomUUID()}.txt`,
        f.status ?? "active",
        f.createdAt,
      ],
    );
    const id = rows[0]!.id;
    for (const [i, type] of f.types.entries()) {
      await pg.query("INSERT INTO essay_categories (essay_id, type, confidence, model) VALUES ($1, $2, $3, 'test')", [id, type, 0.9 - i * 0.1]);
    }
    return id;
  }

  let hurston: string;
  let quarantined: string;
  let eliot: string;
  let pending: string;
  let hurstonMulti: string;

  beforeAll(async () => {
    pg = await freshDb();
    await addEssay({ title: "Roast Pig", author: "Lamb", year: 1822, words: 1500, types: ["cultural"], createdAt: "2026-01-01T00:00:00Z" });
    hurston = await addEssay({
      title: "How It Feels",
      author: "Hurston",
      year: 1937,
      words: 3000,
      types: ["personal_memoir"],
      hook: "A hook.",
      createdAt: "2026-02-01T00:00:00Z",
    });
    await addEssay({ title: "Sitting in Darkness", author: "Twain", year: 1900, words: 9000, types: ["political"], createdAt: "2026-03-01T00:00:00Z" });
    quarantined = await addEssay({ title: "Bad copy", author: "Nobody", words: 1000, types: ["cultural"], status: "quarantined", createdAt: "2026-04-01T00:00:00Z" });
    eliot = await addEssay({
      title: "Paywalled",
      author: "Eliot",
      year: 1944,
      kind: "link",
      types: ["critical"],
      sourceUrl: "https://example.com/essay",
      createdAt: "2026-05-01T00:00:00Z",
    });
    pending = await addEssay({ title: "Uncategorized", author: "Anon", words: 2000, types: [], status: "pending_category", createdAt: "2026-06-01T00:00:00Z" });
    // Cultural is listed first, so it is the primary type (highest confidence).
    hurstonMulti = await addEssay({ title: "Mules and Men", author: "Hurston", year: 1938, words: 5000, types: ["cultural", "travel"], createdAt: "2026-07-01T00:00:00Z" });
  });
  afterAll(async () => {
    await pg.close();
  });

  it("reads empty prefs before any save, then saves and overwrites the singleton row", async () => {
    await expect(asRw((db) => readPrefs(db))).resolves.toEqual({ types: [], lengths: [] });
    await asRw((db) => savePrefs(db, { types: ["political", "cultural"], lengths: ["long"] }));
    await expect(asRw((db) => readPrefs(db))).resolves.toEqual({ types: ["political", "cultural"], lengths: ["long"] });
    await asRw((db) => savePrefs(db, { types: [], lengths: [] }));
    await expect(asRw((db) => readPrefs(db))).resolves.toEqual({ types: [], lengths: [] });
    const { rows } = await pg.query<{ n: number; id: number }>("SELECT count(*)::int AS n, min(id) AS id FROM essay_prefs");
    expect(rows[0]).toEqual({ n: 1, id: 1 });
  });

  it("validates prefs against the allowlists and canonicalises them", () => {
    expect(parsePrefs(["travel", "cultural", "travel"], ["long", "short"])).toEqual({ types: ["cultural", "travel"], lengths: ["short", "long"] });
    expect(() => parsePrefs(["sports"], [])).toThrow(InputError);
    expect(() => parsePrefs([], ["huge"])).toThrow(InputError);
    expect(() => parsePrefs([42], [])).toThrow(InputError);
  });

  it("feeds active essays newest first when prefs are empty (quarantined and pending are never shown)", async () => {
    const prefs = { types: [], lengths: [] };
    const { cards, hasMore } = await asRw((db) => listFeed(db, prefs, 20));
    // Full-text essays first (newest first), then link-only essays, even though the link is newer.
    expect(cards.map((c) => c.title)).toEqual(["Mules and Men", "Sitting in Darkness", "How It Feels", "Roast Pig", "Paywalled"]);
    expect(cards.findIndex((c) => c.kind === "link")).toBe(4);
    expect(hasMore).toBe(false);
    const multi = cards.find((c) => c.id === hurstonMulti)!;
    expect(multi.primaryType).toBe("cultural");
    expect(multi.types).toEqual(["cultural", "travel"]);
    expect(cards.find((c) => c.id === eliot)!.lengthBand).toBeNull();
    expect(cards.map((c) => c.id)).not.toContain(quarantined);
    expect(cards.map((c) => c.id)).not.toContain(pending);
  });

  it("paginates with one extra row to detect more", async () => {
    const first = await asRw((db) => listFeed(db, { types: [], lengths: [] }, 2));
    expect(first.cards.map((c) => c.title)).toEqual(["Mules and Men", "Sitting in Darkness"]);
    expect(first.hasMore).toBe(true);
  });

  it("filters by type (any matching category) and by length band", async () => {
    const byType = await asRw((db) => listFeed(db, { types: ["cultural"], lengths: [] }, 20));
    expect(byType.cards.map((c) => c.title)).toEqual(["Mules and Men", "Roast Pig"]);
    // Link-only essays bypass the length filter (they have no text); full essays still need a band.
    const byLength = await asRw((db) => listFeed(db, { types: [], lengths: ["short"] }, 20));
    expect(byLength.cards.map((c) => c.title)).toEqual(["Roast Pig", "Paywalled"]);
    const allLengths = await asRw((db) => listFeed(db, { types: [], lengths: ["short", "medium", "long"] }, 20));
    expect(allLengths.cards.map((c) => c.id)).toContain(eliot);
    const both = await asRw((db) => listFeed(db, { types: ["political"], lengths: ["medium"] }, 20));
    expect(both.cards).toEqual([]);
  });

  it("hides a full-text essay with no word count under an active length filter", async () => {
    const unmeasured = await addEssay({ title: "Unmeasured", author: "Nobody", types: ["cultural"], createdAt: "2025-01-01T00:00:00Z" });
    try {
      const none = await asRw((db) => listFeed(db, { types: [], lengths: [] }, 50));
      expect(none.cards.map((c) => c.id)).toContain(unmeasured);
      const short = await asRw((db) => listFeed(db, { types: [], lengths: ["short"] }, 50));
      expect(short.cards.map((c) => c.id)).not.toContain(unmeasured);
      const all = await asRw((db) => listFeed(db, { types: [], lengths: ["short", "medium", "long"] }, 50));
      expect(all.cards.map((c) => c.id)).not.toContain(unmeasured);
    } finally {
      await pg.query("DELETE FROM essay_categories WHERE essay_id = $1", [unmeasured]);
      await pg.query("DELETE FROM essays WHERE id = $1", [unmeasured]);
    }
  });

  it("lets link-only essays through the length filter but not the type filter", async () => {
    const critical = await asRw((db) => listFeed(db, { types: ["critical"], lengths: ["medium"] }, 20));
    expect(critical.cards.map((c) => c.title)).toEqual(["Paywalled"]);
    expect(critical.cards[0]!.kind).toBe("link");
    expect(critical.cards[0]!.wordCount).toBeNull();
    const political = await asRw((db) => listFeed(db, { types: ["political"], lengths: ["short"] }, 20));
    expect(political.cards).toEqual([]);
  });

  it("validates a rating: stars 1 to 5, known tags and length choices, canonical order", () => {
    expect(parseRating({ stars: "3", worked: ["surprise", "ideas", "ideas"], lengthFelt: "too_long" })).toEqual({
      stars: 3,
      worked: ["ideas", "surprise"],
      lengthFelt: "too_long",
    });
    expect(parseRating({ stars: 5, worked: [], lengthFelt: "" })).toEqual({ stars: 5, worked: [], lengthFelt: null });
    for (const stars of [0, 6, "x", "2.5", null, undefined]) {
      expect(() => parseRating({ stars, worked: [], lengthFelt: null })).toThrow(InputError);
    }
    expect(() => parseRating({ stars: 4, worked: ["vibes"], lengthFelt: null })).toThrow(InputError);
    expect(() => parseRating({ stars: 4, worked: [], lengthFelt: "forever" })).toThrow(InputError);
  });

  it("saves the owner's rating as an upsert (one row per essay)", async () => {
    await asRw((db) => saveRating(db, hurston, { stars: 2, worked: ["prose"], lengthFelt: "right" }));
    await asRw((db) => saveRating(db, hurston, { stars: 5, worked: ["emotion"], lengthFelt: "too_short" }));
    const { rows } = await pg.query<{ n: number; stars: number; worked: string[]; length_felt: string }>(
      "SELECT count(*) OVER () AS n, stars, worked, length_felt FROM ratings WHERE essay_id = $1",
      [hurston],
    );
    expect(rows).toEqual([{ n: 1, stars: 5, worked: ["emotion"], length_felt: "too_short" }]);
  });

  it("refuses to rate an unknown, quarantined or malformed essay", async () => {
    await expect(asRw((db) => saveRating(db, randomUUID(), { stars: 4, worked: [], lengthFelt: null }))).rejects.toBeInstanceOf(EssayNotFoundError);
    await expect(asRw((db) => saveRating(db, quarantined, { stars: 4, worked: [], lengthFelt: null }))).rejects.toBeInstanceOf(EssayNotFoundError);
    // Link-only essays have no text to read or rate: refused, and no rating row is written.
    await expect(asRw((db) => saveRating(db, eliot, { stars: 4, worked: [], lengthFelt: null }))).rejects.toBeInstanceOf(EssayNotFoundError);
    const { rows } = await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM ratings WHERE essay_id = $1", [eliot]);
    expect(rows[0]!.n).toBe(0);
    await expect(asRw((db) => saveRating(db, "not-a-uuid", { stars: 4, worked: [], lengthFelt: null }))).rejects.toBeInstanceOf(InputError);
  });

  it("ranks recommendations by similarity to the 5-star essay and drops rated essays", async () => {
    // Hurston's 5-star memoir (1937) beats the unrelated cultural pieces: author and era match Mules and Men.
    const prefs = { types: [], lengths: [] };
    const rec = await asRw((db) => listRecommendations(db, prefs, 10));
    expect(rec.likedCount).toBe(1);
    // Link-only essays are never recommended (there is no reader to open them in).
    expect(rec.cards.map((c) => c.title)).toEqual(["Mules and Men", "Sitting in Darkness", "Roast Pig"]);
    expect(rec.cards[0]!.score).toBe(4 * 2);
    expect(rec.cards.map((c) => c.id)).not.toContain(hurston);
    expect(rec.cards.map((c) => c.id)).not.toContain(eliot);
  });

  it("applies prefs to recommendations too", async () => {
    const rec = await asRw((db) => listRecommendations(db, { types: ["political"], lengths: [] }, 10));
    expect(rec.cards.map((c) => c.title)).toEqual(["Sitting in Darkness"]);
  });

  it("orders recommendations newest first when nothing is rated 4 stars or more", async () => {
    await asRw((db) => saveRating(db, hurston, { stars: 3, worked: [], lengthFelt: null }));
    const rec = await asRw((db) => listRecommendations(db, { types: [], lengths: [] }, 10));
    expect(rec.likedCount).toBe(0);
    expect(rec.cards.map((c) => c.title)).toEqual(["Mules and Men", "Sitting in Darkness", "Roast Pig"]);
    expect(rec.cards.every((c) => c.score === 0)).toBe(true);
  });

  it("ignores ratings of non-active essays in ranking and in likedCount", async () => {
    // A 5-star rating left on the quarantined essay (author Nobody, cultural) must not count as a liked essay.
    await pg.query("INSERT INTO ratings (essay_id, stars, worked) VALUES ($1, 5, '{}')", [quarantined]);
    const rec = await asRw((db) => listRecommendations(db, { types: [], lengths: [] }, 10));
    expect(rec.likedCount).toBe(0);
    expect(rec.cards.map((c) => c.title)).toEqual(["Mules and Men", "Sitting in Darkness", "Roast Pig"]);
    expect(rec.cards.every((c) => c.score === 0)).toBe(true);
    await pg.query("DELETE FROM ratings WHERE essay_id = $1", [quarantined]);
  });

  it("reads the reader essay with its rating for active essays only", async () => {
    const e = await asRw((db) => getReaderEssay(db, hurston));
    expect(e).toMatchObject({ title: "How It Feels", hook: "A hook.", rating: { stars: 3, worked: [], lengthFelt: null } });
    const link = await asRw((db) => getReaderEssay(db, eliot));
    expect(link).toMatchObject({ kind: "link", sourceUrl: "https://example.com/essay", rating: null });
    await expect(asRw((db) => getReaderEssay(db, quarantined))).resolves.toBeUndefined();
    await expect(asRw((db) => getReaderEssay(db, "nope"))).resolves.toBeUndefined();
  });
});

describe("library order, search, kind and count as web_rw", () => {
  let pg: PGlite;
  const asRw = <T>(fn: (db: Queryable) => Promise<T>) => runAs(pglitePool(pg), "web_rw", fn);
  const NO_PREFS: Prefs = { types: [], lengths: [] };

  async function add(title: string, author: string, createdAt: string, kind: "full" | "link", types: string[]): Promise<void> {
    const link = kind === "link";
    const { rows } = await pg.query<{ id: string }>(
      `INSERT INTO essays (kind, title, author, word_count, source_url, text_hash, text_s3_key, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8) RETURNING id`,
      [
        kind,
        title,
        author,
        link ? null : 2000,
        link ? "https://example.com/essay" : null,
        link ? null : randomUUID(),
        link ? null : `essays/text/${randomUUID()}.txt`,
        createdAt,
      ],
    );
    for (const [i, type] of types.entries()) {
      await pg.query("INSERT INTO essay_categories (essay_id, type, confidence, model) VALUES ($1, $2, $3, 'test')", [rows[0]!.id, type, 0.9 - i * 0.1]);
    }
  }

  // Full essays newest first, then link essays by surname (Lamb, Mann, Rich, Smith, Xun), then title.
  const ALL_TITLES = [
    "Mules and Men",
    "Rates: 100%",
    "file_name notes",
    "Roast Pig",
    "Lamb Letters",
    "Mann on Cities",
    "Rich Lines",
    "Alpha Essay",
    "Zebra Essay",
    "Lu Notes",
  ];

  beforeAll(async () => {
    pg = await freshDb();
    await add("Roast Pig", "Charles Lamb", "2026-01-01T00:00:00Z", "full", ["cultural"]);
    await add("file_name notes", "Under Score", "2026-02-01T00:00:00Z", "full", ["cultural"]);
    await add("Rates: 100%", "Percy Pct", "2026-03-01T00:00:00Z", "full", ["political"]);
    await add("Mules and Men", "Zora Neale Hurston", "2026-07-01T00:00:00Z", "full", ["travel"]);
    await add("Lamb Letters", "Charles Lamb", "2026-05-01T00:00:00Z", "link", ["critical"]);
    await add("Mann on Cities", "Charles C. Mann", "2026-05-01T00:00:00Z", "link", ["travel"]);
    await add("Rich Lines", "Adrienne Rich", "2026-05-01T00:00:00Z", "link", ["critical"]);
    // Same surname and same created_at: the title breaks the tie.
    await add("Zebra Essay", "Pat Smith", "2026-05-01T00:00:00Z", "link", []);
    await add("Alpha Essay", "Pat Smith", "2026-05-01T00:00:00Z", "link", ["political"]);
    // Padded author: the surname is still Xun.
    await add("Lu Notes", "  Lu Xun ", "2026-05-01T00:00:00Z", "link", ["cultural"]);
  });
  afterAll(async () => {
    await pg.close();
  });

  it("lists full essays newest first, then links by surname, title and id", async () => {
    const { cards, hasMore } = await asRw((db) => listFeed(db, NO_PREFS, 50));
    expect(cards.map((c) => c.title)).toEqual(ALL_TITLES);
    expect(hasMore).toBe(false);
    const surnames = cards.filter((c) => c.kind === "link").map((c) => authorSurname(c.author));
    expect(surnames).toEqual(["lamb", "mann", "rich", "smith", "smith", "xun"]);
  });

  it("filters by kind; all and unknown kinds show everything", async () => {
    const full = await asRw((db) => listFeed(db, NO_PREFS, 50, { q: "", kind: "full" }));
    expect(full.cards.map((c) => c.title)).toEqual(["Mules and Men", "Rates: 100%", "file_name notes", "Roast Pig"]);
    const links = await asRw((db) => listFeed(db, NO_PREFS, 50, { q: "", kind: "link" }));
    expect(links.cards.map((c) => c.title)).toEqual(ALL_TITLES.slice(4));
    expect(links.cards.every((c) => c.kind === "link")).toBe(true);
    const all = await asRw((db) => listFeed(db, NO_PREFS, 50, { q: "", kind: "all" }));
    expect(all.cards.map((c) => c.title)).toEqual(ALL_TITLES);
    expect(parseKind("bogus")).toBe("all");
  });

  it("searches title or author, case-insensitively, as a substring", async () => {
    const search = (q: string) => asRw((db) => listFeed(db, NO_PREFS, 50, { q, kind: "all" })).then((r) => r.cards.map((c) => c.title));
    expect(await search("HURSTON")).toEqual(["Mules and Men"]);
    expect(await search("roast")).toEqual(["Roast Pig"]);
    // Author matches on both kinds; full essays still come first.
    expect(await search("lamb")).toEqual(["Roast Pig", "Lamb Letters"]);
    expect(await search(parseSearch("  pat  "))).toEqual(["Alpha Essay", "Zebra Essay"]);
    expect(await search("nothing here")).toEqual([]);
  });

  it("treats % and _ in the search as literal characters", async () => {
    const search = (q: string) => asRw((db) => listFeed(db, NO_PREFS, 50, { q, kind: "all" })).then((r) => r.cards.map((c) => c.title));
    // A bare % must not match every essay: only the title that really contains a percent sign.
    expect(await search("%")).toEqual(["Rates: 100%"]);
    expect(await search("100%")).toEqual(["Rates: 100%"]);
    expect(await search("_")).toEqual(["file_name notes"]);
    expect(await search("\\")).toEqual([]);
  });

  it("combines the search, the kind and the setup prefs", async () => {
    const titles = (f: { types: Prefs["types"]; lengths: Prefs["lengths"] }, q: string, kind: "all" | "full" | "link") =>
      asRw((db) => listFeed(db, f, 50, { q, kind })).then((r) => r.cards.map((c) => c.title));
    expect(await titles(NO_PREFS, "mann", "link")).toEqual(["Mann on Cities"]);
    expect(await titles(NO_PREFS, "lamb", "full")).toEqual(["Roast Pig"]);
    expect(await titles({ types: ["critical"], lengths: [] }, "lamb", "all")).toEqual(["Lamb Letters"]);
    expect(await titles(NO_PREFS, "rich", "full")).toEqual([]);
    expect(await titles({ types: ["travel"], lengths: [] }, "pat", "all")).toEqual([]);
  });

  it("counts the same matches the feed lists, and hasMore follows the page size", async () => {
    const count = (types: Prefs["types"], q: string, kind: "all" | "full" | "link") => asRw((db) => countFeed(db, { types, lengths: [] }, { q, kind }));
    expect(await count([], "", "all")).toBe(10);
    expect(await count([], "", "link")).toBe(6);
    expect(await count([], "lamb", "all")).toBe(2);
    expect(await count([], "nothing here", "all")).toBe(0);
    expect(await count(["critical"], "", "all")).toBe(2);
    const everything = await asRw((db) => listFeed(db, NO_PREFS, 500));
    expect(await count([], "", "all")).toBe(everything.cards.length);

    const page = await asRw((db) => listFeed(db, NO_PREFS, 4));
    expect(page.cards).toHaveLength(4);
    expect(page.hasMore).toBe(true);
    const exact = await asRw((db) => listFeed(db, NO_PREFS, 10));
    expect(exact.cards).toHaveLength(10);
    expect(exact.hasMore).toBe(false);
  });

  it("keeps the search and kind in the links", () => {
    expect(feedHref({})).toBe("/essays");
    expect(feedHref({ kind: "all", q: "" })).toBe("/essays");
    expect(feedHref({ q: "a b&c", kind: "link", show: 100 })).toBe("/essays?q=a+b%26c&kind=link&show=100");
    expect(feedHref({ kind: "full" })).toBe("/essays?kind=full");
  });
});

describe("pure helpers", () => {
  it("parses the feed size with one page as the default and a cap", () => {
    expect(parseShow(undefined)).toBe(50);
    expect(parseShow("50")).toBe(50);
    expect(parseShow("20")).toBe(50);
    expect(parseShow("100")).toBe(100);
    expect(parseShow("300")).toBe(300);
    expect(parseShow("500")).toBe(500);
    expect(parseShow("501")).toBe(500);
    expect(parseShow("9999")).toBe(500);
    expect(parseShow("x")).toBe(50);
    expect(parseShow(["100"])).toBe(50);
  });

  it("parses the kind: full or link, anything else is all", () => {
    expect(parseKind("full")).toBe("full");
    expect(parseKind("link")).toBe("link");
    expect(parseKind("all")).toBe("all");
    expect(parseKind("Links")).toBe("all");
    expect(parseKind(undefined)).toBe("all");
    expect(parseKind(["link"])).toBe("all");
  });

  it("parses the search: trimmed, at most 100 characters, anything but a string is empty", () => {
    expect(parseSearch("  Lamb  ")).toBe("Lamb");
    expect(parseSearch("a".repeat(150))).toBe("a".repeat(100));
    expect(parseSearch("   ")).toBe("");
    expect(parseSearch(["a"])).toBe("");
    expect(parseSearch(undefined)).toBe("");
  });

  it("escapes LIKE wildcards and the escape character", () => {
    expect(likePattern("a%_\\b")).toBe("%a\\%\\_\\\\b%");
    expect(likePattern("plain")).toBe("%plain%");
  });

  it("takes the surname as the last word, lower-cased", () => {
    expect(authorSurname("Charles C. Mann")).toBe("mann");
    expect(authorSurname("  Lu Xun ")).toBe("xun");
    expect(authorSurname("Plato")).toBe("plato");
    expect(surnameInitial("Adrienne Rich")).toBe("R");
    expect(surnameInitial("Lu Xun")).toBe("X");
    expect(surnameInitial("Zoë Ébert")).toBe("#");
  });

  it("builds a https search link from the title and author, encoded, that externalHref accepts", () => {
    const href = linkSearchHref("How It Feels & More", "Zora Neale Hurston");
    expect(href).toBe("https://duckduckgo.com/?q=How%20It%20Feels%20%26%20More%20Zora%20Neale%20Hurston%20essay");
    expect(externalHref(href)).toBe(href);
    expect(linkSearchHref('A "Quoted" #1', "O'Neil")).toBe("https://duckduckgo.com/?q=A%20%22Quoted%22%20%231%20O'Neil%20essay");
  });

  it("only links http(s) sources", () => {
    expect(externalHref("https://example.com/a")).toBe("https://example.com/a");
    expect(externalHref("http://example.com/a")).toBe("http://example.com/a");
    expect(externalHref("javascript:alert(1)")).toBeNull();
    expect(externalHref("data:text/html,hi")).toBeNull();
    expect(externalHref("not a url")).toBeNull();
    expect(externalHref(null)).toBeNull();
  });

  it("uses the stored reading time, else words / 230 (at least 1), else nothing", () => {
    expect(readingMinutesOf({ readingMinutes: 7, wordCount: 2300 })).toBe(7);
    expect(readingMinutesOf({ readingMinutes: null, wordCount: 2300 })).toBe(10);
    expect(readingMinutesOf({ readingMinutes: null, wordCount: 100 })).toBe(1);
    expect(readingMinutesOf({ readingMinutes: null, wordCount: null })).toBeNull();
  });
});
