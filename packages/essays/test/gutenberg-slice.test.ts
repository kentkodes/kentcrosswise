import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db";
import { parseGutenbergCatalog } from "../src/discovery/gutenberg";
import { ApplyError, applyReviewedLinks, loadApprovedSeeds } from "../src/match/links";
import { catalogAuthors, gutenbergRecords, isCollectionTitle } from "../src/match/gutenberg-records";
import { matchAll, type SeedInput } from "../src/match/match";
import { REVIEW_COLUMNS, parseReviewTable, renderReviewTable, reviewCells, type ReviewRow } from "../src/match/review";
import { EXTRACTOR_VERSION } from "../src/extract/gutenberg-text";
import { GUTENBERG_SLUG, registerGutenbergSource } from "../src/registry/bootstrap";
import { loadSource, parseCrawlRules, sourceAllows } from "../src/registry/source";
import { essaysDb, type TestPg } from "./db-helpers";

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
const catalogFile = fixture<{ provenance: string; rows: Array<{ id: number; type: string; title: string; language: string; authors: string }> }>("gutenberg-catalog-sample.json");
const seedFile = fixture<{ provenance: string; seeds: SeedInput[] }>("seeds-sample.json");

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
const csv = (rows = catalogFile.rows) =>
  ["Text#,Type,Issued,Title,Language,Authors,Subjects,LoCC,Bookshelves"]
    .concat(rows.map((r) => `${r.id},${r.type},2000-01-01,${q(r.title)},${r.language},${q(r.authors)},,,`))
    .join("\n");
const keyOf = (id: string) => createHash("sha256").update(id).digest("hex");
const keyedSeeds = (): SeedInput[] => seedFile.seeds.map((s) => ({ ...s, seedKey: keyOf(s.id) }));
const entries = () => parseGutenbergCatalog(csv());
const candidates = (seeds = keyedSeeds()) => matchAll(seeds, gutenbergRecords(entries()));
const ID = { emerson: 1001, civil: 1003, studies: 1004, lamb: 1006 };

describe("fixture", () => {
  it("records public-domain provenance and short metadata strings only", () => {
    expect(catalogFile.provenance).toMatch(/public-domain/);
    expect(catalogFile.provenance).toContain("No essay text");
    for (const r of catalogFile.rows) for (const v of [r.title, r.authors]) expect(v.length).toBeLessThan(120);
  });
});

describe("gutenberg source registration", () => {
  let pg: TestPg;
  let db: Db;
  beforeAll(async () => {
    ({ pg, db } = await essaysDb());
  });
  afterAll(async () => {
    await pg.close();
  });

  it("inserts one row, reruns insert nothing, and never overwrites an owner edit", async () => {
    expect(await registerGutenbergSource(db)).toMatchObject({ inserted: true });
    expect(await registerGutenbergSource(db)).toMatchObject({ inserted: false });
    await db.query("UPDATE sources SET crawl_rules = jsonb_set(crawl_rules, '{min_delay_ms}', '9000') WHERE slug = $1", [GUTENBERG_SLUG]);
    await registerGutenbergSource(db);
    const { rows } = await db.query<{ n: string }>("SELECT count(*) AS n FROM sources");
    expect(Number(rows[0]?.n)).toBe(1);
    const source = await loadSource(db, GUTENBERG_SLUG);
    expect(source?.crawlRules.minDelayMs).toBe(9000);
  });

  it("stores rules the registry parses, limited to discovery and matching paths", async () => {
    const source = (await loadSource(db, GUTENBERG_SLUG))!;
    expect(source).toMatchObject({
      name: "Project Gutenberg", baseUrl: "https://www.gutenberg.org", discoveryMode: "seed_targeted",
      extractorId: "gutenberg-txt", extractorVersion: EXTRACTOR_VERSION, licensePolicy: "pd_only", paused: false,
      discovery: { kind: "catalog_csv", url: "https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv" },
    });
    expect(() => parseCrawlRules({ allow_paths: source.crawlRules.allowPaths }, source.baseUrl)).not.toThrow();
    expect(source.crawlRules.allowPaths).toEqual(["/ebooks/", "/cache/epub/feeds/"]);
    expect(source.crawlRules.userAgent).toContain("KentcrosswiseBot");
    expect(sourceAllows(source, "https://www.gutenberg.org/ebooks/1001")).toEqual({ allowed: true });
    expect(sourceAllows(source, "https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv")).toEqual({ allowed: true });
    expect(sourceAllows(source, "https://example.com/ebooks/1001")).toMatchObject({ allowed: false, reason: "host_not_allowed" });
    // No book body path is allowed: bodies do not come from the website.
    expect(sourceAllows(source, "https://www.gutenberg.org/cache/epub/1001/pg1001.txt")).toMatchObject({ allowed: false, reason: "path_not_allowed" });
    expect(sourceAllows(source, "https://www.gutenberg.org/files/1001/1001-0.txt")).toMatchObject({ allowed: false, reason: "path_not_allowed" });
  });
});

