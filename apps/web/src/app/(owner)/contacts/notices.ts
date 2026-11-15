// Notice codes for the contacts pages (?n=<code>). Only these fixed texts are shown, never contact or note text.
import { DbNotConfiguredError, dbErrorLabel } from "@/server/db";

export const CONTACT_NOTICES = {
  created: "Contact added.",
  saved: "Contact saved.",
  deleted: "Contact deleted.",
  "name-required": "A contact needs a name.",
  "too-long": "One of the fields is too long. Shorten it and save again.",
  "bad-birthday": "That birthday is not a valid date.",
  "not-found": "That contact is no longer here.",
  "note-linked": "Note linked.",
  "note-unlinked": "Note set to no contact.",
  "note-not-found": "That note is no longer here.",
  invalid: "That input was not valid.",
  "db-not-configured": "The database is not connected yet.",
  "db-error": "The database is unavailable right now.",
} as const;

export type ContactNoticeCode = keyof typeof CONTACT_NOTICES;

const SUCCESS: ReadonlySet<string> = new Set(["created", "saved", "deleted", "note-linked", "note-unlinked"]);

export function contactNotice(code: string | string[] | undefined): { text: string; ok: boolean } | undefined {
  if (typeof code !== "string" || !Object.hasOwn(CONTACT_NOTICES, code)) return undefined;
  return { text: CONTACT_NOTICES[code as ContactNoticeCode], ok: SUCCESS.has(code) };
}

/** The notice for a failed DB call in an action (logs the error class and SQLSTATE only). */
export function contactFailure(err: unknown): ContactNoticeCode {
  if (err instanceof DbNotConfiguredError) return "db-not-configured";
  console.error(`[contacts] ${dbErrorLabel(err)}`);
  return "db-error";
}
