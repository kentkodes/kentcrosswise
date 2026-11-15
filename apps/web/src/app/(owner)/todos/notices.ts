// Result codes for the todo and idea pages (?n=<code>). Only these fixed codes are shown, so the URL cannot
// inject text. The ideas page keeps its own copy of the same small map (each feature directory owns its notices).
import { ListInputError } from "@/server/lists";
import { DbNotConfiguredError, dbErrorLabel } from "@/server/db";

export const NOTICES = {
  "todo-added": "Todo added.",
  "todo-done": "Marked done.",
  "todo-open": "Marked open again.",
  "todo-deleted": "Todo deleted.",
  "todo-empty": "Nothing to add. Write something first.",
  "todo-too-long": "That is longer than 2,000 characters. Shorten it and add it again.",
  "todo-not-found": "That todo is no longer here.",
  invalid: "That input was not valid.",
  "db-not-configured": "The database is not connected yet.",
  "db-error": "The database is unavailable right now.",
} as const;

export type NoticeCode = keyof typeof NOTICES;

export function noticeText(code: string | string[] | undefined): string | undefined {
  return typeof code === "string" && Object.hasOwn(NOTICES, code) ? NOTICES[code as NoticeCode] : undefined;
}

/** Success notices get the status role and ok dot; the rest are warnings. */
const SUCCESS: ReadonlySet<string> = new Set<string>(["todo-added", "todo-done", "todo-open", "todo-deleted"]);
export const isSuccessNotice = (code: string | string[] | undefined): boolean => typeof code === "string" && SUCCESS.has(code);

/** The notice for a failed call in a todo action. Logs only the error class and SQLSTATE, never the text. */
export function todoFailure(err: unknown): NoticeCode {
  if (err instanceof ListInputError) {
    if (err.code === "empty") return "todo-empty";
    if (err.code === "too-long") return "todo-too-long";
    if (err.code === "not-found") return "todo-not-found";
    return "invalid";
  }
  if (err instanceof DbNotConfiguredError) return "db-not-configured";
  console.error(`[todos] ${dbErrorLabel(err)}`);
  return "db-error";
}
