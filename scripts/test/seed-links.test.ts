import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSeedList, seedListKey, type SeedListEntry } from "@kcw/db/seed-list";
import { freshDb } from "../../packages/db/test/helpers";
import { runSeedImport } from "../lib/seed-import";
import {
  countLinkState, findUnlinkedSeeds, formatSeedLinks, insertSeedLinks, planSeedLinks, runSeedLinks, SEED_TYPE_SLUGS,
} from "../lib/seed-links";

describe("seed type slugs", () => {
  it("maps every seed-list type to a migration 0001 slug, and nothing else", () => {
    expect(SEED_TYPE_SLUGS["personal/memoir"]).toBe("personal_memoir");
    expect(SEED_TYPE_SLUGS["science/nature"]).toBe("science_nature");
    expect(SEED_TYPE_SLUGS["creative/lyric"]).toBe("creative_lyric");
    expect(Object.values(SEED_TYPE_SLUGS).sort()).toEqual([
      "argumentative", "comedic", "creative_lyric", "critical", "cultural", "personal_memoir",
      "philosophical", "political", "science_nature", "travel",
    ]);
  });

  it("covers every type in the real seed list", async () => {
    const types = new Set((await loadSeedList()).map((e) => e.type));
    for (const t of types) expect(SEED_TYPE_SLUGS, t).toHaveProperty([t]);
  });
});

describe("seed link planning (pure)", () => {
  const entry = (title: string, type: string, year = "1900"): SeedListEntry => ({
    title, author: `${title} author`, year, type, evidence: "direct", public_domain_likely: null, batch: "b", access: "unchecked", length: "unchecked",
  });
  const seed = (e: SeedListEntry, id = randomUUID()) => ({
    id, title: e.title, author: e.author, year: /^\d{4}$/.test(e.year) ? Number(e.year) : null, seed_list_key: seedListKey(e),
  });

  it("skips unknown types and seeds without a list entry, and counts both", () => {
    const known = entry("Known", "personal/memoir", "1841");
    const unknown = entry("Unknown", "poetry");
    const unlisted = { id: randomUUID(), title: "Not listed", author: "Nobody", year: null, seed_list_key: null };
    const plan = planSeedLinks([seed(known), seed(unknown), unlisted], [known, unknown]);
    expect(plan.plans).toEqual([expect.objectContaining({ title: "Known", type: "personal_memoir", year: 1841 })]);
    expect(plan.unknownType).toBe(1);
    expect(plan.unknownTypes).toEqual(["poetry"]);
    expect(plan.unmatched).toBe(1);
  });

  it("skips a seed whose key matches no list entry, even with a type-bearing entry present", () => {
    const e = entry("Other", "travel");
    const stray = { id: randomUUID(), title: "Stray", author: "Nobody", year: null, seed_list_key: seedListKey(entry("Gone", "travel")) };
    expect(planSeedLinks([stray], [e])).toMatchObject({ plans: [], unmatched: 1, unknownType: 0 });
  });
});

