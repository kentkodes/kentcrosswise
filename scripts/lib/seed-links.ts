// Link-only essays for approved seeds that have no essay yet (owner option b). Category comes from the
// seed-list type; no model is called and no URL is stored (the reader builds a search link at render time).
import { seedListKey, type SeedListEntry } from "@kcw/db/seed-list";
import type { SqlClient } from "@kcw/db";

/** Seed-list type labels to the essay type slugs of migration 0001 (essay_categories.type). */
export const SEED_TYPE_SLUGS: Readonly<Record<string, string>> = {
  argumentative: "argumentative",
  critical: "critical",
  comedic: "comedic",
  "creative/lyric": "creative_lyric",
  "personal/memoir": "personal_memoir",
  philosophical: "philosophical",
  political: "political",
  "science/nature": "science_nature",
  cultural: "cultural",
  travel: "travel",
};

export interface UnlinkedSeed {
  id: string;
  title: string;
  author: string;
  year: number | null;
  seed_list_key: string | null;
}

export interface LinkPlan {
  seedId: string;
  title: string;
  author: string;
  year: number | null;
  type: string;
}

export interface LinkPlanResult {
  plans: LinkPlan[];
  /** Seeds whose list entry has a type outside SEED_TYPE_SLUGS, and the distinct type labels seen. */
  unknownType: number;
  unknownTypes: string[];
  /** Seeds with no matching SEED-LIST entry (no type to take). */
  unmatched: number;
}

/**
 * Pure: matches each seed to its SEED-LIST entry by the stable key (sha256 of title|author, stored as
 * seed_list_key at import) and maps the listed type to a slug. Unknown or unmatched seeds are counted and skipped.
 */
export function planSeedLinks(seeds: readonly UnlinkedSeed[], entries: readonly SeedListEntry[]): LinkPlanResult {
  const byKey = new Map(entries.map((e) => [seedListKey(e), e]));
  const plans: LinkPlan[] = [];
  const unknownTypes = new Set<string>();
  let unknownType = 0;
  let unmatched = 0;
  for (const s of seeds) {
    const entry = s.seed_list_key ? byKey.get(s.seed_list_key) : undefined;
    if (!entry) {
      unmatched++;
      continue;
    }
    const type = Object.hasOwn(SEED_TYPE_SLUGS, entry.type) ? SEED_TYPE_SLUGS[entry.type] : undefined;
    if (!type) {
      unknownType++;
      unknownTypes.add(entry.type);
      continue;
    }
    plans.push({ seedId: s.id, title: s.title, author: s.author, year: s.year, type });
  }
  return { plans, unknownType, unknownTypes: [...unknownTypes].sort(), unmatched };
}

/**
 * Approved seeds with no essay yet. Excluded: any seed that already has an essay, any seed the Gutenberg
 * ingest will store as full text (an essay_urls row or an approved seed_source_links row), so a link card
 * is never created for a work that ingest turns into full text.
 */
const UNLINKED_SEEDS = `SELECT s.id, s.title, s.author, s.year, s.seed_list_key FROM seed_items s
  WHERE s.status = 'approved' AND s.essay_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM essays e WHERE e.seed_item_id = s.id)
    AND NOT EXISTS (SELECT 1 FROM essay_urls u WHERE u.seed_item_id = s.id)
    AND NOT EXISTS (SELECT 1 FROM seed_source_links l WHERE l.seed_item_id = s.id AND l.status = 'approved')
  ORDER BY s.title, s.id`;

export async function findUnlinkedSeeds(db: SqlClient): Promise<UnlinkedSeed[]> {
  const { rows } = await db.query<UnlinkedSeed & { year: number | null }>(UNLINKED_SEEDS);
  return rows.map((r) => ({ ...r, year: r.year === null ? null : Number(r.year) }));
}

/**
 * Inserts one link essay per plan, its single category (confidence 1, model `seed-list`) and the seed's essay_id,
 * in one transaction. The essay insert is guarded by NOT EXISTS on its seed, and the transaction first takes a
 * transaction-level advisory lock so a parallel run waits and then sees the committed rows. Returns the number of
 * essays created; a rerun (or a stale plan) finds the seed already linked and creates nothing.
 */
