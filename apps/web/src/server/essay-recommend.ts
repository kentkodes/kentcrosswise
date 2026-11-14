// Essay recommendations (essays SPEC "Recommendations"). Pure: no database, no clock, no I/O.
// Each unrated candidate (full text or link-only) is scored against the owner's whole rating history:
// - a liked essay (LIKED_MIN_STARS or more) pulls up the candidates it resembles, weighted by how high it was;
//   a "what worked" tag on it also lifts candidates of the types that tag hints at;
// - a disliked essay (DISLIKED_MAX_STARS or fewer) pushes away the candidates it resembles;
// - the last "length felt" answer nudges candidates of the wrong length down.
// A candidate only has its type(s), author, year, kind and length band, so those are the similarity signals.
// Each ranked candidate names the liked essay that pulled it up (`because`), if any.
import type { LengthBand, LengthFelt, WorkedTag } from "./essay-library";

export const LIKED_MIN_STARS = 4;
export const DISLIKED_MAX_STARS = 2;
/** Stars that neither pull nor push: a rating of this value has weight 0. */
const NEUTRAL_STARS = 3;
/** Subtracted from the score when the last length answer says the candidate is the wrong length. */
const LENGTH_PENALTY = 1;

const SHARED_TYPE = 3;
const SAME_AUTHOR = 2;
const SAME_DECADE = 2;
const ADJACENT_DECADE = 1;

/** The types each "what worked" tag suggests: a liked essay tagged `humor` lifts comedic candidates. */
export const WORKED_TYPE_HINTS: Readonly<Record<WorkedTag, readonly string[]>> = {
  humor: ["comedic"],
  argument: ["argumentative", "political"],
  ideas: ["philosophical", "critical"],
  prose: ["creative_lyric"],
  emotion: ["personal_memoir"],
  surprise: [],
};

const BAND_RANK: Record<LengthBand, number> = { short: 0, medium: 1, long: 2 };

export interface EssayMeta {
  id: string;
  author: string;
  year: number | null;
  types: readonly string[];
  kind: "full" | "link";
  /** Null for link-only essays: they have no text, so no length band. */
  lengthBand: LengthBand | null;
  /** Milliseconds since the epoch, when the essay entered the library. */
  createdAt: number;
}

export interface RatedEssay extends EssayMeta {
  title: string;
  stars: number;
  worked: readonly WorkedTag[];
  lengthFelt: LengthFelt | null;
  /** Milliseconds since the epoch, when the owner last rated it. */
  ratedAt: number;
}

/** The liked essay a recommendation follows. */
export interface Because {
  id: string;
  title: string;
  author: string;
}

export type Ranked<T extends EssayMeta> = T & { score: number; because: Because | null };

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

/** Stars above 3 pull (5 stars +2, 4 stars +1), stars below 3 push (2 stars -1, 1 star -2), 3 is neutral. */
export const weightOf = (stars: number): number => stars - NEUTRAL_STARS;

/** +1 for each "what worked" tag on the rated essay whose hinted types include one of the candidate's types. */
function tagBoost(candidate: EssayMeta, rated: RatedEssay): number {
  return rated.worked.filter((tag) => WORKED_TYPE_HINTS[tag].some((t) => candidate.types.includes(t))).length;
}

/**
 * The last length answer: the rated essay with the latest rating that has one (ties: the larger id). Answers on
 * essays with no length band (links) are skipped, so they never clear an earlier answer on a full text.
 */
function lastLengthAnswer(rated: readonly RatedEssay[]): RatedEssay | undefined {
  let latest: RatedEssay | undefined;
  for (const r of rated) {
    if (r.lengthFelt === null || r.lengthBand === null) continue;
    if (!latest || r.ratedAt > latest.ratedAt || (r.ratedAt === latest.ratedAt && r.id > latest.id)) latest = r;
  }
  return latest;
}

/**
 * 1 when the last length answer says the essay was too long and the candidate is at least that band, or
 * too short and the candidate is at most that band. Unknown bands (links) are never penalised, and a "right"
 * answer gives no penalty.
 */
function lengthPenalty(candidate: EssayMeta, answer: RatedEssay | undefined): number {
  if (!answer || answer.lengthBand === null || candidate.lengthBand === null) return 0;
  const answered = BAND_RANK[answer.lengthBand];
  const band = BAND_RANK[candidate.lengthBand];
  if (answer.lengthFelt === "too_long" && band >= answered) return LENGTH_PENALTY;
  if (answer.lengthFelt === "too_short" && band <= answered) return LENGTH_PENALTY;
  return 0;
}

/**
 * Ranks the unrated candidates, best first. Full text comes before a link at the same score, then the newer
 * essay, then the smaller id. Rated essays are dropped even if passed in, so the result is always unrated material.
 */
export function rankRecommendations<T extends EssayMeta>(candidates: readonly T[], rated: readonly RatedEssay[]): Ranked<T>[] {
  const ratedIds = new Set(rated.map((r) => r.id));
  const liked = rated.filter((r) => r.stars >= LIKED_MIN_STARS);
  const disliked = rated.filter((r) => r.stars <= DISLIKED_MAX_STARS);
  const answer = lastLengthAnswer(rated);
  return candidates
    .filter((c) => !ratedIds.has(c.id))
    .map((c) => {
      let pull = 0;
      let because: Because | null = null;
      for (const r of liked) {
        const value = weightOf(r.stars) * (similarity(c, r) + tagBoost(c, r));
        // Strictly greater: on a tie the first liked essay in the input keeps the credit.
        if (value > pull) {
          pull = value;
          because = { id: r.id, title: r.title, author: r.author };
        }
      }
      const push = disliked.reduce((best, r) => Math.max(best, -weightOf(r.stars) * similarity(c, r)), 0);
      return { ...c, score: pull - push - lengthPenalty(c, answer), because };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.kind === b.kind ? 0 : a.kind === "full" ? -1 : 1) ||
        b.createdAt - a.createdAt ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}
