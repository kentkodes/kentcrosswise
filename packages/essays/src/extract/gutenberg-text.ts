/**
 * Extractor `gutenberg-txt` v1: the plain-text edition of a Project Gutenberg ebook. Pure; no I/O.
 * Finds the START and END marker lines (modern and legacy wording), drops everything outside them
 * (header, footer, license), strips a BOM, normalizes line endings and keeps paragraph breaks.
 */
export const EXTRACTOR_ID = "gutenberg-txt";
export const EXTRACTOR_VERSION = "1";

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

const BOM = "﻿";

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
  const text = normalize(body);
  return { text, wordCount: text === "" ? 0 : text.trim().split(/\s+/).length, hasStart, hasEnd };
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
