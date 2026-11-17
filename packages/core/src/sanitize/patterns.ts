// Shared rules of the public sanitizer (DESIGN §4.5): the title check (`index.ts`) and the replace mode
// (`redact.ts`) use the same patterns and the same word folding.

export const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
export const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
export const HANDLE = /@[a-z0-9_]/i;
export const URL_PATTERNS = [
  /[a-z][a-z0-9+.-]*:\/\//i, // any scheme: https://, ftp://, ...
  /\bwww\./i,
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/i, // bare domains (example.com, foo.co.uk); also "Node.js"
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/, // IPv4
];
// A run of digits with phone separators; it counts as a phone number when it holds 7+ digits.
export const PHONE_CANDIDATE = /\+?\(?\d[\d\s().\-/]*\d/g;
export const PHONE_MIN_DIGITS = 7;
export const DIGIT_RUN = /\d{5,}/; // "digit runs > 4"

// Letters NFKD does not decompose into an ASCII base letter.
const FOLD: Readonly<Record<string, string>> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
  ı: "i",
};

/** Lowercase, strip accents and fold special letters, so "José" and "jose" compare equal. */
export function fold(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[ßæœøłđðþı]/g, (c) => FOLD[c] ?? c);
}

/** Words of a (folded) string: runs of letters or digits in any script. */
export function words(s: string): string[] {
  return fold(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
}
