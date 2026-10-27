import type { TestPg } from "./db-helpers";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db";
import { loadApprovedSeeds, proposeLinks } from "../src/match/links";
import { matchAll, matchSeed, type CatalogRecord, type SeedInput } from "../src/match/match";
import { normalizeAuthor, normalizeTitle } from "../src/match/normalize";
import { renderReviewTable } from "../src/match/review";
import { jaroWinkler, tokenSetDice } from "../src/match/similarity";
import { addSource, essaysDb } from "./db-helpers";

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
const catalog = fixture<{ provenance: string; records: CatalogRecord[] }>("catalog-sample.json");
const seedFile = fixture<{ provenance: string; seeds: SeedInput[] }>("seeds-sample.json");
const seed = (id: string): SeedInput => seedFile.seeds.find((s) => s.id === id)!;
const urls = (cs: Array<{ url: string }>) => cs.map((c) => c.url.replace("https://catalog.example.com/works/", ""));

describe("fixtures", () => {
  it("record public-domain provenance and carry only short metadata strings", () => {
    for (const f of [catalog, seedFile]) {
      expect(f.provenance).toMatch(/public.domain|No essay text/);
      expect(f.provenance).toContain("No essay text");
    }
    const strings = (v: unknown): string[] =>
      typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];
    for (const s of strings(catalog.records).concat(strings(seedFile.seeds))) expect(s.length).toBeLessThan(120);
    for (const r of catalog.records) expect(r.url).toMatch(/^https:\/\/catalog\.example\.com\//);
  });
});

describe("normalization", () => {
  it("normalizes titles", () => {
    expect(normalizeTitle("The Art of Doing: A Study")).toBe("art of doing");
    expect(normalizeTitle('A "Clergyman"')).toBe("clergyman");
    expect(normalizeTitle("Self-Reliance")).toBe("self reliance");
    expect(normalizeTitle("Ｓelf Reliance")).toBe("self reliance"); // NFKC
    expect(normalizeTitle("Otherwise Known as the Human Condition (with particular reference to Doughnuts)")).toBe(
      "otherwise known as the human condition",
    );
    expect(normalizeTitle("Self-Reliance, trans. A. Person")).toBe("self reliance");
    expect(normalizeTitle("Self-Reliance by Ralph Waldo Emerson", "Ralph Waldo Emerson")).toBe("self reliance");
    expect(normalizeTitle("Stopping by Woods", "Robert Frost")).toBe("stopping by woods");
    expect(normalizeTitle("The")).toBe("the");
  });

  it("normalizes authors to surname, given", () => {
    expect(normalizeAuthor("Ralph Waldo Emerson")).toBe("emerson, ralph waldo");
    expect(normalizeAuthor("Emerson, Ralph Waldo, 1803-1882")).toBe("emerson, ralph waldo");
    expect(normalizeAuthor("Michel de Montaigne")).toBe(normalizeAuthor("Montaigne, Michel de, 1533-1592"));
    expect(normalizeAuthor("Sir Francis Bacon")).toBe("bacon, francis");
    expect(normalizeAuthor("Elia")).toBe("elia");
  });

  it("scores similarity", () => {
    expect(jaroWinkler("abc", "abc")).toBe(1);
    expect(jaroWinkler("", "a")).toBe(0);
    expect(jaroWinkler("martha", "marhta")).toBeCloseTo(0.961, 2);
    expect(tokenSetDice("a b c", "c b a")).toBe(1);
    expect(tokenSetDice("a b", "c d")).toBe(0);
  });
});

describe("matchSeed tiers", () => {
  it("tier A: exact title and author, auto-approved for a public-domain-likely seed", () => {
    const [a, ...rest] = matchSeed(seed("seed-studies"), catalog.records);
    expect(rest).toHaveLength(0);
    expect(a).toMatchObject({ tier: "A", score: 1, autoApprove: true, evidence: { title: "exact", author: "exact" } });
    expect(urls([a!])).toEqual(["108"]); // subtitle after the colon ignored
  });

  it("tier A with unknown public-domain status needs review", () => {
    expect(matchSeed(seed("seed-idlers"), catalog.records)).toMatchObject([{ tier: "A", autoApprove: false }]);
  });

  it("two equally exact candidates are never auto-approved", () => {
    const cs = matchSeed(seed("seed-emerson"), catalog.records);
    expect(urls(cs).sort()).toEqual(["101", "111"]);
    expect(cs.every((c) => c.tier === "A" && !c.autoApprove)).toBe(true);
  });

  it("a seed known not to be public domain gets no candidate", () => {
    expect(catalog.records.some((r) => r.title === "Shooting an Elephant")).toBe(true);
    expect(matchSeed(seed("seed-elephant"), catalog.records)).toEqual([]);
  });

  it("tier B: near-miss title with the same author, never auto", () => {
    const cs = matchSeed(seed("seed-civil"), catalog.records);
    expect(urls(cs)).toEqual(["105"]);
    expect(cs[0]).toMatchObject({ tier: "B", autoApprove: false, evidence: { title: "similar", author: "exact" } });
    expect(cs[0]!.score).toBeGreaterThanOrEqual(0.85);
    expect(cs[0]!.score).toBeLessThanOrEqual(0.99);
  });

  it("drops a different work by the same author, and whole-book records", () => {
    const urlsForCivil = urls(matchSeed(seed("seed-civil"), catalog.records));
    expect(urlsForCivil).not.toContain("107"); // Resistance to Civil Government: too different
    expect(urlsForCivil).not.toContain("106"); // a book containing the essay: not stand-alone
    const ofTruth: SeedInput = { ...seed("seed-studies"), title: "Of Wisdom" };
    expect(matchSeed(ofTruth, catalog.records)).toEqual([]);
    // A shared "Of" is not evidence: Of Studies vs Of Solitude is dropped.
    const solitude = matchSeed({ ...seed("seed-studies"), title: "Of Studies" }, catalog.records);
    expect(urls(solitude)).toEqual(["108"]);
  });

  it("tier B: equal title with a known author variant (pseudonym)", () => {
    const cs = matchSeed(seed("seed-roastpig"), catalog.records);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ tier: "B", score: 0.95, autoApprove: false, evidence: { title: "exact", author: "variant" } });
  });

  it("an unknown author variant is dropped", () => {
    const s: SeedInput = { ...seed("seed-roastpig"), author: "Some Other Writer" };
    expect(matchSeed(s, catalog.records)).toEqual([]);
  });

  it("translations: eligible only if the source states public domain; recorded; never auto", () => {
    const cs = matchSeed(seed("seed-friendship"), catalog.records);
    expect(urls(cs)).toEqual(["102"]); // 103 is a modern translation, not stated public domain
    expect(cs[0]).toMatchObject({ tier: "A", translator: "Charles Cotton", translationYear: 1685, autoApprove: false });
  });

  it("a seed with no catalog entry stays link-only", () => {
    expect(matchSeed(seed("seed-modern"), catalog.records)).toEqual([]);
  });

  it("is deterministic", () => {
    expect(matchAll(seedFile.seeds, catalog.records)).toEqual(matchAll([...seedFile.seeds], [...catalog.records].reverse()));
  });
});