export async function insertSeedLinks(db: SqlClient, plans: readonly LinkPlan[]): Promise<number> {
  await db.exec("BEGIN");
  let created = 0;
  try {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('kcw-link-seed-essays'))");
    for (const p of plans) {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO essays (kind, title, author, year, status, seed_item_id)
         SELECT 'link', $1::text, $2::text, $3::integer, 'active', $4::uuid
          WHERE NOT EXISTS (SELECT 1 FROM essays e WHERE e.seed_item_id = $4::uuid)
         RETURNING id`,
        [p.title, p.author, p.year, p.seedId],
      );
      if (rows.length === 0) continue;
      const essayId = rows[0]!.id;
      await db.query("INSERT INTO essay_categories (essay_id, type, confidence, model) VALUES ($1, $2, 1, 'seed-list')", [essayId, p.type]);
      await db.query("UPDATE seed_items SET essay_id = $1 WHERE id = $2 AND essay_id IS NULL", [essayId, p.seedId]);
      created++;
    }
    await db.exec("COMMIT");
  } catch (err) {
    await db.exec("ROLLBACK");
    throw err;
  }
  return created;
}

export interface LinkCounts {
  unlinkedSeeds: number;
  essaysFull: number;
  essaysLink: number;
  categories: number;
}

/** Read-only counts, safe to print for any target. */
export async function countLinkState(db: SqlClient): Promise<LinkCounts> {
  const unlinked = await db.query<{ n: string }>(`SELECT count(*) AS n FROM (${UNLINKED_SEEDS}) u`);
  const byKind = await db.query<{ kind: string; n: string }>("SELECT kind, count(*) AS n FROM essays GROUP BY kind");
  const cats = await db.query<{ n: string }>("SELECT count(*) AS n FROM essay_categories");
  const kind = (k: string) => Number(byKind.rows.find((r) => r.kind === k)?.n ?? 0);
  return {
    unlinkedSeeds: Number(unlinked.rows[0]!.n),
    essaysFull: kind("full"),
    essaysLink: kind("link"),
    categories: Number(cats.rows[0]!.n),
  };
}

export interface LinkReport {
  before: LinkCounts;
  after: LinkCounts;
  plan: LinkPlanResult;
  /** Essays created (always 0 in a dry run). */
  inserted: number;
  dryRun: boolean;
}

/**
 * Counts, plan, one-transaction insert, counts again. A dry run stops after the plan and writes nothing.
 * Titles never leave this function except via LinkPlan.
 */
export async function runSeedLinks(db: SqlClient, entries: readonly SeedListEntry[], opts: { dryRun?: boolean } = {}): Promise<LinkReport> {
  const dryRun = opts.dryRun === true;
  const before = await countLinkState(db);
  const plan = planSeedLinks(await findUnlinkedSeeds(db), entries);
  const inserted = dryRun ? 0 : await insertSeedLinks(db, plan.plans);
  return { before, after: await countLinkState(db), plan, inserted, dryRun };
}

const fmtCounts = (c: LinkCounts) =>
  `unlinked_seeds=${c.unlinkedSeeds} essays_full=${c.essaysFull} essays_link=${c.essaysLink} categories=${c.categories}`;

export function formatSeedLinks(label: string, r: LinkReport): string[] {
  const lines = [
    `${label}: before: ${fmtCounts(r.before)}`,
    r.dryRun
      ? `${label}: dry run, nothing written: ${r.plan.plans.length} link essays would be inserted`
      : `${label}: ${r.inserted} link essays inserted`,
  ];
  if (r.plan.unmatched > 0) lines.push(`${label}: skipped ${r.plan.unmatched} approved seeds with no SEED-LIST entry`);
  if (r.plan.unknownType > 0) {
    lines.push(`${label}: skipped ${r.plan.unknownType} seeds with unknown type (${r.plan.unknownTypes.join(", ")})`);
  }
  lines.push(`${label}: after: ${fmtCounts(r.after)}`);
  return lines;
}
