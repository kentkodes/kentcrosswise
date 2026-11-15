// Result codes for the ideas page (?n=<code>). Only these fixed codes are shown, so the URL cannot inject text.
// The todos page keeps its own copy of the same small map (each feature directory owns its notices).
import { ListInputError } from "@/server/lists";
import { DbNotConfiguredError, dbErrorLabel } from "@/server/db";

export const NOTICES = {
  "idea-added": "Idea added.",
  "idea-status": "Status changed.",
  "idea-deleted": "Idea deleted.",
  "idea-empty": "Nothing to add. Write something first.",
  "idea-too-long": "That is longer than 2,000 characters. Shorten it and add it again.",
  "idea-not-found": "That idea is no longer here.",
  invalid: "That input was not valid.",
  "db-not-configured": "The database is not connected yet.",
  "db-error": "The database is unavailable right now.",
} as const;

export type NoticeCode = keyof typeof NOTICES;

export function noticeText(code: string | string[] | undefined): string | undefined {
  return typeof code === "string" && Object.hasOwn(NOTICES, code) ? NOTICES[code as NoticeCode] : undefined;
}

const SUCCESS: ReadonlySet<string> = new Set<string>(["idea-added", "idea-status", "idea-deleted"]);
export const isSuccessNotice = (code: string | string[] | undefined): boolean => typeof code === "string" && SUCCESS.has(code);

/** The notice for a failed call in an idea action. Logs only the error class and SQLSTATE, never the text. */
export function ideaFailure(err: unknown): NoticeCode {
  if (err instanceof ListInputError) {
    if (err.code === "empty") return "idea-empty";
    if (err.code === "too-long") return "idea-too-long";
    if (err.code === "not-found") return "idea-not-found";
    return "invalid";
  }
  if (err instanceof DbNotConfiguredError) return "db-not-configured";
  console.error(`[ideas] ${dbErrorLabel(err)}`);
  return "db-error";
}
