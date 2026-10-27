/**
 * Known author variants, checked in so the owner can review them. Key = canonical `surname, given`
 * (normalized: lowercase, no punctuation); values = other normalized spellings of the same person.
 * A match through this table is a "variant" and lands in tier B at best.
 */
export const AUTHOR_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "montaigne, michel de": ["montaigne, michel eyquem de", "montaigne, michel"],
  "twain, mark": ["clemens, samuel langhorne", "clemens, samuel l"],
  "eliot, george": ["evans, mary ann"],
  "orwell, george": ["blair, eric arthur"],
  "lamb, charles": ["elia"],
  "quincey, thomas de": ["de quincey, thomas", "quincey, thomas"],
  "stevenson, robert louis": ["stevenson, robert louis balfour"],
  "chesterton, g k": ["chesterton, gilbert keith"],
  "thoreau, henry david": ["thoreau, henry d"],
};

const VARIANT_TO_CANONICAL = new Map<string, string>();
for (const [canonical, variants] of Object.entries(AUTHOR_ALIASES)) {
  VARIANT_TO_CANONICAL.set(canonical, canonical);
  for (const v of variants) VARIANT_TO_CANONICAL.set(v, canonical);
}

/** The canonical spelling of a normalized author, or the input if it has no alias entry. */
export function canonicalAuthor(normalized: string): string {
  return VARIANT_TO_CANONICAL.get(normalized) ?? normalized;
}
