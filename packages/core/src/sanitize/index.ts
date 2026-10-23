// Public sanitization (DESIGN §4.5): the deterministic check every public task title passes before it
// reaches a public surface (the office feed or GitHub). A title that fails is never shown or
// redacted piecemeal: the feed shows `Private task` instead, and GitHub issue text goes to an
// `issue_text` approval. The contact list comes from `contacts.name`/`aliases` (readable by orch_rw).

/** What the public feed shows instead of a title that is private, missing or fails the check (§3.2). */
export const PRIVATE_TITLE = "Private task";

/** Maximum public title length (§4.5; also the `tasks.public_title` CHECK in migration 0002). */
export const MAX_TITLE_LENGTH = 60;

/** Why a title was rejected. Codes only: a reason never quotes the matched (possibly private) text. */
export const VIOLATIONS = [
  "empty",
  "too_long",
  "non_ascii",
  "email",
  "handle",
  "url",
  "phone",
  "digit_run",
  "contact",
  "blocklist",
] as const;
export type Violation = (typeof VIOLATIONS)[number];

/** One contact's name and aliases, as stored in `contacts` (§3.1). */
export interface ContactNames {
  name: string;
  aliases?: readonly string[] | null;
}

export interface SanitizerOptions {
  /** Every contact (name and aliases). A title containing any word of any of them is rejected. */
  contacts: readonly ContactNames[];
  /** Extra terms (words or phrases) that may never appear in a public title. Case-insensitive. */
  blocklist?: readonly string[];
}

export type CheckResult = { ok: true; violations: [] } | { ok: false; violations: Violation[] };

export interface Sanitizer {
  /** Runs every rule of §4.5 and lists all violations (in `VIOLATIONS` order). */
  check(title: string): CheckResult;
  /** The title if it passes, otherwise `Private task`. Null/undefined (no title) is also `Private task`. */
  publicTitle(title: string | null | undefined): string;
}

// ------------------------------------------------------------------ patterns
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const HANDLE = /@[a-z0-9_]/i;
const URL_PATTERNS = [
  /[a-z][a-z0-9+.-]*:\/\//i, // any scheme: https://, ftp://, ...
  /\bwww\./i,
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/i, // bare domains (example.com, foo.co.uk); also "Node.js"
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/, // IPv4
];
// A run of digits with phone separators; it counts as a phone number when it holds 7+ digits.
const PHONE_CANDIDATE = /\+?\(?\d[\d\s().\-/]*\d/g;
const PHONE_MIN_DIGITS = 7;
const DIGIT_RUN = /\d{5,}/; // "digit runs > 4"

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
function fold(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[ßæœøłđðþı]/g, (c) => FOLD[c] ?? c);
}

/** Words of a (folded) string: runs of letters or digits in any script. */
function words(s: string): string[] {
  return fold(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
}

/**
 * Builds a reusable checker. Contact matching is per word and fails closed: every word of a
 * contact's name or alias (and the name written as one word, e.g. "janedoe") is a forbidden
 * title word, so "Jane" alone is rejected for the contact "Jane Doe". Blocklist terms match as
 * substrings of the title's normalized words ("tax return" also matches "Tax-Returns").
 */
export function createSanitizer(opts: SanitizerOptions): Sanitizer {
  const contactWords = new Set<string>();
  for (const c of opts.contacts) {
    for (const label of [c.name, ...(c.aliases ?? [])]) {
      const ws = words(label);
      for (const w of ws) contactWords.add(w);
      if (ws.length > 1) contactWords.add(ws.join(""));
    }
  }
  const blockTerms = (opts.blocklist ?? []).map((t) => words(t).join(" ")).filter((t) => t.length > 0);

  function check(title: string): CheckResult {
    const v = new Set<Violation>();
    if (title.trim().length === 0) v.add("empty");
    if (title.length > MAX_TITLE_LENGTH) v.add("too_long");
    if (!PRINTABLE_ASCII.test(title)) v.add("non_ascii");
    if (EMAIL.test(title)) v.add("email");
    else if (HANDLE.test(title)) v.add("handle");
    if (URL_PATTERNS.some((re) => re.test(title))) v.add("url");
    for (const m of title.matchAll(PHONE_CANDIDATE)) {
      if ((m[0].match(/\d/g)?.length ?? 0) >= PHONE_MIN_DIGITS) v.add("phone");
    }
    if (DIGIT_RUN.test(title)) v.add("digit_run");
    const titleWords = words(title);
    if (titleWords.some((w) => contactWords.has(w))) v.add("contact");
    const joined = ` ${titleWords.join(" ")} `;
    if (blockTerms.some((t) => joined.includes(t))) v.add("blocklist");

    if (v.size === 0) return { ok: true, violations: [] };
    return { ok: false, violations: VIOLATIONS.filter((x) => v.has(x)) };
  }

  return {
    check,
    publicTitle: (title) => (title != null && check(title).ok ? title : PRIVATE_TITLE),
  };
}

/** One-off check; build a `createSanitizer` once when checking several titles. */
export function checkPublicTitle(title: string, opts: SanitizerOptions): CheckResult {
  return createSanitizer(opts).check(title);
}

/** The minimal query surface needed to read contacts (fits `@kcw/db` SqlClient, node-postgres, PGlite). */
export interface ContactQuery {
  query<R>(sql: string): Promise<{ rows: R[] }>;
}

/** Reads only the columns orch_rw may read (§3.4: `SELECT (id, name, aliases) ON contacts`). */
export const CONTACT_NAMES_SQL = "SELECT name, aliases FROM contacts";

/** Loads every contact's name and aliases for `createSanitizer`. */
export async function loadContactNames(db: ContactQuery): Promise<ContactNames[]> {
  const { rows } = await db.query<{ name: string; aliases: string[] | null }>(CONTACT_NAMES_SQL);
  return rows.map((r) => ({ name: r.name, aliases: r.aliases ?? [] }));
}
