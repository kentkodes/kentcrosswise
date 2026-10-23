// Result codes that owner server actions put in the redirect URL (?n=<code>), and their text.
// Only these fixed codes are shown, so the URL cannot inject text into the page.
import { InputError } from "@/server/console";
import { DbNotConfiguredError, dbErrorLabel } from "@/server/db";

export const NOTICES = {
  "created-sent": "Task created and sent to the orchestrator.",
  "created-disabled": "Task created. The orchestrator queue is not configured here (preview), so nothing was sent.",
  "created-failed": "Task created, but sending it to the orchestrator failed. Use Resend on the task.",
  "resent-sent": "Sent to the orchestrator again.",
  "resent-disabled": "The orchestrator queue is not configured here (preview), so nothing was sent.",
  "resent-failed": "Sending to the orchestrator failed. Try again.",
  "resend-skipped": "Nothing to resend: the task or decision is no longer waiting for that message.",
  "flag-updated": "Switch updated.",
  "decided-sent": "Decision recorded and sent to the orchestrator.",
  "decided-disabled": "Decision recorded. The orchestrator queue is not configured here (preview), so nothing was sent.",
  "decided-failed": "Decision recorded, but sending it to the orchestrator failed. Use Resend on the decision.",
  "decided-no-task": "Decision recorded (no task to resume).",
  "already-decided": "This approval was already decided.",
  invalid: "That input was not valid.",
  "db-not-configured": "The database is not connected yet.",
  "db-error": "The database is unavailable right now.",
} as const;

export type NoticeCode = keyof typeof NOTICES;

export function noticeText(code: string | string[] | undefined): string | undefined {
  return typeof code === "string" && Object.hasOwn(NOTICES, code) ? NOTICES[code as NoticeCode] : undefined;
}

/** The notice for a failed DB call in an action (logs unexpected errors as class + SQLSTATE). */
export function failureNotice(err: unknown, where: string): NoticeCode {
  if (err instanceof DbNotConfiguredError) return "db-not-configured";
  if (err instanceof InputError) return "invalid";
  console.error(`[${where}] ${dbErrorLabel(err)}`);
  return "db-error";
}
