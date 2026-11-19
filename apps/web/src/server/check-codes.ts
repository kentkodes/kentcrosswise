// The codes of the read-back check list (PL6, DESIGN §4.6): shared by the writer (checks.ts, publish.ts) and the
// public reader (public-log.ts), which rebuilds every check line from these sets. No imports, so the public API route
// stays free of the owner-side modules.

/** The version of the check list below. Raise it whenever a check in checks.ts is added, removed or changes meaning. */
export const CHECKS_VERSION = 1;

export const CHECK_CODES = [
  "derived_rows", // the entry has exactly the derived row its kind makes (none for agent_request)
  "usage_recorded", // each kind of model call the steps show has a completed usage record
  "failures_resolved", // every failed step was followed by a success (else "unresolved")
  "link_recorded", // crm_note: the contact-link outcome was recorded
  "link_name", // crm_note linked automatically: the contact's name or an alias appears in the note
  "calendar_recorded", // crm_note: the calendar outcome was recorded
  "calendar_start", // crm_note with a suggestion: it does not start before the capture
  "mood_consistent", // diary: a stored score matches a "scored" outcome, or no score has a recorded reason
  "body_matches", // todo, idea: the saved text equals the entry text
] as const;
export type CheckCode = (typeof CHECK_CODES)[number];
export const CHECK_RESULTS = ["pass", "fail", "unresolved"] as const;
export type CheckResult = (typeof CHECK_RESULTS)[number];
export type PublicCheck = { check: CheckCode; result: CheckResult };
