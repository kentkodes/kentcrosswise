// Fixed result codes for /connections (?n=<code>); only these texts can appear on the page.
export const CONNECTION_NOTICES = {
  disconnected: "Google disconnected.",
  "disconnect-failed": "Disconnecting did not complete. Try again.",
  "not-configured": "Google is not configured here.",
} as const;

export type ConnectionNoticeCode = keyof typeof CONNECTION_NOTICES;

export function connectionNotice(code: unknown): string | null {
  return typeof code === "string" && Object.hasOwn(CONNECTION_NOTICES, code)
    ? CONNECTION_NOTICES[code as ConnectionNoticeCode]
    : null;
}