describe("review table", () => {
  const candidates = matchAll(seedFile.seeds, catalog.records);
  const table = renderReviewTable(seedFile.seeds, candidates, "Gutenberg-style sample");

  it("reports counts and one row per candidate", () => {
    expect(table).toContain("| Seeds checked | 8 |");
    expect(table).toContain("| Seeds marked public domain likely | 5 |");
    expect(table).toContain("| Seeds with a candidate | 6 |");
    expect(table).toContain("| Tier A auto-approvable | 1 |");
    expect(table).toContain("| Seeds staying link-only | 2 |");
    expect(table.split("\n").filter((l) => l.includes("catalog.example.com"))).toHaveLength(candidates.length);
    expect(table).toContain("translation by Charles Cotton (1685)");
    expect(table).toContain("auto-approve (tier A, public domain likely)");
  });

  it("is deterministic, metadata only and escapes table syntax", () => {
    expect(renderReviewTable(seedFile.seeds, [...candidates].reverse(), "Gutenberg-style sample")).toBe(table);
    const tricky: SeedInput = { id: "t", title: "A | B", author: "X", year: null, publicDomainLikely: true };
    const out = renderReviewTable([tricky], [{ ...candidates[0]!, seedId: "t", title: "A | B\nC" }], "s");
    expect(out).toContain("A \\| B");
    expect(out).not.toContain("B\nC");
  });
});

describe("proposeLinks", () => {
  let pg: TestPg;
  let db: Db;
  beforeAll(async () => {
    ({ pg, db } = await essaysDb());
  });
  afterAll(async () => {
    await pg.close();
  });

  it("stores proposals, auto-approves tier A only, and is rerun-safe", async () => {
    const sourceId = await addSource(db, "sample", "https://catalog.example.com");
    const ids = new Map<string, string>();
    for (const s of seedFile.seeds) {
      const { rows } = await db.query<{ id: string }>(
        "INSERT INTO seed_items (title, author, status, public_domain_likely) VALUES ($1, $2, 'approved', $3) RETURNING id",
        [s.title, s.author, s.publicDomainLikely],
      );
      ids.set(s.id, rows[0]!.id);
    }
    const seeds = (await loadApprovedSeeds(db)).map((s) => ({ ...s }));
    expect(seeds).toHaveLength(8);
    const candidates = matchAll(seeds, catalog.records);

    const first = await proposeLinks(db, sourceId, candidates);
    expect(first.inserted).toBe(candidates.length);
    expect(first.autoApproved).toBe(1);
    const status = async () =>
      (await db.query<{ status: string; n: number }>("SELECT status, count(*) AS n FROM seed_source_links GROUP BY status ORDER BY status")).rows;
    expect(await status()).toEqual([{ status: "approved", n: 1 }, { status: "proposed", n: candidates.length - 1 }]);

    // The owner rejects one, approves another; a rerun changes nothing.
    await db.query("UPDATE seed_source_links SET status = 'rejected' WHERE candidate_url LIKE '%/105'");
    await db.query("UPDATE seed_source_links SET status = 'approved', reviewed_by = 'owner' WHERE candidate_url LIKE '%/104'");
    const before = JSON.stringify((await db.query("SELECT * FROM seed_source_links ORDER BY candidate_url")).rows);
    const second = await proposeLinks(db, sourceId, candidates);
    expect(second).toEqual({ inserted: 0, autoApproved: 0, skipped: candidates.length });
    expect(JSON.stringify((await db.query("SELECT * FROM seed_source_links ORDER BY candidate_url")).rows)).toBe(before);
    expect(ids.size).toBe(8);
  });

  it("does not auto-approve a second link for a seed that already has one", async () => {
    const sourceId = await addSource(db, "sample-2", "https://catalog2.example.com");
    const seeds = await loadApprovedSeeds(db);
    const studies = seeds.find((s) => s.title === "Of Studies")!;
    const [cand] = matchSeed(studies, catalog.records);
    const res = await proposeLinks(db, sourceId, [{ ...cand!, url: "https://catalog2.example.com/of-studies" }]);
    expect(res).toEqual({ inserted: 1, autoApproved: 0, skipped: 0 });
  });
});
