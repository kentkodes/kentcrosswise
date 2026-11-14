// Result codes that owner server actions put in the redirect URL (?n=<code>), and their text.
// Only these fixed codes are shown, so the URL cannot inject text into the page.
import type { RouteKind } from "@/server/capture";
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
  captured: "Saved",
  "captured-routed-crm_note": "Saved and routed to CRM note",
  "captured-routed-diary": "Saved and routed to Diary",
  "captured-routed-todo": "Saved and routed to Todo",
  "captured-routed-idea": "Saved and routed to Idea",
  "captured-routed-agent_request": "Saved and routed to Agent request",
  "captured-needs-owner": "Saved. Needs you: check the inbox",
  "captured-route-failed": "Saved. Routing failed; use Route again",
  "captured-route-capped": "Saved. Routing paused: monthly spend cap reached",
  "routed-crm_note": "Routed to CRM note.",
  "routed-diary": "Routed to Diary.",
  "routed-todo": "Routed to Todo.",
  "routed-idea": "Routed to Idea.",
  "routed-agent_request": "Routed to Agent request.",
  "routed-needs-owner": "Needs you: check the inbox.",
  "route-already": "That entry is already routed.",
  "route-capped": "Routing paused: monthly spend cap reached.",
  "route-failed": "Routing failed. Try again.",
  "route-off": "Routing is not set up here (preview), so nothing was sent.",
  "entry-not-found": "That entry is no longer here.",
  "capture-empty": "Nothing to save. Write something first.",
  "capture-too-long": "That is longer than 10,000 characters. Shorten it and save again.",
  "prefs-saved": "Essay preferences saved.",
  rated: "Rating saved.",
  "essay-not-found": "That essay is not in the library.",
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

/** The notice after a capture that routed to a kind, and after a route or reassignment to a kind. */
export const CAPTURED_ROUTED: Record<RouteKind, NoticeCode> = {
  crm_note: "captured-routed-crm_note",
  diary: "captured-routed-diary",
  todo: "captured-routed-todo",
  idea: "captured-routed-idea",
  agent_request: "captured-routed-agent_request",
};
export const ROUTED: Record<RouteKind, NoticeCode> = {
  crm_note: "routed-crm_note",
  diary: "routed-diary",
  todo: "routed-todo",
  idea: "routed-idea",
  agent_request: "routed-agent_request",
};

/** Notices that report success (status role, ok dot). Everything else is a warning (alert role, warn dot). */
const SUCCESS: ReadonlySet<string> = new Set<string>([
  "captured",
  ...Object.values(CAPTURED_ROUTED),
  ...Object.values(ROUTED),
]);
export const isSuccessNotice = (code: string | string[] | undefined): boolean => typeof code === "string" && SUCCESS.has(code);

/** The notice for a failed DB call in an action (logs unexpected errors as class + SQLSTATE). */
export function failureNotice(err: unknown, where: string): NoticeCode {
  if (err instanceof DbNotConfiguredError) return "db-not-configured";
  if (err instanceof InputError) return "invalid";
  console.error(`[${where}] ${dbErrorLabel(err)}`);
  return "db-error";
}