describe("catalog adapter", () => {
  it("flags collection titles and keeps whole standalone titles", () => {
    for (const t of ["Essays: First Series", "The Works of Francis Bacon, Vol. 1", "Complete Poems", "Collected Prose", "Selected Essays", "Letters, Volume 2", "Civil Disobedience and Other Essays"]) {
      expect(isCollectionTitle(t), t).toBe(true);
    }
    for (const t of ["Self-Reliance", "A Dissertation upon Roast Pig", "On Civil Disobedience", "Of Studies"]) expect(isCollectionTitle(t), t).toBe(false);
  });

  it("splits authors, keeps life dates, drops other roles and reports a translator", () => {
    expect(catalogAuthors("Emerson, Ralph Waldo, 1803-1882")).toEqual({ authors: ["Emerson, Ralph Waldo, 1803-1882"], translator: null });
    expect(catalogAuthors("Montaigne, Michel de, 1533-1592; Cotton, Charles, 1630-1687 [Translator]")).toEqual({
      authors: ["Montaigne, Michel de, 1533-1592"], translator: "Cotton, Charles, 1630-1687",
    });
    expect(catalogAuthors("A, B, 1800-1850; C, D [Editor]; E, F [Author]").authors).toEqual(["A, B, 1800-1850", "E, F"]);
    expect(catalogAuthors("")).toEqual({ authors: [], translator: null });
  });

  it("maps entries to records with the ebook URL, one per author", () => {
    const records = gutenbergRecords(entries());
    expect(records.filter((r) => r.url.endsWith("/1008")).map((r) => r.author)).toEqual(["Bacon, Francis, 1561-1626", "Montaigne, Michel de, 1533-1592"]);
    expect(records.find((r) => r.url.endsWith("/1002"))).toMatchObject({ standalone: false });
    expect(records.find((r) => r.url.endsWith("/1001"))).toMatchObject({ url: "https://www.gutenberg.org/ebooks/1001", standalone: true });
    expect(records.find((r) => r.url.endsWith("/1007"))).toMatchObject({ translator: "Cotton, Charles, 1630-1687" });
    expect(records.some((r) => r.url.endsWith("/1009") || r.url.endsWith("/1010"))).toBe(false); // not Text, not English
  });

  it("matches seeds: tier A, tier B, collections and translations dropped", () => {
    const found = candidates().map((c) => [Number(c.url.split("/").pop()), c.tier, c.autoApprove]);
    expect(found.sort()).toEqual([
      [ID.emerson, "A", true], [ID.civil, "B", false], [ID.studies, "A", true], [ID.lamb, "A", true],
    ].sort());
  });
});

