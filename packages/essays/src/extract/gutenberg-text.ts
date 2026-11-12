/**
 * Extractor `gutenberg-txt` v2: the plain-text edition of a Project Gutenberg ebook. Pure; no I/O.
 * Finds the START and END marker lines (modern and legacy wording), drops everything outside them
 * (header, footer, license), strips a BOM, normalizes line endings and keeps paragraph breaks.
 * Then keeps only what the author wrote (docs/agents/scraper.md, "Clean essay text"): image placeholders,
 * transcriber's/editor's notes, sidenotes, producer credits, page markers and decorative separator rows
 * are removed; emphasis marks and soft hyphen / zero-width characters are stripped. Footnote markers stay.
 */
export const EXTRACTOR_ID = "gutenberg-txt";
export const EXTRACTOR_VERSION = "2";

export interface Extraction {
  /** Normalized text between the markers (empty when the start marker is missing and nothing follows). */
  text: string;
  wordCount: number;
  hasStart: boolean;
  hasEnd: boolean;
}

// Modern: "*** START OF THE PROJECT GUTENBERG EBOOK TITLE ***". Legacy: "THIS" for "THE", "ETEXT" for "EBOOK",
// and the pre-2000s small-print block that ends with "*END*THE SMALL PRINT! ... *END*".
const START = /^\s*\*{3}\s*START OF (?:THE|THIS) PROJECT GUTENBERG (?:EBOOK|E-?TEXT)\b/i;
const START_LEGACY = /^\s*\*END\*\s*THE SMALL PRINT!.*\*END\*\s*$/i;
const END = /^\s*(?:\*{3}\s*END OF (?:THE|THIS) PROJECT GUTENBERG (?:EBOOK|E-?TEXT)\b|End of (?:the |this )?Project Gutenberg(?:'s)? (?:EBook|E-?text)\b)/i;

const BOM = "\uFEFF";

// Cleaning patterns. Bracketed blocks may span lines and may hold one level of nested brackets,
// e.g. "[Transcriber's Note: the [sic] is kept.]". An unclosed bracket matches nothing and is kept.
const INVISIBLE = /\u00AD|\u200B|\u200C|\u200D|\u2060|\uFEFF/g;
const NOTE_BLOCK = /\[\s*(?:Transcriber|Editor)(?:'|’)s\s+Notes?\s*:?(?:[^[\]]|\[[^[\]]*\])*\]/gi;
const SIDENOTE = /\[\s*Sidenote\s*:(?:[^[\]]|\[[^[\]]*\])*\]/gi;
const PLACEHOLDER = /\[\s*(?:Illustration|Image|Picture|Figure\s+\d+|Frontispiece)\b(?:[^[\]]|\[[^[\]]*\])*\]/gi;
const PAGE_BRACKET = /\[\s*(?:Pg|Page|p\.)\s*\d+\s*\]/gi;
const PAGE_BRACE = /\{\d+\}/g;
// Emphasis: the marks must wrap word characters, so snake_case and a_b are untouched. A span may cross a line
// break inside its paragraph but not a blank line.
const UNDERSCORE_EMPHASIS = /(?<![\p{L}\p{N}_])_(?=[\p{L}\p{N}])((?:(?!\n[ \t]*\n)[^_])*?)(?<=[\p{L}\p{N}.,;:!?'"’)\]])_(?![\p{L}\p{N}_])/gu;
const EQUALS_EMPHASIS = /(?<![\p{L}\p{N}=])=(?=[\p{L}\p{N}])((?:(?!\n[ \t]*\n)[^=])*?)(?<=[\p{L}\p{N}.,;:!?'"’)\]])=(?![\p{L}\p{N}=])/gu;
// A paragraph that starts with one of these is producer or transcription credit; the paragraph is dropped.
const CREDIT_START = /^\s*(?:Produced by|E-?text prepared by|Transcribed from|This (?:e-?text|e-?book) (?:was )?(?:prepared|produced) by)\b/i;
const NOTE_HEADING = /^\s*Transcriber(?:'|’)s\s+Notes?\s*:?/i;

export function extractGutenbergText(raw: string): Extraction {
  const lines = (raw.startsWith(BOM) ? raw.slice(1) : raw).split(/\r\n|\r|\n/);
  let start = lines.findIndex((l) => START.test(l));
  if (start < 0) start = lines.findIndex((l) => START_LEGACY.test(l));
  const hasStart = start >= 0;
  let end = -1;
  for (let i = lines.length - 1; i > start; i--) {
    if (END.test(lines[i] as string)) {
      end = i;
      break;
    }
  }
  const hasEnd = end >= 0;
  // Without a start marker nothing can be trusted as the body; the validator rejects it either way.
  const body = hasStart ? lines.slice(start + 1, hasEnd ? end : lines.length) : [];
  const text = normalize(cleanBody(body));
  return { text, wordCount: text === "" ? 0 : text.trim().split(/\s+/).length, hasStart, hasEnd };
}

/** Removes the non-author text from the body lines; returns lines with blank lines where text was cut out. */
function cleanBody(lines: readonly string[]): string[] {
  let s = lines.join("\n").replace(INVISIBLE, "");
  s = cut(s, NOTE_BLOCK);
  s = cut(s, SIDENOTE);
  s = cut(s, PLACEHOLDER);
  s = cut(s, PAGE_BRACKET);
  s = cut(s, PAGE_BRACE);
  s = s.replace(UNDERSCORE_EMPHASIS, "$1").replace(EQUALS_EMPHASIS, "$1");
  return dropBlocks(s.split("\n"));
}

/**
 * Removes each match of `token` (with the horizontal whitespace around it). Where words sit on both sides of
 * the gap on one line, a single space joins them; at a line edge the gap simply goes.
 */
function cut(s: string, token: RegExp): string {
  const flags = token.flags.includes("g") ? token.flags : `${token.flags}g`;
  const re = new RegExp(`([ \\t]*)(?:${token.source})([ \\t]*)`, flags);
  return s.replace(re, (match: string, pre: string, post: string, offset: number, whole: string) => {
    const left = offset > 0 ? whole[offset - 1] : undefined;
    const right = whole[offset + match.length];
    const atEdge = left === undefined || left === "\n" || left === " " || left === "\t" || right === undefined || right === "\n";
    return !atEdge && (pre !== "" || post !== "") ? " " : "";
  });
}

/**
 * Drops credit paragraphs and transcriber's-note headings (from their first line to the next blank line), and turns
 * decorative separator rows into a blank line. Credit lines only count at the start of a paragraph.
 */
function dropBlocks(lines: readonly string[]): string[] {
  const out: string[] = [];
  let atParagraphStart = true;
  let dropping = false;
  for (const line of lines) {
    if (isSeparator(line)) {
      out.push("");
      atParagraphStart = true;
      dropping = false;
      continue;
    }
    if (line.trim() === "") {
      out.push("");
      atParagraphStart = true;
      dropping = false;
      continue;
    }
    if (dropping) continue;
    if (atParagraphStart && (CREDIT_START.test(line) || NOTE_HEADING.test(line))) {
      dropping = true;
      continue;
    }
    out.push(line);
    atParagraphStart = false;
  }
  return out;
}

/** A row of `*`, `-`, `=`, `~`, `_` or dots (spaces allowed) with at least three marks and one that is not a dot. */
function isSeparator(line: string): boolean {
  const t = line.replace(/[ \t]/g, "");
  return t.length >= 3 && /^[*\-=~_.]+$/.test(t) && /[*\-=~_]/.test(t);
}

/** Trims line ends, collapses runs of blank lines to one paragraph break, trims the whole, ends with one newline. */
function normalize(lines: readonly string[]): string {
  const out: string[] = [];
  let blank = false;
  for (const line of lines) {
    const t = line.replace(/[ \t]+$/, "");
    if (t === "") {
      blank = out.length > 0;
      continue;
    }
    if (blank) out.push("");
    blank = false;
    out.push(t);
  }
  return out.length ? `${out.join("\n")}\n` : "";
}
