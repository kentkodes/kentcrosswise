/**
 * Duplicate checks of the essay validator (docs/essays/SPEC.md item 4). Pure; never returns or logs essay text.
 *   exact:    sha256 of the normalized text (case, punctuation and whitespace ignored).
 *   near:     MinHash signature over the word 5-shingles of the normalized text; similarity = share of equal slots.
 *   metadata: same normalized author and a title at METADATA_DUPLICATE_MIN_SIMILARITY or above.
 * The store phase applies these before it writes anything (scripts/lib/essay-ingest.ts).
 */
import { createHash } from "node:crypto";
import { normalizeAuthor, normalizeTitle } from "../match/normalize";
import { titleSimilarity } from "../match/similarity";

/** Two texts at or above this MinHash similarity are near duplicates. */
export const NEAR_DUPLICATE_MIN_SIMILARITY = 0.9;
/**
 * Title similarity at or above which two works by the same author are one work. Stricter than seed matching's
 * tier B (0.85): the closest distinct same-author pair in docs/essays/SEED-LIST.json scores 0.861 (Orwell,
 * "Politics vs. Literature" and "Politics and the English Language"), and spelling variants score about 0.95+.
 */
export const METADATA_DUPLICATE_MIN_SIMILARITY = 0.9;
/** Signature length: the number of hash functions. */
export const MINHASH_SIZE = 128;
const SHINGLE_WORDS = 5;

/** NFKC, lowercase, letters, digits and whitespace only, single spaces, trimmed. */
export function normalizeForHash(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** sha256 hex of the normalized text: the exact-duplicate key (essays.text_hash). */
export function normalizedTextHash(text: string): string {
  return createHash("sha256").update(normalizeForHash(text), "utf8").digest("hex");
}

function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Fixed (a, b) pairs from a xorshift32 stream with a fixed seed: the same signature on every run and platform.
const PAIRS: ReadonlyArray<readonly [number, number]> = (() => {
  let s = 0x2545f491;
  const next = (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return s >>> 0;
  };
  return Array.from({ length: MINHASH_SIZE }, () => [next() | 1, next()] as const);
})();

/** One hash per fixed pair: a multiply-add, then a 32-bit finaliser so every input bit reaches the output. */
function slot(x: number, a: number, b: number): number {
  let h = (Math.imul(a, x) + b) | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x45d9f3b);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * MinHash signature of the normalized text: for each of MINHASH_SIZE fixed hash functions, the minimum over the
 * word 5-shingles. Each value is a signed 32-bit integer (Postgres integer[]). A text under 5 words is one shingle.
 */
export function minhash(text: string): number[] {
  const words = normalizeForHash(text).split(" ").filter(Boolean);
  const shingles = new Set<string>();
  if (words.length < SHINGLE_WORDS) shingles.add(words.join(" "));
  else for (let i = 0; i + SHINGLE_WORDS <= words.length; i++) shingles.add(words.slice(i, i + SHINGLE_WORDS).join(" "));
  const mins = new Array<number>(MINHASH_SIZE).fill(0xffffffff);
  for (const shingle of shingles) {
    const x = fnv1a32(shingle);
    for (let k = 0; k < MINHASH_SIZE; k++) {
      const [a, b] = PAIRS[k]!;
      const v = slot(x, a, b);
      if (v < mins[k]!) mins[k] = v;
    }
  }
  return mins.map((v) => v | 0);
}

/** Estimated Jaccard similarity of two signatures: the share of equal slots. 0 for empty or unequal lengths. */
export function minhashSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let equal = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) equal++;
  return equal / a.length;
}

export interface WorkRef {
  title: string;
  author: string;
}

/** Same normalized author and a title at METADATA_DUPLICATE_MIN_SIMILARITY (the title is normalized with its author, as in matching). */
export function isMetadataDuplicate(a: WorkRef, b: WorkRef): boolean {
  if (normalizeAuthor(a.author) !== normalizeAuthor(b.author)) return false;
  const ta = normalizeTitle(a.title, a.author);
  const tb = normalizeTitle(b.title, b.author);
  if (!ta || !tb) return false;
  return titleSimilarity(ta, tb) >= METADATA_DUPLICATE_MIN_SIMILARITY;
}
