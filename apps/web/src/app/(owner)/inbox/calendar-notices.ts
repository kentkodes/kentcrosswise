// Notice codes for the calendar region (?cn=<code> on /inbox). Only these fixed texts are shown, never note text.
export const CALENDAR_NOTICES = {
  added: "Added to Google Calendar.",
  already: "That suggestion was already handled.",
  dismissed: "Suggestion dismissed.",
  "not-found": "That suggestion is no longer here.",
  "not-connected": "Google Calendar is not connected. Connect it first.",
  reconnect: "Google rejected the connection. Reconnect Google, then add it again.",
  failed: "Google Calendar did not accept it. Try again.",
  invalid: "That input was not valid.",
  "db-error": "The database is unavailable right now.",
} as const;

export type CalendarNoticeCode = keyof typeof CALENDAR_NOTICES;

const SUCCESS: ReadonlySet<string> = new Set(["added", "dismissed"]);

export function calendarNotice(code: string | string[] | undefined): { text: string; ok: boolean } | undefined {
  if (typeof code !== "string" || !Object.hasOwn(CALENDAR_NOTICES, code)) return undefined;
  return { text: CALENDAR_NOTICES[code as CalendarNoticeCode], ok: SUCCESS.has(code) };
}
