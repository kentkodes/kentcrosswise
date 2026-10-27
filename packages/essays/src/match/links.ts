import type { Db } from "../db";
import type { Candidate, SeedInput } from "./match";

interface SeedRow {
  id: string;
  title: string;
  author: string;
  year: number | null;
  public_domain_likely: boolean | null;
}

/** Approved seed items, ready for the matcher. */
export async function loadApprovedSeeds(db: Db): Promise<SeedInput[]> {
  const { rows } = await db.query<SeedRow>(
    "SELECT id, title, author, year, public_domain_likely FROM seed_items WHERE status = 'approved' ORDER BY title, id",
  );
  return rows.map((r) => ({ id: r.id, title: r.title, author: r.author, year: r.year, publicDomainLikely: r.public_domain_likely }));
}

export interface ProposeResult {
  inserted: number;
  autoApproved: number;
  /** Already known (proposed, approved or rejected): left untouched. */
  skipped: number;
}

/**
 * Stores matcher output in `seed_source_links`. Rerun-safe: a link that already exists for the same
 * seed, source and URL is never touched (so approved and rejected links stay as decided). Only
 * `autoApprove` candidates are approved here, and only if the seed has no approved link yet.
 */
export async function proposeLinks(db: Db, sourceId: string, candidates: readonly Candidate[], now: Date = new Date()): Promise<ProposeResult> {
  const result: ProposeResult = { inserted: 0, autoApproved: 0, skipped: 0 };
  for (const c of candidates) {
    let approve = false;
    if (c.autoApprove) {
      const { rows } = await db.query("SELECT 1 FROM seed_source_links WHERE seed_item_id = $1 AND status = 'approved'", [c.seedId]);
      approve = rows.length === 0;
    }
    const { rows } = await db.query(
      `INSERT INTO seed_source_links
         (seed_item_id, source_id, candidate_url, candidate_title, candidate_author, translator, translation_year,
          tier, score, evidence, status, reviewed_by, reviewed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
       ON CONFLICT (seed_item_id, source_id, candidate_url) DO NOTHING RETURNING 1`,
      [
        c.seedId, sourceId, c.url, c.title, c.author, c.translator, c.translationYear, c.tier, c.score,
        JSON.stringify(c.evidence), approve ? "approved" : "proposed", approve ? "auto:tier-a" : null,
        approve ? now.toISOString() : null,
      ],
    );
    if (!rows.length) result.skipped += 1;
    else {
      result.inserted += 1;
      if (approve) result.autoApproved += 1;
    }
  }
  return result;
}
