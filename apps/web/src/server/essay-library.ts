// Essays for the owner (essays SPEC "Reading experience (MVP)"): setup, feed, reader and ratings.
// Runs as web_rw, owner pages only. Essay text never comes from this module; the reader calls
// loadEssayText (essay-text.ts) with the stored key.
import { InputError, isUuid } from "./console";
import type { Queryable } from "./db";
import { LIKED_MIN_STARS, rankRecommendations, type EssayMeta, type Ranked, type RatedEssay } from "./essay-recommend";

// ---------------------------------------------------------------- vocabulary (must match 0001's CHECKs)

export const ESSAY_TYPES = [
  "argumentative",
  "critical",
  "comedic",
  "creative_lyric",
  "personal_memoir",
  "philosophical",
  "political",
  "science_nature",
  "cultural",
  "travel",
] as const;
export type EssayType = (typeof ESSAY_TYPES)[number];

export const ESSAY_LENGTHS = ["short", "medium", "long"] as const;
export type LengthBand = (typeof ESSAY_LENGTHS)[number];

export const WORKED_TAGS = ["ideas", "prose", "argument", "humor", "emotion", "surprise"] as const;
export type WorkedTag = (typeof WORKED_TAGS)[number];

export const LENGTH_FELT = ["too_long", "right", "too_short"] as const;
export type LengthFelt = (typeof LENGTH_FELT)[number];

export const TYPE_LABELS: Record<EssayType, string> = {
  argumentative: "Argumentative",
  critical: "Critical",
  comedic: "Comedic",
  creative_lyric: "Creative / lyric",
  personal_memoir: "Personal / memoir",
  philosophical: "Philosophical",
  political: "Political",
  science_nature: "Science / nature",
  cultural: "Cultural",
  travel: "Travel",
};

export const LENGTH_LABELS: Record<LengthBand, string> = {
  short: "Short (under 2,000 words)",
  medium: "Medium (2,000 to 6,000 words)",
  long: "Long (6,000+ words)",
};

export const LENGTH_NAMES: Record<LengthBand, string> = { short: "Short", medium: "Medium", long: "Long" };

export const WORKED_LABELS: Record<WorkedTag, string> = {
  ideas: "Ideas",
  prose: "Prose",
  argument: "Argument",
  humor: "Humor",
  emotion: "Emotion",
  surprise: "Surprise",
};

export const LENGTH_FELT_LABELS: Record<LengthFelt, string> = {
  too_long: "Too long",
  right: "Right",
  too_short: "Too short",
};

export const FEED_PAGE_SIZE = 20;
export const MAX_FEED_SHOW = 500;
export const RECOMMENDATION_COUNT = 6;
/** Average adult silent reading speed used when an essay has a word count but no stored reading time. */
export const WORDS_PER_MINUTE = 230;

export const isEssayType = (v: unknown): v is EssayType => (ESSAY_TYPES as readonly unknown[]).includes(v);
export const isLengthBand = (v: unknown): v is LengthBand => (ESSAY_LENGTHS as readonly unknown[]).includes(v);

export class EssayNotFoundError extends Error {
  override name = "EssayNotFoundError";
}

// ---------------------------------------------------------------- validation

/** Allowed values only, deduplicated and in the allowlist's order. Anything else is an InputError. */
function pickAllowed<T extends string>(allowed: readonly T[], values: readonly unknown[], what: string): T[] {
  for (const v of values) {
    if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw new InputError(`Unknown ${what}.`);
  }
  return allowed.filter((a) => values.includes(a));
}

export interface Prefs {
  types: EssayType[];
  lengths: LengthBand[];
}

export function parsePrefs(types: readonly unknown[], lengths: readonly unknown[]): Prefs {
  return { types: pickAllowed(ESSAY_TYPES, types, "essay type"), lengths: pickAllowed(ESSAY_LENGTHS, lengths, "length") };
}

export interface RatingInput {
  stars: number;
  worked: WorkedTag[];
  lengthFelt: LengthFelt | null;
}

/** Form values in, a checked rating out. `stars` is a number or a numeric string 1 to 5. */
export function parseRating(input: { stars: unknown; worked: readonly unknown[]; lengthFelt: unknown }): RatingInput {
  const raw = input.stars;
  const stars = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new InputError("Choose 1 to 5 stars.");
  const felt = input.lengthFelt;
  let lengthFelt: LengthFelt | null = null;
  if (felt !== null && felt !== undefined && felt !== "") {
    if (!(LENGTH_FELT as readonly unknown[]).includes(felt)) throw new InputError("Unknown length choice.");
    lengthFelt = felt as LengthFelt;
  }
  return { stars, worked: pickAllowed(WORKED_TAGS, input.worked, "what-worked tag"), lengthFelt };
}