describe("review table", () => {
  const seeds = keyedSeeds();
  const render = (cs = candidates(seeds), s = seeds, previous?: ReturnType<typeof reviewCells>) =>
    renderReviewTable(s, cs, "Project Gutenberg", { catalogDate: "2026-11-10", ...(previous && { previous }) });
  const table = render();

  it("has a provenance header and the stable columns", () => {
    expect(table).toContain("Catalog fetched: 2026-11-10");
    expect(table).toContain("Matcher version: 1");
    const rows = parseReviewTable(table);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.seedKey) && r.gutenbergId === r.url.split("/").pop())).toBe(true);
    expect(rows.every((r) => r.qa === "" && r.owner === "")).toBe(true);
    expect(rows.map((r) => r.tier).sort()).toEqual(["A", "A", "A", "B"]);
  });

  it("is byte-stable on reordered input", () => {
    const reversedSeeds = [...seeds].reverse();
    expect(render([...candidates(seeds)].reverse(), reversedSeeds)).toBe(table);
    const records = gutenbergRecords(entries());
    expect(render(matchAll(reversedSeeds, [...records].reverse()), reversedSeeds)).toBe(table);
  });

  it("orders rows by code point with the seed key as last tiebreaker, whatever the input order", () => {
    const twin = (id: string, key: string): SeedInput => ({ id, seedKey: key, title: "Same Title", author: "Ralph Waldo Emerson", year: null, publicDomainLikely: true });
    const twins = [twin("t1", "b".repeat(64)), twin("t2", "a".repeat(64)), twin("t3", "c".repeat(64))];
    const records = gutenbergRecords(entries()).filter((r) => r.url.endsWith("/1001")).map((r) => ({ ...r, title: "Same Title" }));
    const cs = matchAll(twins, records);
    expect(cs).toHaveLength(3);
    const a = renderReviewTable(twins, cs, "s");
    expect(renderReviewTable([...twins].reverse(), [...cs].reverse(), "s")).toBe(a);
    expect(parseReviewTable(a).map((r) => r.seedKey[0])).toEqual(["a", "b", "c"]);
    // Code-point order: uppercase sorts before lowercase, unlike a locale comparison.
    const mk = (id: string, title: string): SeedInput => ({ ...twin(id, id.repeat(64)), title });
    const ordered = [mk("1", "apple"), mk("2", "Zebra")];
    const rec = [{ url: "https://www.gutenberg.org/ebooks/5", title: "apple", author: "Emerson, Ralph Waldo", standalone: true }, { url: "https://www.gutenberg.org/ebooks/6", title: "Zebra", author: "Emerson, Ralph Waldo", standalone: true }];
    const t = parseReviewTable(renderReviewTable(ordered, matchAll(ordered, rec), "s"));
    expect(t.map((r) => r.candidateTitle)).toEqual(["Zebra", "apple"]);
  });

  it("guard: only allowlisted metadata columns appear", () => {
    expect([...REVIEW_COLUMNS]).toEqual([
      "Seed key", "Seed title", "Seed author", "Seed PD likely", "Candidate title", "Candidate author", "Candidate URL",
      "Gutenberg id", "Tier", "Score", "Translation", "Action", "QA verdict", "Owner decision",
    ]);
    const lines = table.split("\n").filter((l) => l.startsWith("|"));
    const header = lines.find((l) => l.startsWith("| Seed key"))!;
    expect(header).toBe(`| ${REVIEW_COLUMNS.join(" | ")} |`);
    const start = lines.indexOf(header);
    for (const line of lines.slice(start + 2)) {
      expect(line.split(/(?<!\\)\|/).length - 2).toBe(REVIEW_COLUMNS.length);
      expect(line.length).toBeLessThan(900);
    }
    expect(() => parseReviewTable(table.replace("| QA verdict |", "| Notes |"))).toThrow("review_table_columns");
  });

  it("keeps QA and owner cells across a re-plan", () => {
    const rows = parseReviewTable(table);
    const edited = table.replace(`| ${rows[0]!.action} |  |  |`, `| ${rows[0]!.action} | same work | approve |`);
    expect(edited).not.toBe(table);
    expect(render(candidates(seeds), seeds, reviewCells(parseReviewTable(edited)))).toBe(edited);
  });
});

