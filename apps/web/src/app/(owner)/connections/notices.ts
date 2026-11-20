// Fixed result codes for /connections (?n=<code>); only these texts can appear on the page.
export const CONNECTION_NOTICES = {
  disconnected: "Google disconnected.",
  "disconnect-failed": "Disconnecting did not complete. Try again.",
  "not-configured": "Google is not configured here.",
  // The demo calendar (PL7).
  "demo-connected": "Demo calendar connected. Its events are in sync with the published records.",
  "demo-denied": "The demo calendar consent was cancelled.",
  "demo-bad-state": "That consent did not start here or has expired. Start again with Connect demo calendar.",
  "demo-owner-account": "That was your own Google account. The demo calendar needs the separate dummy account; nothing was stored.",
  "demo-unverified": "Google did not confirm that account's address. Nothing was stored.",
  "demo-no-calendar": "Calendar access was not granted. Connect again and approve it.",
  "demo-no-token": "Google returned no lasting access. Connect again.",
  "demo-not-configured": "The demo calendar is not configured here.",
  "demo-failed": "Connecting the demo calendar did not complete. Try again.",
  "demo-disconnected": "Demo calendar disconnected. Its events stay in the public calendar until you reconnect and sync.",
  "demo-disconnect-failed": "Disconnecting the demo calendar did not complete. Try again.",
  "demo-synced": "Demo calendar in sync.",
  "demo-sync-failed": "Some demo calendar changes did not go through. Try Sync now again.",
  "demo-reconnect": "The demo calendar is not connected. Connect it, then sync.",
} as const;

export type ConnectionNoticeCode = keyof typeof CONNECTION_NOTICES;

/** Codes shown as a success; the rest are warnings. */
export const OK_NOTICES: readonly ConnectionNoticeCode[] = ["disconnected", "demo-connected", "demo-disconnected", "demo-synced"];

export function connectionNotice(code: unknown): string | null {
  return typeof code === "string" && Object.hasOwn(CONNECTION_NOTICES, code)
    ? CONNECTION_NOTICES[code as ConnectionNoticeCode]
    : null;
}
