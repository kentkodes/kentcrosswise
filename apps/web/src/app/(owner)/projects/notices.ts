// Result codes for the projects page (?n=<code>). Only these fixed codes are shown, so the URL cannot inject text.
import { ProjectInputError } from "@/server/projects";
import { DbNotConfiguredError, dbErrorLabel } from "@/server/db";

export const NOTICES = {
  "project-added": "Project added.",
  "project-renamed": "Project renamed.",
  "project-moved": "Project order saved.",
  "project-deleted": "Project deleted.",
  "project-empty": "Write a title first.",
  "project-too-long": "That title is longer than 80 characters. Shorten it and try again.",
  "project-no-slug": "A title needs at least one letter or digit.",
  "project-slug-taken": "A project with that name already exists.",
  "project-protected": "The Essays project cannot be renamed or deleted.",
  "project-not-found": "That project is no longer here.",
  invalid: "That input was not valid.",
  "db-not-configured": "The database is not connected yet.",
  "db-error": "The database is unavailable right now.",
} as const;

export type NoticeCode = keyof typeof NOTICES;

export function noticeText(code: string | string[] | undefined): string | undefined {
  return typeof code === "string" && Object.hasOwn(NOTICES, code) ? NOTICES[code as NoticeCode] : undefined;
}

const SUCCESS: ReadonlySet<string> = new Set<string>(["project-added", "project-renamed", "project-moved", "project-deleted"]);
export const isSuccessNotice = (code: string | string[] | undefined): boolean => typeof code === "string" && SUCCESS.has(code);

const CODE_NOTICE: Record<string, NoticeCode> = {
  empty: "project-empty",
  "too-long": "project-too-long",
  "no-slug": "project-no-slug",
  "slug-taken": "project-slug-taken",
  protected: "project-protected",
  "not-found": "project-not-found",
  "invalid-direction": "invalid",
  "invalid-slug": "invalid",
};

/** The notice for a failed call in a project action. Logs only the error class and SQLSTATE, never the title. */
export function projectFailure(err: unknown): NoticeCode {
  if (err instanceof ProjectInputError) return CODE_NOTICE[err.code] ?? "invalid";
  if (err instanceof DbNotConfiguredError) return "db-not-configured";
  console.error(`[projects] ${dbErrorLabel(err)}`);
  return "db-error";
}
