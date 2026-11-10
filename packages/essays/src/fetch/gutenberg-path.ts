/**
 * Pure helpers for the Project Gutenberg rsync mirror (main collection). No URL is built here: book
 * files come only from a mirror directory that rsync copies, never from www.gutenberg.org.
 */

/** Fixed code: no UTF-8 plain-text file (only a latin-1 `-8.txt`, or nothing). The owner picks another book. */
export const NO_USABLE_TEXT = "no_usable_text";

/** A Gutenberg ebook number: 1 to 7 digits, no leading zero. Returns null for anything else. */
export function parseBookId(value: string): number | null {
  return /^[1-9][0-9]{0,6}$/.test(value) ? Number(value) : null;
}

/**
 * The directory of book `id` in the main collection: each digit but the last is a level
 * (12345 -> `1/2/3/4/12345/`), and ids below 10 live under `0/` (`0/7/`).
 */
export function bookDir(id: number): string {
  if (!Number.isSafeInteger(id) || id < 1 || id > 9_999_999) throw new Error("invalid_book_id");
  const digits = String(id);
  const levels = digits.length === 1 ? ["0"] : digits.slice(0, -1).split("");
  return `${[...levels, digits].join("/")}/`;
}

/**
 * The UTF-8 plain-text file among the names found in a book directory: `<id>-0.txt`, else `<id>.txt`.
 * `<id>-8.txt` (latin-1) is never selected. Null means `no_usable_text`.
 */
export function pickTextFile(names: readonly string[], id: number): string | null {
  for (const name of [`${id}-0.txt`, `${id}.txt`]) if (names.includes(name)) return name;
  return null;
}

/** Decodes strictly as UTF-8 (a stray latin-1 byte fails). A leading BOM stays in the string. Null when invalid. */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}
