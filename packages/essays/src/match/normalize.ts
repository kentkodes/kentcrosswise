const ARTICLES = new Set(["a", "an", "the"]);
const HONORIFICS = new Set(["sir", "dr", "mr", "mrs", "ms", "st", "saint", "lord", "lady", "rev"]);

function base(s: string): string {
  return s.normalize("NFKC").toLowerCase();
}

function squash(s: string): string {
  return s
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Title -> comparison form: NFKC, lowercase, no parentheticals, no subtitle after a colon, no trailing
 * translator phrase, no trailing "by <author>" (only when the name is the author), no punctuation,
 * no leading article. `author` (raw) lets "Self-Reliance by Ralph Waldo Emerson" reduce to the title.
 */
export function normalizeTitle(title: string, author?: string): string {
  let t = base(title).replace(/\([^)]*\)|\[[^\]]*\]/g, " ");
  const colon = t.indexOf(":");
  if (colon > 0) t = t.slice(0, colon);
  t = t.replace(/[\s,]+(?:trans\.?|translated by|translation by)(?=\s).*$/, "");
  const by = /\s+by\s+(.+)$/.exec(t);
  if (by && author) {
    const names = new Set(squash(base(author)).split(" "));
    if (squash(by[1] ?? "").split(" ").every((w) => names.has(w))) t = t.slice(0, by.index);
  }
  const words = squash(t).split(" ").filter(Boolean);
  if (words.length > 1 && ARTICLES.has(words[0] ?? "")) words.shift();
  return words.join(" ");
}

/** Author -> `surname, given` (normalized). "Ralph Waldo Emerson" and "Emerson, Ralph Waldo, 1803-1882" agree. */
export function normalizeAuthor(author: string): string {
  const a = base(author)
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(?:trans\.?|translated by)(?=\s).*$/, "")
    .replace(/\b\d{3,4}\??\s*[-–]\s*\d{0,4}\??/g, " ")
    .replace(/\b(?:jr|sr|ii|iii)\b\.?/g, " ");
  const comma = a.indexOf(",");
  let surname: string;
  let given: string;
  if (comma >= 0) {
    surname = squash(a.slice(0, comma));
    given = squash(a.slice(comma + 1));
  } else {
    const words = squash(a).split(" ").filter(Boolean);
    // Last word is the surname; particles stay with the given names ("Michel de Montaigne" -> "montaigne, michel de").
    surname = words.at(-1) ?? "";
    given = words.slice(0, -1).join(" ");
  }
  const givenWords = given.split(" ").filter((w) => w && !HONORIFICS.has(w));
  return givenWords.length ? `${surname}, ${givenWords.join(" ")}` : surname;
}
