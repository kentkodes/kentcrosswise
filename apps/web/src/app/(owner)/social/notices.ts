// Result codes that the social actions put in the redirect URL (?n=<code>), and their text. Only these
// fixed codes are shown, so the URL cannot inject text into the page.
import { DbNotConfiguredError, dbErrorLabel } from "@/server/db";
import { SocialInputError } from "@/server/social";

export const NOTICES = {
  "account-added": "Account added. Enter its numbers below.",
  "account-deleted": "Account deleted, with its snapshots.",
  "snapshot-saved": "Numbers saved for that day.",
  platform: "Choose YouTube, Instagram or TikTok.",
  handle:
    "A handle is 1 to 64 letters, digits, dots, dashes or underscores (no spaces or accents). A leading @ is removed, and case does not matter.",
  duplicate: "That account is already on the dashboard.",
  account: "That account is no longer here.",
  day: "Choose a real day from 2000 onwards that is not in the future (UTC).",
  followers: "Followers must be a whole number, zero or more, or left empty.",
  views: "Views must be a whole number, zero or more, or left empty.",
  empty: "Enter followers or views, or both, for that day.",
  ingest: "Choose manual entry or the daily job (API).",
  "api-tiktok": "TikTok numbers are typed in by hand.",
  "api-taken-youtube": "The daily job already reads another YouTube account.",
  "api-taken-instagram": "The daily job already reads another Instagram account.",
  "db-not-configured": "The database is not connected yet.",
  "db-error": "The database is unavailable right now.",
} as const;

export type NoticeCode = keyof typeof NOTICES;

const SUCCESS: ReadonlySet<string> = new Set<string>(["account-added", "account-deleted", "snapshot-saved"]);

export function noticeText(code: string | string[] | undefined): string | undefined {
  return typeof code === "string" && Object.hasOwn(NOTICES, code) ? NOTICES[code as NoticeCode] : undefined;
}

export const isSuccessNotice = (code: string | string[] | undefined): boolean => typeof code === "string" && SUCCESS.has(code);

/** The notice for a failed call: input codes pass through, anything unexpected logs its class and SQLSTATE only. */
export function noticeFor(err: unknown): NoticeCode {
  if (err instanceof SocialInputError) return err.code;
  if (err instanceof DbNotConfiguredError) return "db-not-configured";
  console.error(`[social] ${dbErrorLabel(err)}`);
  return "db-error";
}
