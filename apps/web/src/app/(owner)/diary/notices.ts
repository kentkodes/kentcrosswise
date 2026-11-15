// Diary notices: fixed codes that the diary actions put in the redirect URL (?n=<code>). Only these texts are
// ever shown. Imports nothing with an "@/" alias, so tests can load it.
import type { ScoreOutcome } from "../../../server/mood";

export const DIARY_NOTICES = {
  saved: "Saved.",
  "saved-scored": "Saved. Mood scored.",
  "saved-score-failed": "Saved. Mood scoring failed; use Score again.",
  "saved-score-capped": "Saved. Mood scoring paused: monthly spend cap reached.",
  "saved-score-off": "Saved. Mood scoring is not set up here.",
  deleted: "Entry deleted.",
  "score-failed": "Mood scoring failed. Try again.",
  "score-capped": "Mood scoring paused: monthly spend cap reached.",
  "score-off": "Mood scoring is not set up here.",
  "score-changed": "The entry changed while it was scored. Score again.",
  "not-found": "That entry is no longer here.",
  empty: "Nothing to save. Write something first.",
  "too-long": "That is longer than 50,000 characters. Shorten it and save again.",
  invalid: "That input was not valid.",
  "db-not-configured": "The database is not connected yet.",
  "db-error": "The database is unavailable right now.",
} as const;

export type DiaryNoticeCode = keyof typeof DIARY_NOTICES;

export function diaryNoticeText(code: string | string[] | undefined): string | undefined {
  return typeof code === "string" && Object.hasOwn(DIARY_NOTICES, code) ? DIARY_NOTICES[code as DiaryNoticeCode] : undefined;
}

/** Notices that report success; everything else is a warning (alert role). */
const OK: ReadonlySet<string> = new Set(["saved", "saved-scored", "saved-score-off", "deleted"]);
export const isDiarySuccess = (code: string | string[] | undefined): boolean => typeof code === "string" && OK.has(code);

export type ScoreResult = ScoreOutcome | "off";

/** The notice after a save or an edit (the entry is stored whatever the score did). */
export function savedNotice(r: ScoreResult | "none"): DiaryNoticeCode {
  switch (r) {
    case "scored":
      return "saved-scored";
    case "cap":
      return "saved-score-capped";
    case "off":
      return "saved-score-off";
    case "none":
      return "saved";
    default:
      return "saved-score-failed";
  }
}

/** The notice after "Score again". */
export function scoreNotice(r: ScoreResult): DiaryNoticeCode {
  switch (r) {
    case "scored":
      return "saved-scored";
    case "cap":
      return "score-capped";
    case "off":
      return "score-off";
    case "changed":
      return "score-changed";
    case "not-found":
    case "gone":
      return "not-found";
    default:
      return "score-failed";
  }
}
