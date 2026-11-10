import type { Db } from "../db";
import { gutenbergId } from "../discovery/gutenberg";
import type { Candidate, SeedInput } from "./match";
import { AUTO_APPROVE_ACTION, type ReviewRow } from "./review";

interface SeedRow {
  id: string;
  seed_list_key: string | null;
  title: string;
  author: string;
  year: number | null;
  public_domain_likely: boolean | null;
}

/** Approved seed items, ready for the matcher. */
export async function loadApprovedSeeds(db: Db): Promise<SeedInput[]> {
  const { rows } = await db.query<SeedRow>(
    "SELECT id, seed_list_key, title, author, year, public_domain_likely FROM seed_items WHERE status = 'approved' ORDER BY title, id",
  );
  return rows.map((r) => ({ id: r.id, seedKey: r.seed_list_key, title: r.title, author: r.author, year: r.year, publicDomainLikely: r.public_domain_likely }));
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

export interface ApplyOptions {
  /** Review reference (for example the commit of the confirmed table); recorded as `owner:<ref>`. */
  ref: string;
  /** Gutenberg ids to approve. When given, every other row is only kept as `proposed`. */
  only?: readonly number[];
  now?: Date;
}

export interface ApplyResult {
  inserted: number;
  /** A proposed link that received its decision. */
  updated: number;
  /** Already decided, or still undecided and already stored: left untouched. */
  skipped: number;
}

/** Fixed codes only: a failed apply never echoes titles, keys or URLs. */
export type ApplyErrorCode =
  | "invalid_ref" | "empty_table" | "invalid_row" | "duplicate_row" | "invalid_decision" | "unknown_url"
  | "unknown_seed" | "only_not_in_table" | "only_not_approvable" | "multiple_approvals" | "approval_conflict" | "approve_on_rejected";

export class ApplyError extends Error {
  constructor(readonly code: ApplyErrorCode, readonly count: number) {
    super(`apply_aborted ${code} (${count})`);
    this.name = "ApplyError";
  }
}

interface Wanted {
  status: "approved" | "rejected" | "proposed";
  by: string | null;
  /** An approval the owner asked for by name (decision or `only`): a conflict aborts instead of downgrading. */
  strict: boolean;
}

function safeGutenbergId(url: string): number | null {
  try {
    return gutenbergId(url);
  } catch {
    return null;
  }
}

/**
 * Applies the owner-confirmed review table to `seed_source_links`, keyed by seed key and candidate
 * URL. Per row: `approve`/`reject` in the owner cell sets that status; a blank cell approves only a
 * tier A auto-approve row whose seed is public_domain_likely true (the matcher's `autoApprove` rule);
 * everything else stays `proposed`. An existing decision (approved or rejected) is never changed.
 * Every check runs before the first write, so an unknown seed key, a bad URL or an unapprovable
 * `--only` id aborts with zero writes.
 */
export async function applyReviewedLinks(db: Db, sourceId: string, rows: readonly ReviewRow[], opts: ApplyOptions): Promise<ApplyResult> {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(opts.ref)) throw new ApplyError("invalid_ref", 0);
  if (!rows.length) throw new ApplyError("empty_table", 0);
  const only = opts.only ? new Set(opts.only) : null;

  const seen = new Set<string>();
  let bad = 0;
  for (const r of rows) {
    const score = Number(r.score);
    if (!/^[0-9a-f]{64}$/.test(r.seedKey) || !["A", "B"].includes(r.tier) || !(score >= 0 && score <= 1) || !r.candidateTitle || !r.candidateAuthor) bad += 1;
    const id = safeGutenbergId(r.url);
    if (id === null || String(id) !== r.gutenbergId || r.url !== `https://www.gutenberg.org/ebooks/${id}`) throw new ApplyError("unknown_url", 1);
    if (!["", "approve", "reject"].includes(r.owner.trim().toLowerCase())) throw new ApplyError("invalid_decision", 1);
    const key = `${r.seedKey}\n${r.url}`;
    if (seen.has(key)) throw new ApplyError("duplicate_row", 1);
    seen.add(key);
  }
  if (bad) throw new ApplyError("invalid_row", bad);

  const keys = [...new Set(rows.map((r) => r.seedKey))];
  const seeds = await db.query<{ id: string; seed_list_key: string; public_domain_likely: boolean | null }>(
    "SELECT id, seed_list_key, public_domain_likely FROM seed_items WHERE seed_list_key = ANY($1::text[])",
    [keys],
  );
  const seedByKey = new Map(seeds.rows.map((s) => [s.seed_list_key, s]));
  if (seedByKey.size !== keys.length) throw new ApplyError("unknown_seed", keys.length - seedByKey.size);

  const tableIds = new Set(rows.map((r) => Number(r.gutenbergId)));
  const missingOnly = [...(only ?? [])].filter((id) => !tableIds.has(id));
  if (missingOnly.length) throw new ApplyError("only_not_in_table", missingOnly.length);

  const existing = await db.query<{ seed_item_id: string; candidate_url: string; status: string }>(
    "SELECT seed_item_id, candidate_url, status FROM seed_source_links WHERE source_id = $1 AND seed_item_id = ANY($2::uuid[])",
    [sourceId, seeds.rows.map((s) => s.id)],
  );
  const linkStatus = new Map(existing.rows.map((l) => [`${l.seed_item_id}\n${l.candidate_url}`, l.status]));
  const approvedUrl = new Map(existing.rows.filter((l) => l.status === "approved").map((l) => [l.seed_item_id, l.candidate_url]));

  const plan: Array<{ row: ReviewRow; seedId: string; wanted: Wanted }> = [];
  const approvals = new Set<string>();
  let notApprovable = 0;
  let conflicts = 0;
  for (const row of rows) {
    const seed = seedByKey.get(row.seedKey) as { id: string; public_domain_likely: boolean | null };
    const inOnly = only ? only.has(Number(row.gutenbergId)) : true;
    const decision = row.owner.trim().toLowerCase();
    const auto = decision === "" && row.action === AUTO_APPROVE_ACTION && row.tier === "A" && seed.public_domain_likely === true && !row.translation;
    let wanted: Wanted = { status: "proposed", by: null, strict: false };
    if (inOnly && decision === "approve") wanted = { status: "approved", by: `owner:${opts.ref}`, strict: true };
    else if (inOnly && auto) wanted = { status: "approved", by: "auto:tier-a", strict: only !== null };
    else if (inOnly && decision === "reject" && !only) wanted = { status: "rejected", by: `owner:${opts.ref}`, strict: false };
    if (only && inOnly && wanted.status !== "approved") notApprovable += 1;

    if (wanted.status === "approved") {
      // An approval asked for by name cannot silently do nothing because the link was already rejected.
      if (wanted.strict && linkStatus.get(`${seed.id}\n${row.url}`) === "rejected") throw new ApplyError("approve_on_rejected", 1);
      const other = approvedUrl.get(seed.id);
      if ((other !== undefined && other !== row.url) || approvals.has(seed.id)) {
        if (approvals.has(seed.id) && wanted.strict) throw new ApplyError("multiple_approvals", 1);
        if (wanted.strict) conflicts += 1;
        wanted = { status: "proposed", by: null, strict: false };
      } else approvals.add(seed.id);
    }
    plan.push({ row, seedId: seed.id, wanted });
  }
  if (notApprovable) throw new ApplyError("only_not_approvable", notApprovable);
  if (conflicts) throw new ApplyError("approval_conflict", conflicts);

  const now = (opts.now ?? new Date()).toISOString();
  const result: ApplyResult = { inserted: 0, updated: 0, skipped: 0 };
  await db.query("BEGIN");
  try {
    for (const { row, seedId, wanted } of plan) {
      const current = linkStatus.get(`${seedId}\n${row.url}`);
      const decided = wanted.status !== "proposed";
      if (current === undefined) {
        const t = /^translation by (.+?)(?: \((\d{4})\))?$/.exec(row.translation);
        await db.query(
          `INSERT INTO seed_source_links
             (seed_item_id, source_id, candidate_url, candidate_title, candidate_author, translator, translation_year,
              tier, score, status, reviewed_by, reviewed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (seed_item_id, source_id, candidate_url) DO NOTHING`,
          [seedId, sourceId, row.url, row.candidateTitle, row.candidateAuthor, t?.[1] ?? null, t?.[2] ? Number(t[2]) : null,
            row.tier, Number(row.score), wanted.status, wanted.by, decided ? now : null],
        );
        result.inserted += 1;
      } else if (current === "proposed" && decided) {
        await db.query(
          "UPDATE seed_source_links SET status = $4, reviewed_by = $5, reviewed_at = $6 WHERE seed_item_id = $1 AND source_id = $2 AND candidate_url = $3 AND status = 'proposed'",
          [seedId, sourceId, row.url, wanted.status, wanted.by, now],
        );
        result.updated += 1;
      } else result.skipped += 1;
    }
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
  return result;
}