/** The feed size from `?show=`: at least one page, at most MAX_FEED_SHOW; anything odd gets one page. */
export function parseShow(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : Number.NaN;
  return Number.isInteger(n) && n >= FEED_PAGE_SIZE ? Math.min(n, MAX_FEED_SHOW) : FEED_PAGE_SIZE;
}

/** An http(s) link for the owner to open, or null (no javascript:, data: or malformed URLs). */
export function externalHref(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * Where a link-only essay without a source URL points the owner: a web search for the title and author.
 * Built at render time (no URL is stored for seed essays). Fixed https host, so it is always openable.
 */
export function linkSearchHref(title: string, author: string): string {
  return `https://duckduckgo.com/?q=${encodeURIComponent(`${title} ${author} essay`)}`;
}

/** Reading time: the stored value, else a word-count estimate; null when neither is known. */
export function readingMinutesOf(card: { readingMinutes: number | null; wordCount: number | null }): number | null {
  if (card.readingMinutes !== null) return card.readingMinutes;
  return card.wordCount !== null ? Math.max(1, Math.round(card.wordCount / WORDS_PER_MINUTE)) : null;
}

// ---------------------------------------------------------------- setup (prefs)

/** Empty prefs when no row exists yet (the row is created by the first save; it is a singleton, id 1). */
export async function readPrefs(db: Queryable): Promise<Prefs> {
  const { rows } = await db.query<{ types: string[]; lengths: string[] }>("SELECT types, lengths FROM essay_prefs WHERE id = 1");
  return rows[0] ? parsePrefs(rows[0].types, rows[0].lengths) : { types: [], lengths: [] };
}

export async function savePrefs(db: Queryable, prefs: Prefs): Promise<void> {
  const p = parsePrefs(prefs.types, prefs.lengths);
  await db.query(
    `INSERT INTO essay_prefs (id, types, lengths) VALUES (1, $1::text[], $2::text[])
     ON CONFLICT (id) DO UPDATE SET types = EXCLUDED.types, lengths = EXCLUDED.lengths`,
    [p.types, p.lengths],
  );
}

// ---------------------------------------------------------------- feed and recommendations

/**
 * Empty filter arrays mean "no filter". An essay with no word count fails an active length filter, except
 * link-only essays: they have no text, so their length is never known and they are not filtered by it.
 */
const PREFS_FILTER = `(cardinality($1::text[]) = 0 OR EXISTS (
    SELECT 1 FROM essay_categories c WHERE c.essay_id = e.id AND c.type = ANY($1::text[])))
  AND (cardinality($2::text[]) = 0 OR e.kind = 'link' OR e.length_band = ANY($2::text[]))`;

/** types are ordered by confidence, so types[0] is the primary type. */
const CARD_COLUMNS = `e.id, e.kind, e.title, e.author, e.year, e.length_band, e.word_count, e.reading_minutes, e.hook, e.created_at,
  ARRAY(SELECT c.type FROM essay_categories c WHERE c.essay_id = e.id ORDER BY c.confidence DESC, c.type) AS types`;

interface CardRow {
  id: string;
  kind: string;
  title: string;
  author: string;
  year: number | null;
  length_band: string | null;
  word_count: number | null;
  reading_minutes: number | null;
  hook: string | null;
  created_at: Date | string;
  types: string[];
}

export interface EssayCard extends EssayMeta {
  kind: "full" | "link";
  title: string;
  hook: string | null;
  lengthBand: LengthBand | null;
  wordCount: number | null;
  readingMinutes: number | null;
  primaryType: EssayType | null;
}

function toCard(r: CardRow): EssayCard {
  const types = r.types.filter(isEssayType);
  return {
    id: r.id,
    kind: r.kind === "link" ? "link" : "full",
    title: r.title,
    author: r.author,
    year: r.year,
    types,
    createdAt: new Date(r.created_at).getTime(),
    hook: r.hook,
    lengthBand: isLengthBand(r.length_band) ? r.length_band : null,
    wordCount: r.word_count,
    readingMinutes: r.reading_minutes,
    primaryType: types[0] ?? null,
  };
}

/**
 * Active essays that pass the prefs: full-text essays newest first, then link-only essays newest first (the seed
 * links share one created_at, so they would otherwise bury the full essays). Fetches one extra row to know if there is more.
 */
export async function listFeed(db: Queryable, prefs: Prefs, limit: number): Promise<{ cards: EssayCard[]; hasMore: boolean }> {
  const { rows } = await db.query<CardRow>(
    `SELECT ${CARD_COLUMNS} FROM essays e
      WHERE e.status = 'active' AND ${PREFS_FILTER}
      ORDER BY (e.kind = 'full') DESC, e.created_at DESC, e.id
      LIMIT $3`,
    [prefs.types, prefs.lengths, limit + 1],
  );
  return { cards: rows.slice(0, limit).map(toCard), hasMore: rows.length > limit };
}

/**
 * Unrated active essays that pass the prefs, ranked against the owner's highly rated essays.
 * `likedCount` tells the page whether the order is by similarity or just newest first.
 */
export async function listRecommendations(
  db: Queryable,
  prefs: Prefs,
  limit: number,
): Promise<{ cards: Ranked<EssayCard>[]; likedCount: number }> {
  const candidates = await db.query<CardRow>(
    `SELECT ${CARD_COLUMNS} FROM essays e
      WHERE e.status = 'active' AND e.kind = 'full' AND NOT EXISTS (SELECT 1 FROM ratings r WHERE r.essay_id = e.id) AND ${PREFS_FILTER}`,
    [prefs.types, prefs.lengths],
  );
  // Only ratings of active essays count: a rating left on a quarantined essay must not shape the list.
  const rated = await db.query<CardRow & { stars: number }>(
    `SELECT ${CARD_COLUMNS}, r.stars FROM ratings r JOIN essays e ON e.id = r.essay_id WHERE e.status = 'active'`,
  );
  const ratedEssays: RatedEssay[] = rated.rows.map((r) => ({ ...toCard(r), stars: Number(r.stars) }));
  const ranked = rankRecommendations(candidates.rows.map(toCard), ratedEssays);
  return { cards: ranked.slice(0, limit), likedCount: ratedEssays.filter((r) => r.stars >= LIKED_MIN_STARS).length };
}

// ---------------------------------------------------------------- reader and ratings

export interface ReaderEssay extends EssayCard {
  sourceUrl: string | null;
  textS3Key: string | null;
  rating: { stars: number; worked: WorkedTag[]; lengthFelt: LengthFelt | null } | null;
}

/** An active essay with its rating (if any). Undefined for a bad id or an essay not active. */
export async function getReaderEssay(db: Queryable, id: string): Promise<ReaderEssay | undefined> {
  if (!isUuid(id)) return undefined;
  const { rows } = await db.query<CardRow & { source_url: string | null; text_s3_key: string | null; stars: number | null; worked: string[] | null; length_felt: string | null }>(
    `SELECT ${CARD_COLUMNS}, e.source_url, e.text_s3_key, r.stars, r.worked, r.length_felt
       FROM essays e LEFT JOIN ratings r ON r.essay_id = e.id
      WHERE e.id = $1 AND e.status = 'active'`,
    [id],
  );
  const r = rows[0];
  if (!r) return undefined;
  return {
    ...toCard(r),
    sourceUrl: r.source_url,
    textS3Key: r.text_s3_key,
    rating:
      r.stars === null
        ? null
        : {
            stars: Number(r.stars),
            worked: (r.worked ?? []).filter((w): w is WorkedTag => (WORKED_TAGS as readonly string[]).includes(w)),
            lengthFelt: (LENGTH_FELT as readonly string[]).includes(r.length_felt ?? "") ? (r.length_felt as LengthFelt) : null,
          },
  };
}

/** Upserts the owner's one rating for an active full-text essay. Link-only essays cannot be rated (EssayNotFoundError). */
export async function saveRating(db: Queryable, essayId: string, input: RatingInput): Promise<void> {
  if (!isUuid(essayId)) throw new InputError("That essay id is not valid.");
  const r = parseRating({ stars: input.stars, worked: input.worked, lengthFelt: input.lengthFelt });
  const { rows } = await db.query<{ essay_id: string }>(
    `INSERT INTO ratings (essay_id, stars, worked, length_felt, rated_at)
     SELECT e.id, $2, $3::text[], $4, now() FROM essays e WHERE e.id = $1 AND e.status = 'active' AND e.kind = 'full'
     ON CONFLICT (essay_id) DO UPDATE SET
       stars = EXCLUDED.stars, worked = EXCLUDED.worked, length_felt = EXCLUDED.length_felt, rated_at = EXCLUDED.rated_at
     RETURNING essay_id`,
    [essayId, r.stars, r.worked, r.lengthFelt],
  );
  if (rows.length === 0) throw new EssayNotFoundError("The essay is not in the library.");
}
