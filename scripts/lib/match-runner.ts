import { PGlite } from "@electric-sql/pglite";
import { fromPglite, migrate, type SqlClient } from "@kcw/db";
import { parseYear, seedListKey, type SeedListEntry } from "@kcw/db/seed-list";
import { readFile, writeFile } from "node:fs/promises";
import { createPoliteClient } from "../../packages/essays/src/crawl/polite";
import { CATALOG_URL } from "../../packages/essays/src/discovery/watcher";
import { parseGutenbergCatalog } from "../../packages/essays/src/discovery/gutenberg";
import { applyReviewedLinks, loadApprovedSeeds, type ApplyResult } from "../../packages/essays/src/match/links";
import { gutenbergRecords } from "../../packages/essays/src/match/gutenberg-records";
import { matchAll, type SeedInput } from "../../packages/essays/src/match/match";
import { parseReviewTable, renderReviewTable, reviewCells } from "../../packages/essays/src/match/review";
import { registerGutenbergSource, GUTENBERG_SLUG } from "../../packages/essays/src/registry/bootstrap";
import { loadSource } from "../../packages/essays/src/registry/source";

/** Seeds straight from SEED-LIST.json entries (metadata only), keyed like the database import. */
export function seedsFromList(entries: readonly SeedListEntry[]): SeedInput[] {
  return entries.map((e) => {
    const key = seedListKey(e);
    return { id: key, seedKey: key, title: e.title, author: e.author, year: parseYear(e.year), publicDomainLikely: e.public_domain_likely };
  });
}

/** Approved seeds from the database that carry a seed key (the table is keyed on it). */
export async function seedsFromDb(db: SqlClient): Promise<SeedInput[]> {
  return (await loadApprovedSeeds(db)).filter((s) => s.seedKey);
}

/**
 * One polite fetch of the published catalog CSV. The request goes through the standard client
 * (robots, rate lease, user agent) against a throwaway in-memory database, so the target database
 * is never written by a plan.
 */
export async function fetchCatalogCsv(opts: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => Date } = {}): Promise<string> {
  const pg = new PGlite();
  try {
    const db = fromPglite(pg);
    await migrate(db);
    await registerGutenbergSource(db);
    const source = await loadSource(db, GUTENBERG_SLUG);
    if (!source) throw new Error("source_missing");
    const client = createPoliteClient({
      db, source, maxBodyBytes: 64 * 1024 * 1024, ...(opts.fetch && { fetch: opts.fetch }), ...(opts.sleep && { sleep: opts.sleep }), ...(opts.now && { now: opts.now }),
    });
    const res = await client.get(CATALOG_URL);
    if (!res.ok) throw new Error(`catalog_fetch_failed: ${res.reason}`);
    return res.body;
  } finally {
    await pg.close();
  }
}

export interface PlanCounts {
  seeds: number;
  candidates: number;
  tierA: number;
  tierB: number;
  autoApprovable: number;
}

/**
 * Matches the seeds against the catalog and renders the review table. QA and owner cells already
 * filled in `previousTable` (by seed key and URL) are carried over. Writes nothing.
 */
export function buildPlan(input: {
  seeds: readonly SeedInput[];
  catalogCsv: string;
  catalogDate: string;
  previousTable?: string | null;
}): { markdown: string; counts: PlanCounts } {
  const records = gutenbergRecords(parseGutenbergCatalog(input.catalogCsv));
  const candidates = matchAll(input.seeds, records);
  const previous = input.previousTable ? reviewCells(parseReviewTable(input.previousTable)) : undefined;
  const markdown = renderReviewTable(input.seeds, candidates, "Project Gutenberg", {
    catalogDate: input.catalogDate,
    ...(previous && { previous }),
  });
  return {
    markdown,
    counts: {
      seeds: input.seeds.length,
      candidates: candidates.length,
      tierA: candidates.filter((c) => c.tier === "A").length,
      tierB: candidates.filter((c) => c.tier === "B").length,
      autoApprovable: candidates.filter((c) => c.autoApprove).length,
    },
  };
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** `plan`: writes the review table file (the only write) and returns counts. No database writes. */
export async function runPlan(input: { seeds: readonly SeedInput[]; catalogCsv: string; catalogDate: string; outPath: string }): Promise<PlanCounts> {
  const { markdown, counts } = buildPlan({ ...input, previousTable: await readIfExists(input.outPath) });
  await writeFile(input.outPath, markdown, "utf8");
  return counts;
}

export interface LinkCounts {
  proposed: number;
  approved: number;
  rejected: number;
}

export async function countLinks(db: SqlClient): Promise<LinkCounts> {
  const { rows } = await db.query<{ status: string; n: string }>("SELECT status, count(*) AS n FROM seed_source_links GROUP BY status");
  const n = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
  return { proposed: n("proposed"), approved: n("approved"), rejected: n("rejected") };
}

/** Parses `--only` ("123 456" or "123,456"): Gutenberg ids, at most 7 digits each. */
export function parseOnly(value: string): number[] {
  const ids = value.split(/[,\s]+/).filter(Boolean);
  if (!ids.length || ids.some((s) => !/^[1-9][0-9]{0,6}$/.test(s))) throw new Error("--only takes Gutenberg ids, for example --only \"1342 2701\"");
  return [...new Set(ids.map(Number))];
}

export interface ApplyReport {
  before: LinkCounts;
  after: LinkCounts;
  result: ApplyResult;
}

/** `apply`: reads the owner-confirmed table and writes link decisions; counts before and after. */
export async function runApply(input: { db: SqlClient; tablePath: string; ref: string; only?: readonly number[] }): Promise<ApplyReport> {
  const rows = parseReviewTable(await readFile(input.tablePath, "utf8"));
  const source = await loadSource(input.db, GUTENBERG_SLUG);
  if (!source) throw new Error("source_missing: run register-source first");
  const before = await countLinks(input.db);
  const result = await applyReviewedLinks(input.db, source.id, rows, { ref: input.ref, ...(input.only && { only: input.only }) });
  return { before, after: await countLinks(input.db), result };
}

export const formatLinks = (c: LinkCounts): string => `proposed=${c.proposed} approved=${c.approved} rejected=${c.rejected}`;
