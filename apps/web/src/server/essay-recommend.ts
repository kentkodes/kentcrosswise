// Essay recommendations (essays SPEC "Recommendations"). Pure: no database, no clock, no I/O.
// Each unrated candidate is scored against every essay the owner rated highly (LIKED_MIN_STARS or
// more) and keeps its best match, weighted by how high that rating was. A candidate only has its
// type(s), author and year, so those are the signals; "what worked" tags are not on candidates and
// are not used. With no highly rated essays every score is 0, so the order is newest first.

export const LIKED_MIN_STARS = 4;

export interface EssayMeta {
  id: string;
  author: string;
  year: number | null;
  types: readonly string[];
  /** Milliseconds since the epoch, when the essay entered the library. */
  createdAt: number;
}

export interface RatedEssay extends EssayMeta {
  stars: number;
}

export type Ranked<T extends EssayMeta> = T & { score: number };

const SHARED_TYPE = 3;
const SAME_AUTHOR = 2;
const SAME_DECADE = 2;
const ADJACENT_DECADE = 1;

const normalizeAuthor = (author: string) => author.trim().replace(/\s+/g, " ").toLowerCase();

/** Similarity of a candidate to one rated essay: 0 (nothing shared) up to 7. */
export function similarity(candidate: EssayMeta, rated: EssayMeta): number {
  let score = 0;
  if (candidate.types.some((t) => rated.types.includes(t))) score += SHARED_TYPE;
  if (normalizeAuthor(candidate.author) === normalizeAuthor(rated.author)) score += SAME_AUTHOR;
  if (candidate.year !== null && rated.year !== null) {
    const decades = Math.abs(Math.floor(candidate.year / 10) - Math.floor(rated.year / 10));
    if (decades === 0) score += SAME_DECADE;
    else if (decades === 1) score += ADJACENT_DECADE;
  }
  return score;
}

/** A 4-star essay counts 1 and a 5-star essay counts 2 (liked essays only). */
export const weightOf = (stars: number): number => stars - LIKED_MIN_STARS + 1;

/**
 * Ranks the unrated candidates, best first. Ties go to the newer essay, then to the smaller id.
 * Rated essays are dropped even if passed in, so the result is always unrated material.
 */
export function rankRecommendations<T extends EssayMeta>(candidates: readonly T[], rated: readonly RatedEssay[]): Ranked<T>[] {
  const ratedIds = new Set(rated.map((r) => r.id));
  const liked = rated.filter((r) => r.stars >= LIKED_MIN_STARS);
  return candidates
    .filter((c) => !ratedIds.has(c.id))
    .map((c) => ({
      ...c,
      score: liked.reduce((best, r) => Math.max(best, weightOf(r.stars) * similarity(c, r)), 0),
    }))
    .sort((a, b) => b.score - a.score || b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
