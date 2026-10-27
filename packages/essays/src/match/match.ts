import { canonicalAuthor } from "./aliases";
import { normalizeAuthor, normalizeTitle } from "./normalize";
import { titleSimilarity } from "./similarity";

/** An approved seed item, metadata only. */
export interface SeedInput {
  id: string;
  title: string;
  author: string;
  year: number | null;
  /** From the seed list: true, false or unknown (null). */
  publicDomainLikely: boolean | null;
}

/** One catalog entry as the source publishes it (metadata only; never essay text). */
export interface CatalogRecord {
  url: string;
  title: string;
  author: string;
  translator?: string | null;
  translationYear?: number | null;
  /** True only if the source states this translation is public domain. */
  translationPublicDomain?: boolean | null;
  /**
   * True if the source gives this essay its own page. A whole book that merely contains the essay is
   * false: it is never ingested, so the seed stays link-only (design section 3, rule 4).
   */
  standalone: boolean;
}

export type Tier = "A" | "B";

export interface Candidate {
  seedId: string;
  url: string;
  title: string;
  author: string;
  translator: string | null;
  translationYear: number | null;
  tier: Tier;
  score: number;
  evidence: {
    title: "exact" | "similar";
    author: "exact" | "variant";
    titleSimilarity: number;
  };
  /** Tier A with `public_domain_likely` true, an original text, and no rival tier A candidate. */
  autoApprove: boolean;
}

/** Tier B threshold on title similarity (design section 3). */
export const TIER_B_MIN_SIMILARITY = 0.85;
const TIER_B_MAX_SCORE = 0.99;
/** Score of a title-equal match whose author is only a known variant. */
const VARIANT_SCORE = 0.95;

/**
 * Matches one seed against catalog records (pure, deterministic).
 * - Dropped (tier C, not returned): a seed known not to be public domain (license_policy pd_only),
 *   a record that is not a stand-alone page, a translation not stated public domain, everything else.
 * - A: normalized title and author both equal. B: author equal and title similarity >= 0.85, or title
 *   equal and author a known variant.
 */
export function matchSeed(seed: SeedInput, catalog: readonly CatalogRecord[]): Candidate[] {
  if (seed.publicDomainLikely === false) return [];
  const seedAuthor = normalizeAuthor(seed.author);
  const seedTitle = normalizeTitle(seed.title, seed.author);
  const out: Candidate[] = [];

  for (const rec of catalog) {
    if (!rec.standalone) continue;
    const translator = rec.translator?.trim() || null;
    if (translator && rec.translationPublicDomain !== true) continue;

    const recAuthor = normalizeAuthor(rec.author);
    const recTitle = normalizeTitle(rec.title, rec.author);
    const titleEqual = recTitle !== "" && recTitle === seedTitle;
    const authorExact = recAuthor === seedAuthor;
    const authorVariant = !authorExact && canonicalAuthor(recAuthor) === canonicalAuthor(seedAuthor);
    const sim = titleEqual ? 1 : titleSimilarity(seedTitle, recTitle);

    let tier: Tier | null = null;
    let score = 0;
    if (titleEqual && authorExact) {
      tier = "A";
      score = 1;
    } else if (authorExact && sim >= TIER_B_MIN_SIMILARITY) {
      tier = "B";
      score = Math.min(TIER_B_MAX_SCORE, sim);
    } else if (titleEqual && authorVariant) {
      tier = "B";
      score = VARIANT_SCORE;
    }
    if (!tier) continue;

    out.push({
      seedId: seed.id,
      url: rec.url,
      title: rec.title,
      author: rec.author,
      translator,
      translationYear: translator ? (rec.translationYear ?? null) : null,
      tier,
      score: Math.round(score * 1000) / 1000,
      evidence: {
        title: titleEqual ? "exact" : "similar",
        author: authorExact ? "exact" : "variant",
        titleSimilarity: Math.round(sim * 1000) / 1000,
      },
      autoApprove: false,
    });
  }

  out.sort((x, y) => y.score - x.score || (x.url < y.url ? -1 : x.url > y.url ? 1 : 0));
  const tierA = out.filter((c) => c.tier === "A");
  if (tierA.length === 1 && seed.publicDomainLikely === true && !tierA[0]?.translator) {
    (tierA[0] as Candidate).autoApprove = true;
  }
  return out;
}

/** Matches every seed; the result is ordered by seed order, then score. */
export function matchAll(seeds: readonly SeedInput[], catalog: readonly CatalogRecord[]): Candidate[] {
  return seeds.flatMap((s) => matchSeed(s, catalog));
}
