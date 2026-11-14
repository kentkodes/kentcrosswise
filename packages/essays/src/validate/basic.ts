/**
 * Validator for an extracted Gutenberg text. Pure; returns fixed reason codes only (never text).
 * v1 checks (kept unchanged): start and end markers, license residue, bad characters, HTML tags, minimum words.
 * v2 adds the duplicate checks in validate/duplicates.ts (exact, near, metadata); the store phase runs them
 * against the stored essays and reports "near_duplicate" and "metadata_duplicate" here.
 * No language heuristic and no upper length limit: the owner hand-picks books, the catalog says `en`.
 */
import type { Extraction } from "../extract/gutenberg-text";

export const VALIDATOR_VERSION = "2";
export const MIN_WORDS = 300;

export type ReasonCode =
  | "missing_start_marker"
  | "missing_end_marker"
  | "license_residue"
  | "bad_characters"
  | "html_tags"
  | "too_short"
  | "near_duplicate"
  | "metadata_duplicate";

// Phrases of the Project Gutenberg license block and its trademark notices; the markers cut these away.
const LICENSE_RESIDUE = [
  /Project Gutenberg(?:™|-tm|\(tm\))?\s+License/i,
  /General Terms of Use and Redistributing/i,
  /Full Project Gutenberg(?:™|-tm|\(tm\))?\s+License/i,
  /www\.gutenberg\.org\/license/i,
  /\*{3}\s*(?:START|END) OF (?:THE|THIS) PROJECT GUTENBERG/i,
];
// Control characters except tab and newline (the extractor leaves only those), and U+FFFD (built with fromCharCode).
const BAD_CHARS = new RegExp("[\u0000-\u0008\u000B-\u001F\u007F-\u009F" + String.fromCharCode(0xfffd) + "]");
// Known HTML element names only, so "a<b and c>d" in prose is not mistaken for markup.
const HTML_TAG = /<\/?(?:html|head|body|div|span|p|br|hr|a|i|b|u|em|strong|small|sup|sub|h[1-6]|img|ul|ol|li|table|tr|td|th|font|center|blockquote|pre|script|style|meta|link)(?:\s+[a-z-]+\s*=[^<>]*)?\s*\/?>/i;

export function validateExtraction(x: Extraction): { ok: true } | { ok: false; reasons: ReasonCode[] } {
  const reasons: ReasonCode[] = [];
  if (!x.hasStart) reasons.push("missing_start_marker");
  if (!x.hasEnd) reasons.push("missing_end_marker");
  if (LICENSE_RESIDUE.some((re) => re.test(x.text))) reasons.push("license_residue");
  if (BAD_CHARS.test(x.text)) reasons.push("bad_characters");
  if (HTML_TAG.test(x.text)) reasons.push("html_tags");
  if (x.hasStart && x.wordCount < MIN_WORDS) reasons.push("too_short");
  return reasons.length ? { ok: false, reasons } : { ok: true };
}