describe("link-seed-essays against PGlite", () => {
  let fresh: Awaited<ReturnType<typeof freshDb>>;
  let entries: SeedListEntry[];
  let mutatedTitle: string;
  let storedTitles: string[];
  let ingestTitles: string[];
  let proposedTitle: string;
  let storedSeedId: string;
  const UNKNOWN_INDEX = 5;

  beforeAll(async () => {
    fresh = await freshDb();
    const listed = await loadSeedList();
    // One listed entry gets a type outside the mapping, to exercise the unknown-type skip.
    entries = listed.map((e, i) => (i === UNKNOWN_INDEX ? { ...e, type: "poetry" } : e));
    mutatedTitle = listed[UNKNOWN_INDEX]!.title;
    await runSeedImport(fresh.db, entries);
    const idOf = async (title: string) =>
      (await fresh.db.query<{ id: string }>("SELECT id FROM seed_items WHERE title = $1", [title])).rows[0]!.id;
    const [s0, s1, s2, s3, s4] = [0, 1, 2, 3, 4].map((i) => listed[i]!.title);
    storedTitles = [s0!, s1!];
    ingestTitles = [s2!, s3!];
    proposedTitle = s4!;
    storedSeedId = await idOf(s0!);
    // Seed 0 already has a full essay (essays.seed_item_id set); seed 1 has one through seed_items.essay_id.
    await fresh.db.query(
      `INSERT INTO essays (kind, title, author, text_hash, text_s3_key, status, seed_item_id)
       VALUES ('full', 'Stored', 'Stored author', $1, 'essays/text/a.txt', 'active', $2)`,
      [randomUUID(), storedSeedId],
    );
    const { rows } = await fresh.db.query<{ id: string }>(
      `INSERT INTO essays (kind, title, author, text_hash, text_s3_key, status, seed_item_id)
       VALUES ('full', 'Also stored', 'Also author', $1, 'essays/text/b.txt', 'active', $2) RETURNING id`,
      [randomUUID(), await idOf(s1!)],
    );
    await fresh.db.query("UPDATE seed_items SET essay_id = $1 WHERE title = $2", [rows[0]!.id, s1]);

    // Ingest will store these as full text: an essay_urls row (seed 2) and an approved link (seed 3).
    const { rows: src } = await fresh.db.query<{ id: string }>(
      "INSERT INTO sources (name, base_url) VALUES ('Test source', 'https://source.example.invalid') RETURNING id",
    );
    const sourceId = src[0]!.id;
    await fresh.db.query(
      "INSERT INTO essay_urls (url, source_id, seed_item_id) VALUES ('https://source.example.invalid/2', $1, $2)",
      [sourceId, await idOf(ingestTitles[0]!)],
    );
    await fresh.db.query(
      `INSERT INTO seed_source_links (seed_item_id, source_id, candidate_url, candidate_title, candidate_author, tier, score, status)
       VALUES ($1, $2, 'https://source.example.invalid/3', 'T', 'A', 'A', 0.9, 'approved')`,
      [await idOf(ingestTitles[1]!), sourceId],
    );
    // Seed 4 has only a proposed (not approved) link, so it is not reserved for ingest and gets a link essay.
    await fresh.db.query(
      `INSERT INTO seed_source_links (seed_item_id, source_id, candidate_url, candidate_title, candidate_author, tier, score, status)
       VALUES ($1, $2, 'https://source.example.invalid/4', 'T', 'A', 'A', 0.5, 'proposed')`,
      [await idOf(proposedTitle), sourceId],
    );
    // An approved seed that is not from the list: it has no type to take.
    await fresh.db.query("INSERT INTO seed_items (title, author, status) VALUES ('Unlisted', 'Nobody', 'approved')");
  });
  afterAll(async () => {
    await fresh.pg.close();
  });

  it("excludes seeds with a stored essay, an essay_urls row or an approved link from the unlinked set", async () => {
    const unlinked = (await findUnlinkedSeeds(fresh.db)).map((s) => s.title);
    for (const t of [...storedTitles, ...ingestTitles]) expect(unlinked).not.toContain(t);
    expect(unlinked).toContain(proposedTitle);
    expect(unlinked).toContain("Unlisted");
    expect(unlinked).toContain(mutatedTitle);
  });

  it("a dry run prints the plan and writes nothing", async () => {
    const before = await countLinkState(fresh.db);
    expect(before).toEqual({ unlinkedSeeds: 297, essaysFull: 2, essaysLink: 0, categories: 0 });
    const dry = await runSeedLinks(fresh.db, entries, { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, inserted: 0, plan: { unknownType: 1, unmatched: 1 } });
    expect(dry.plan.plans).toHaveLength(295);
    expect(await countLinkState(fresh.db)).toEqual(before);
    expect(formatSeedLinks("PGlite (x)", dry).join("\n")).toContain("dry run, nothing written: 295 link essays would be inserted");
  });

  it("creates one link essay per listed seed without an essay and reports the skips", async () => {
    const report = await runSeedLinks(fresh.db, entries);
    expect(report.dryRun).toBe(false);
    expect(report.plan.unknownType).toBe(1);
    expect(report.plan.unknownTypes).toEqual(["poetry"]);
    expect(report.plan.unmatched).toBe(1);
    expect(report.inserted).toBe(295);
    expect(report.after).toEqual({ unlinkedSeeds: 2, essaysFull: 2, essaysLink: 295, categories: 295 });

    const out = formatSeedLinks("PGlite (x)", report).join("\n");
    expect(out).toContain("PGlite (x): 295 link essays inserted");
    expect(out).toContain("skipped 1 seeds with unknown type (poetry)");
    expect(out).toContain("skipped 1 approved seeds with no SEED-LIST entry");
    expect(out).toContain("unlinked_seeds=2 essays_full=2 essays_link=295 categories=295");
    expect(out).not.toContain(mutatedTitle);
    expect(out).not.toMatch(/postgres(ql)?:\/\//);
  });

  it("is idempotent: a rerun inserts nothing and changes no counts", async () => {
    const first = await countLinkState(fresh.db);
    const again = await runSeedLinks(fresh.db, entries);
    expect(again.inserted).toBe(0);
    expect(again.before).toEqual(first);
    expect(again.after).toEqual(first);
    expect(again.plan.unknownType).toBe(1);
  });

  it("a stale plan cannot double-insert: an already linked seed is skipped in the transaction", async () => {
    const before = await countLinkState(fresh.db);
    const [linked] = (await fresh.db.query<{ id: string; title: string; author: string; year: number | null }>(
      "SELECT id, title, author, year FROM seed_items WHERE title = $1", [proposedTitle])).rows;
    const stale = { seedId: linked!.id, title: linked!.title, author: linked!.author, year: linked!.year, type: "comedic" };
    expect(await insertSeedLinks(fresh.db, [stale])).toBe(0);
    expect(await countLinkState(fresh.db)).toEqual(before);
    // The stored full essay of a stored seed is never shadowed by a link essay either.
    expect(await insertSeedLinks(fresh.db, [{ ...stale, seedId: storedSeedId }])).toBe(0);
    const { rows } = await fresh.db.query<{ n: string }>("SELECT count(*) AS n FROM essays WHERE seed_item_id = $1", [storedSeedId]);
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it("writes link essays with no URL or text, the mapped category and the seed link", async () => {
    const memoir = entries.find((e, i) => i >= 6 && e.type === "personal/memoir")!;
    const { rows } = await fresh.db.query<{
      kind: string; source_url: string | null; word_count: number | null; text_hash: string | null; status: string;
      type: string; confidence: number; model: string; seed_essay_id: string | null;
    }>(
      `SELECT e.kind, e.source_url, e.word_count, e.text_hash, e.status, c.type, c.confidence, c.model,
              s.essay_id AS seed_essay_id
         FROM essays e JOIN essay_categories c ON c.essay_id = e.id JOIN seed_items s ON s.id = e.seed_item_id
        WHERE e.kind = 'link' AND s.seed_list_key = $1`,
      [seedListKey(memoir)],
    );
    expect(rows[0]).toMatchObject({
      kind: "link", source_url: null, word_count: null, text_hash: null, status: "active",
      type: "personal_memoir", confidence: 1, model: "seed-list",
    });
    expect(rows[0]!.seed_essay_id).not.toBeNull();
  });

  it("copies the year as an integer when the list has one, and leaves it null otherwise", async () => {
    const dated = entries.find((e, i) => i >= 6 && /^\d{4}$/.test(e.year) && e.type !== "poetry")!;
    const withYear = await fresh.db.query<{ year: number | null; seed_year: number | null }>(
      `SELECT e.year, s.year AS seed_year FROM essays e JOIN seed_items s ON s.id = e.seed_item_id
        WHERE e.kind = 'link' AND s.seed_list_key = $1`,
      [seedListKey(dated)],
    );
    expect(withYear.rows).toHaveLength(1);
    expect(withYear.rows[0]!.year).toBe(Number(dated.year));
    const undated = entries.find((e, i) => i >= 6 && !/^\d{4}$/.test(e.year) && e.type !== "poetry")!;
    const noYear = await fresh.db.query<{ year: number | null }>(
      `SELECT e.year FROM essays e JOIN seed_items s ON s.id = e.seed_item_id
        WHERE e.kind = 'link' AND s.seed_list_key = $1`,
      [seedListKey(undated)],
    );
    expect(noYear.rows[0]!.year).toBeNull();
  });

  it("leaves the unknown-type and unlisted seeds unlinked, and the ingest-reserved seeds untouched", async () => {
    const still = (await findUnlinkedSeeds(fresh.db)).map((s) => s.title).sort();
    expect(still).toEqual(["Unlisted", mutatedTitle].sort());
    const stored = await fresh.db.query<{ n: string }>(
      "SELECT count(*) AS n FROM essays WHERE kind = 'full' AND seed_item_id IS NOT NULL",
    );
    expect(Number(stored.rows[0]!.n)).toBe(2);
  });

  it("stays one transaction: a failing plan leaves no partial link", async () => {
    const [target] = await findUnlinkedSeeds(fresh.db);
    const before = await countLinkState(fresh.db);
    const good = { seedId: target!.id, title: target!.title, author: target!.author, year: null, type: "comedic" };
    const bad = { ...good, seedId: "not-a-uuid" };
    await expect(insertSeedLinks(fresh.db, [good, bad])).rejects.toThrow();
    expect(await countLinkState(fresh.db)).toEqual(before);
    expect((await findUnlinkedSeeds(fresh.db)).map((s) => s.id)).toContain(target!.id);
  });
});

describe("link-seed-essays write guard", () => {
  const scriptsDir = fileURLToPath(new URL("..", import.meta.url));

  it("refuses a non-PGlite real run without --confirm before connecting", () => {
    const run = spawnSync(process.execPath, ["--import", "tsx", "link-seed-essays.ts"], {
      cwd: scriptsDir, encoding: "utf8", timeout: 40_000,
      env: { ...process.env, DATABASE_URL: "postgres://u:p@10.255.255.1:5432/x" },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("--confirm");
    expect(run.stderr).not.toContain("10.255.255.1");
  }, 60_000);
});
