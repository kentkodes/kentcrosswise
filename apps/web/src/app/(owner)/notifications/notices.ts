// Fixed result codes for /notifications. Server actions return one of these codes; only these texts can appear.
export const PUSH_NOTICES = {
  saved: "Notifications are on for this device.",
  removed: "Notifications are off for this device.",
  "test-sent": "Test notification sent.",
  "test-failed": "The push service did not accept the test. Try again.",
  "no-subscription": "No device is subscribed yet. Enable notifications first.",
  invalid: "That subscription was not accepted.",
  "not-set-up": "Push is not set up here.",
  "db-unavailable": "The database is not available. Try again.",
  denied: "Notifications are blocked for this site in the browser settings.",
  "subscribe-failed": "This browser could not subscribe. Try again.",
} as const;

export type PushNoticeCode = keyof typeof PUSH_NOTICES;

export function pushNotice(code: unknown): string | null {
  return typeof code === "string" && Object.hasOwn(PUSH_NOTICES, code) ? PUSH_NOTICES[code as PushNoticeCode] : null;
}
