// Public-domain essays for the /demo Essays tab. Link-only: facts, a source link and a hook, never essay text.
// Titles, authors and source URLs come from the reviewed match file (docs/essays/GUTENBERG-MATCH-REVIEW.md,
// tier A rows); year and type come from docs/essays/SEED-LIST.json ("unknown" years are left out, not guessed).
// Word counts are the extractor's counts from the public ingest run. Hooks are written for the demo
// (hookWrittenForDemo); the real library's hooks are model-written. No network, database or clock is used.

export const ESSAY_LENGTH_BANDS = ["Short", "Medium", "Long"] as const;
export type EssayLengthBand = (typeof ESSAY_LENGTH_BANDS)[number];

export interface DemoEssay {
  /** Project Gutenberg ebook number. */
  id: string;
  title: string;
  author: string;
  /** Four-digit year from the seed list, or null where the seed list says "unknown". */
  year: number | null;
  /** Seed-list essay type. */
  type: string;
  words: number;
  /** Project Gutenberg ebook page. */
  sourceUrl: string;
  /** One original sentence written for the demo. */
  hook: string;
  hookWrittenForDemo: true;
}

/** A simulated earlier rating by the demo reader (1 to 5 stars). */
export interface DemoEssayRating {
  essayId: string;
  stars: number;
}

/** Same words-per-minute constant as the owner reader (apps/web/src/server/essay-library.ts). */
export const DEMO_WORDS_PER_MINUTE = 230;

/** Essays SPEC bands: Short under 2k words, Medium 2k to 6k, Long 6k and over. */
export function lengthBand(words: number): EssayLengthBand {
  return words < 2000 ? "Short" : words < 6000 ? "Medium" : "Long";
}

export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / DEMO_WORDS_PER_MINUTE));
}

export const DEMO_ESSAYS: readonly DemoEssay[] = [
  {
    id: "3172",
    title: "Fenimore Cooper's Literary Offences",
    author: "Mark Twain",
    year: 1895,
    type: "comedic",
    words: 4879,
    sourceUrl: "https://www.gutenberg.org/ebooks/3172",
    hook: "A gleeful takedown that tallies the sins of a popular adventure novelist like a prosecutor with a grudge.",
    hookWrittenForDemo: true,
  },
  {
    id: "73549",
    title: "How It Feels to Be Colored Me",
    author: "Zora Neale Hurston",
    year: null,
    type: "personal/memoir",
    words: 1602,
    sourceUrl: "https://www.gutenberg.org/ebooks/73549",
    hook: "A short, buoyant self-portrait about identity worn lightly and defended fiercely.",
    hookWrittenForDemo: true,
  },
  {
    id: "63022",
    title: "Mr. Bennett and Mrs. Brown",
    author: "Virginia Woolf",
    year: 1924,
    type: "critical",
    words: 7891,
    sourceUrl: "https://www.gutenberg.org/ebooks/63022",
    hook: "A literary quarrel staged around a stranger on a train, about what fiction should try to capture.",
    hookWrittenForDemo: true,
  },
  {
    id: "62636",
    title: "To the Person Sitting in Darkness",
    author: "Mark Twain",
    year: null,
    type: "argumentative",
    words: 4725,
    sourceUrl: "https://www.gutenberg.org/ebooks/62636",
    hook: "A sarcastic open letter that turns the language of empire back on the people using it.",
    hookWrittenForDemo: true,
  },
  {
    id: "1022",
    title: "Walking",
    author: "Henry David Thoreau",
    year: null,
    type: "science/nature",
    words: 12114,
    sourceUrl: "https://www.gutenberg.org/ebooks/1022",
    hook: "A long, stubborn case for wandering outdoors as a discipline and a way of thinking.",
    hookWrittenForDemo: true,
  },
  {
    id: "78663",
    title: "The Whistle",
    author: "Benjamin Franklin",
    year: null,
    type: "comedic",
    words: 612,
    sourceUrl: "https://www.gutenberg.org/ebooks/78663",
    hook: "A tiny, wry lesson about paying too much for something you only wanted for a moment.",
    hookWrittenForDemo: true,
  },
];

/** Fixed simulated ratings: what the demo reader "already read and rated". */
export const DEMO_ESSAY_RATINGS: readonly DemoEssayRating[] = [
  { essayId: "3172", stars: 5 },
  { essayId: "73549", stars: 4 },
];

export interface DemoRecommendation {
  essayId: string;
  likedId: string;
}

/**
 * The best unrated essay for the reader's liked (4 or 5 star) essays, with the liked essay it follows.
 * Score: same type 2, same author 1. Ties go to the higher rating, then to feed order. Null if nothing matches.
 */
export function recommend(
  essays: readonly DemoEssay[] = DEMO_ESSAYS,
  ratings: readonly DemoEssayRating[] = DEMO_ESSAY_RATINGS,
): DemoRecommendation | null {
  const rated = new Set(ratings.map((r) => r.essayId));
  const liked = ratings
    .filter((r) => r.stars >= 4)
    .map((r) => ({ stars: r.stars, essay: essays.find((e) => e.id === r.essayId) }))
    .filter((r): r is { stars: number; essay: DemoEssay } => r.essay !== undefined);
  let best: { score: number; stars: number; rec: DemoRecommendation } | null = null;
  for (const e of essays) {
    if (rated.has(e.id)) continue;
    for (const l of liked) {
      const score = (e.type === l.essay.type ? 2 : 0) + (e.author === l.essay.author ? 1 : 0);
      if (score === 0) continue;
      if (!best || score > best.score || (score === best.score && l.stars > best.stars)) {
        best = { score, stars: l.stars, rec: { essayId: e.id, likedId: l.essay.id } };
      }
    }
  }
  return best?.rec ?? null;
}