describe("apply reviewed links", () => {
  let pg: TestPg;
  let db: Db;
  let sourceId: string;
  const rowsFor = (): ReviewRow[] => parseReviewTable(renderReviewTable(keyedSeeds(), candidates(), "Project Gutenberg", { catalogDate: "2026-11-10" }));
  const withOwner = (rows: ReviewRow[], id: number, owner: string) => rows.map((r) => (Number(r.gutenbergId) === id ? { ...r, owner } : r));
  const links = async () =>
    (await db.query<{ n: number; status: string; url: string; by: string | null }>(
      "SELECT regexp_replace(candidate_url, '.*/', '')::int AS n, status, candidate_url AS url, reviewed_by AS by FROM seed_source_links ORDER BY n",
    )).rows;
  const statusOf = async () => (await links()).map((l) => `${l.n}:${l.status}:${l.by ?? ""}`);

  beforeAll(async () => {
    ({ pg, db } = await essaysDb());
    sourceId = (await registerGutenbergSource(db)).id;
    for (const s of keyedSeeds()) {
      await db.query(
        "INSERT INTO seed_items (title, author, status, public_domain_likely, seed_list_key) VALUES ($1, $2, 'approved', $3, $4)",
        [s.title, s.author, s.publicDomainLikely, s.seedKey],
      );
    }
  });
  afterAll(async () => {
    await pg.close();
  });
  beforeEach(async () => {
    await db.query("DELETE FROM seed_source_links");
    await db.query("UPDATE seed_items SET public_domain_likely = true WHERE title <> 'An Apology for Idlers'");
  });

  it("loads seeds with their seed key", async () => {
    expect((await loadApprovedSeeds(db)).every((s) => s.seedKey && /^[0-9a-f]{64}$/.test(s.seedKey))).toBe(true);
  });

  it("approves tier A auto rows, leaves tier B proposed, and a rerun changes nothing", async () => {
    const first = await applyReviewedLinks(db, sourceId, rowsFor(), { ref: "r1" });
    expect(first).toEqual({ inserted: 4, updated: 0, skipped: 0 });
    expect(await statusOf()).toEqual([`${ID.emerson}:approved:auto:tier-a`, `${ID.civil}:proposed:`, `${ID.studies}:approved:auto:tier-a`, `${ID.lamb}:approved:auto:tier-a`].sort((a, b) => Number(a.split(":")[0]) - Number(b.split(":")[0])));
    const before = JSON.stringify((await db.query("SELECT * FROM seed_source_links ORDER BY candidate_url")).rows);
    expect(await applyReviewedLinks(db, sourceId, rowsFor(), { ref: "r1" })).toEqual({ inserted: 0, updated: 0, skipped: 4 });
    expect(JSON.stringify((await db.query("SELECT * FROM seed_source_links ORDER BY candidate_url")).rows)).toBe(before);
  });

  it("an owner decision on a tier B row approves or rejects it, recorded as owner:<ref>", async () => {
    await applyReviewedLinks(db, sourceId, rowsFor(), { ref: "r1" });
    await applyReviewedLinks(db, sourceId, withOwner(rowsFor(), ID.civil, "Approve"), { ref: "abc123" });
    expect((await links()).find((l) => l.n === ID.civil)).toMatchObject({ status: "approved", by: "owner:abc123" });

    await db.query("DELETE FROM seed_source_links");
    await applyReviewedLinks(db, sourceId, withOwner(rowsFor(), ID.civil, "reject"), { ref: "abc123" });
    expect((await links()).find((l) => l.n === ID.civil)).toMatchObject({ status: "rejected", by: "owner:abc123" });
  });

  it("never overwrites an existing decision", async () => {
    await applyReviewedLinks(db, sourceId, rowsFor(), { ref: "r1" });
    await db.query("UPDATE seed_source_links SET status = 'rejected', reviewed_by = 'owner:earlier' WHERE candidate_url LIKE '%/1001'");
    // A blank cell leaves it alone; an approval asked for by name aborts instead of doing nothing.
    expect((await applyReviewedLinks(db, sourceId, rowsFor(), { ref: "r2" })).updated).toBe(0);
    for (const opts of [{ ref: "r2" }, { ref: "r2", only: [ID.emerson] }]) {
      await expect(applyReviewedLinks(db, sourceId, withOwner(rowsFor(), ID.emerson, "approve"), opts)).rejects.toMatchObject({ code: "approve_on_rejected" });
    }
    await expect(applyReviewedLinks(db, sourceId, rowsFor(), { ref: "r2", only: [ID.emerson] })).rejects.toMatchObject({ code: "approve_on_rejected" });
    expect((await links()).find((l) => l.n === ID.emerson)).toMatchObject({ status: "rejected", by: "owner:earlier" });
  });

  it("--only approves just the named links; the others stay proposed", async () => {
    const res = await applyReviewedLinks(db, sourceId, rowsFor(), { ref: "r1", only: [ID.emerson, ID.studies] });
    expect(res.inserted).toBe(4);
    expect((await links()).map((l) => `${l.n}:${l.status}`)).toEqual([`${ID.emerson}:approved`, `${ID.civil}:proposed`, `${ID.studies}:approved`, `${ID.lamb}:proposed`]);
    // A later full apply promotes the remaining auto row without touching the approved ones.
    const later = await applyReviewedLinks(db, sourceId, rowsFor(), { ref: "r1" });
    expect(later).toEqual({ inserted: 0, updated: 1, skipped: 3 });
  });

  it("--only an id that cannot be approved aborts with zero writes", async () => {
    await expect(applyReviewedLinks(db, sourceId, rowsFor(), { ref: "r1", only: [ID.civil] })).rejects.toMatchObject({ code: "only_not_approvable" });
    await expect(applyReviewedLinks(db, sourceId, rowsFor(), { ref: "r1", only: [999999] })).rejects.toMatchObject({ code: "only_not_in_table" });
    expect(await links()).toEqual([]);
    // The same id with an owner decision is fine.
    await applyReviewedLinks(db, sourceId, withOwner(rowsFor(), ID.civil, "approve"), { ref: "r1", only: [ID.civil] });
    expect((await statusOf())).toContain(`${ID.civil}:approved:owner:r1`);
  });

  it("tier A auto-approves only while the seed is public domain likely", async () => {
    await db.query("UPDATE seed_items SET public_domain_likely = NULL WHERE title = 'Self-Reliance'");
    await applyReviewedLinks(db, sourceId, rowsFor(), { ref: "r1" });
    expect((await links()).find((l) => l.n === ID.emerson)?.status).toBe("proposed");
    expect((await links()).filter((l) => l.status === "approved")).toHaveLength(2);
  });

  it("tier B is never approved without an owner decision, whatever the action cell says", async () => {
    const forged = rowsFor().map((r) => (r.tier === "B" ? { ...r, action: "auto-approve (tier A, public domain likely)" } : r));
    await applyReviewedLinks(db, sourceId, forged, { ref: "r1" });
    expect((await links()).find((l) => l.n === ID.civil)?.status).toBe("proposed");
  });

  it("aborts with zero writes on an unknown seed key, an unknown URL or a bad decision", async () => {
    const ok = rowsFor();
    const attempts: Array<[ReviewRow[], string]> = [
      [ok.map((r, i) => (i === 0 ? { ...r, seedKey: keyOf("not-a-seed") } : r)), "unknown_seed"],
      [ok.map((r, i) => (i === 0 ? { ...r, url: "https://example.com/ebooks/1001" } : r)), "unknown_url"],
      [ok.map((r, i) => (i === 0 ? { ...r, url: "https://www.gutenberg.org/files/1001/1001-0.txt" } : r)), "unknown_url"],
      [ok.map((r, i) => (i === 0 ? { ...r, gutenbergId: "7" } : r)), "unknown_url"],
      [ok.map((r, i) => (i === 0 ? { ...r, owner: "maybe" } : r)), "invalid_decision"],
      [ok.map((r, i) => (i === 0 ? { ...r, seedKey: "xyz" } : r)), "invalid_row"],
      [[...ok, ok[0]!], "duplicate_row"],
      [[], "empty_table"],
    ];
    for (const [rows, code] of attempts) await expect(applyReviewedLinks(db, sourceId, rows, { ref: "r1" })).rejects.toMatchObject({ code });
    await expect(applyReviewedLinks(db, sourceId, ok, { ref: "bad ref!" })).rejects.toMatchObject({ code: "invalid_ref" });
    expect(await links()).toEqual([]);
  });

  it("aborts, with counts only in the message, when one seed would get two approvals", async () => {
    const base = rowsFor().find((r) => Number(r.gutenbergId) === ID.emerson)!;
    const second: ReviewRow = { ...base, url: "https://www.gutenberg.org/ebooks/2002", gutenbergId: "2002", tier: "B", action: "needs review", owner: "approve" };
    const rows = [{ ...base, owner: "approve" }, second];
    const err = await applyReviewedLinks(db, sourceId, rows, { ref: "r1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApplyError);
    expect((err as Error).message).toBe("apply_aborted multiple_approvals (1)");
    expect(await links()).toEqual([]);
  });

  it("an owner approval cannot replace a different approved link of the same seed", async () => {
    await applyReviewedLinks(db, sourceId, rowsFor(), { ref: "r1" });
    const base = rowsFor().find((r) => Number(r.gutenbergId) === ID.emerson)!;
    const other: ReviewRow = { ...base, url: "https://www.gutenberg.org/ebooks/2002", gutenbergId: "2002", tier: "B", action: "needs review", owner: "approve" };
    await expect(applyReviewedLinks(db, sourceId, [other], { ref: "r2" })).rejects.toMatchObject({ code: "approval_conflict" });
    expect((await links()).filter((l) => l.n === 2002)).toEqual([]);
  });
});
