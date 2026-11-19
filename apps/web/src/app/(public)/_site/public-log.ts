// The public log as the browser sees it (PL5, DESIGN §4.6). Public pages may not import server code (D10), so this
// file has its own copy of the record shape served by GET /api/public/log, a strict parser that keeps only those
// fields (anything else is dropped), and the plain-words text for each step line. Pure: no React, no clock.
// PL6: each record's read-back checks and the check-list version, and the accuracy aggregates over published records.
// PL7: the dummy calendar: the link to its public Google Calendar and the stored copies of its mirrored events.

export const LOG_URL = "/api/public/log";

export const KINDS = ["crm_note", "diary", "todo", "idea", "agent_request"] as const;
export type Kind = (typeof KINDS)[number];

export const KIND_LABEL: Readonly<Record<Kind, string>> = {
  crm_note: "Contact note",
  diary: "Diary",
  todo: "Todo",
  idea: "Idea",
  agent_request: "Agent request",
};

/** One step line: the step, its hour and the step's own codes (already allowlisted by the server). */
export type LogStep = { step: string; hour: string } & Record<string, string | number | boolean>;

export const CHECKS = [
  "derived_rows",
  "usage_recorded",
  "failures_resolved",
  "link_recorded",
  "link_name",
  "calendar_recorded",
  "calendar_start",
  "mood_consistent",
  "body_matches",
] as const;
export type CheckCode = (typeof CHECKS)[number];
export type CheckResult = "pass" | "fail" | "unresolved";
export interface LogCheck {
  check: CheckCode;
  result: CheckResult;
}

export interface LogRecord {
  id: string;
  capturedHour: string;
  kind: Kind;
  text: string;
  steps: LogStep[];
  checks: LogCheck[];
  checksVersion: number | null;
}

export interface LogAccuracy {
  routes: { model: string; confirmed: number; corrected: number }[];
  links: { confirmed: number; changed: number };
  calendar: { added: number; dismissed: number };
}

export interface LogCounts {
  published: number;
  withheld: number;
  awaitingReview: number;
}

/** One event of the dummy calendar (PL7): its record's public id, the sanitized title, and hours in UTC. */
export interface LogCalendarEvent {
  recordId: string;
  title: string;
  allDay: boolean;
  start: string;
  end: string;
}

export interface LogCalendar {
  /** The dummy account's public Google Calendar; null before it is connected. */
  link: string | null;
  events: LogCalendarEvent[];
}

/** The only link the calendar may carry: Google Calendar's public page of one calendar. */
export const CALENDAR_LINK_PREFIX = "https://calendar.google.com/calendar/embed?src=";

export type PublicLog =
  | { available: true; label: string; counts: LogCounts; accuracy: LogAccuracy | null; records: LogRecord[]; calendar: LogCalendar | null }
  | { available: false; label: string; note: string };

const isKind = (v: unknown): v is Kind => typeof v === "string" && (KINDS as readonly string[]).includes(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isHour = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:00:00(\.000)?Z$/.test(v);

function parseStep(v: unknown): LogStep | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.step !== "string" || !isHour(o.hour)) return null;
  const out: LogStep = { step: o.step, hour: o.hour };
  for (const [k, x] of Object.entries(o)) {
    if (k === "step" || k === "hour") continue;
    if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") out[k] = x;
  }
  return out;
}

const RESULTS: readonly string[] = ["pass", "fail", "unresolved"];
const MODEL = /^[a-z0-9][a-z0-9.-]{0,39}$/;

function parseCheck(v: unknown): LogCheck | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.check !== "string" || !(CHECKS as readonly string[]).includes(o.check) || typeof o.result !== "string" || !RESULTS.includes(o.result)) return null;
  return { check: o.check as CheckCode, result: o.result as CheckResult };
}

/** The aggregates, or null when absent or malformed (the page then leaves them out). */
function parseAccuracy(v: unknown): LogAccuracy | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.routes) || o.calendar === null || typeof o.calendar !== "object") return null;
  const cal = o.calendar as Record<string, unknown>;
  if (!isCount(cal.added) || !isCount(cal.dismissed)) return null;
  const lk = o.links !== null && typeof o.links === "object" ? (o.links as Record<string, unknown>) : {};
  if (!isCount(lk.confirmed) || !isCount(lk.changed)) return null;
  const routes: LogAccuracy["routes"] = [];
  for (const r of o.routes as unknown[]) {
    const x = r !== null && typeof r === "object" ? (r as Record<string, unknown>) : {};
    if (typeof x.model !== "string" || !(x.model === "unknown" || MODEL.test(x.model)) || !isCount(x.confirmed) || !isCount(x.corrected)) return null;
    routes.push({ model: x.model, confirmed: x.confirmed, corrected: x.corrected });
  }
  return { routes, links: { confirmed: lk.confirmed, changed: lk.changed }, calendar: { added: cal.added, dismissed: cal.dismissed } };
}

const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// An encoded address only: letters, digits and the escapes encodeURIComponent writes for "@", "%" and "+".
const CALENDAR_SRC = /^[A-Za-z0-9._~%-]{3,600}$/;

function parseCalendarEvent(v: unknown): LogCalendarEvent | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.recordId !== "string" || !RECORD_ID.test(o.recordId)) return null;
  if (typeof o.title !== "string" || o.title.length === 0 || o.title.length > 500) return null;
  if (typeof o.allDay !== "boolean" || !isHour(o.start) || !isHour(o.end) || Date.parse(o.end) <= Date.parse(o.start)) return null;
  return { recordId: o.recordId, title: o.title, allDay: o.allDay, start: o.start, end: o.end };
}

/** The calendar, or null when absent or malformed (the page then leaves it out). Malformed events are skipped. */
function parseCalendar(v: unknown): LogCalendar | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.events)) return null;
  let link: string | null = null;
  if (typeof o.link === "string") {
    if (!o.link.startsWith(CALENDAR_LINK_PREFIX) || !CALENDAR_SRC.test(o.link.slice(CALENDAR_LINK_PREFIX.length))) return null;
    link = o.link;
  } else if (o.link !== null) return null;
  const events = o.events.map(parseCalendarEvent).filter((e): e is LogCalendarEvent => e !== null);
  return { link, events };
}

function parseRecord(v: unknown): LogRecord | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || !isHour(o.capturedHour) || !isKind(o.kind) || typeof o.text !== "string" || !Array.isArray(o.steps)) return null;
  const steps: LogStep[] = [];
  for (const s of o.steps) {
    const p = parseStep(s);
    if (!p) return null;
    steps.push(p);
  }
  const checks: LogCheck[] = [];
  if (o.checks !== undefined) {
    if (!Array.isArray(o.checks)) return null;
    for (const c of o.checks) {
      const p = parseCheck(c);
      if (!p) return null;
      checks.push(p);
    }
  }
  const version = o.checksVersion === undefined || o.checksVersion === null ? null : o.checksVersion;
  if (version !== null && !(isCount(version) && version >= 1)) return null;
  return { id: o.id, capturedHour: o.capturedHour, kind: o.kind, text: o.text, steps, checks, checksVersion: version as number | null };
}

/** The API reply, or null when it does not have the public log's shape. Malformed records are skipped. */
export function parsePublicLog(v: unknown): PublicLog | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.label !== "string") return null;
  if (o.available === false) return { available: false, label: o.label, note: typeof o.note === "string" ? o.note : "" };
  if (o.available !== true || o.counts === null || typeof o.counts !== "object" || !Array.isArray(o.records)) return null;
  const c = o.counts as Record<string, unknown>;
  if (!isCount(c.published) || !isCount(c.withheld) || !isCount(c.awaitingReview)) return null;
  const records = o.records.map(parseRecord).filter((r): r is LogRecord => r !== null);
  return {
    available: true,
    label: o.label,
    counts: { published: c.published, withheld: c.withheld, awaitingReview: c.awaitingReview },
    accuracy: parseAccuracy(o.accuracy),
    records,
    calendar: parseCalendar(o.calendar),
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** When a calendar event is: "1 Dec 2026, all day", "1 Dec 2026, 10:00-11:00 UTC", or both ends in full. */
export function eventWhen(e: Pick<LogCalendarEvent, "allDay" | "start" | "end">): string {
  const day = (iso: string) => hourLabel(iso).split(",")[0] ?? "";
  if (e.allDay) return `${day(e.start)}, all day`;
  if (day(e.start) === day(e.end)) return `${day(e.start)}, ${e.start.slice(11, 16)}-${e.end.slice(11, 16)} UTC`;
  return `${hourLabel(e.start)} to ${hourLabel(e.end)}`;
}

/** "18 Nov 2026, 14:00 UTC" (the hour is already rounded by the server). */
export function hourLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getUTCHours()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:00 UTC`;
}

const kind = (v: unknown): string => (isKind(v) ? KIND_LABEL[v] : "an unknown kind");
const lower = (v: unknown): string => kind(v).toLowerCase();

const FAILURE: Readonly<Record<string, string>> = {
  provider_error: "the model provider returned an error",
  invalid_label: "the model answered with a kind that does not exist",
  spend_cap: "the monthly spend cap was reached",
};
const LINK: Readonly<Record<string, string>> = {
  linked: "Linked the note to the contact it is about",
  ambiguous: "Found more than one matching contact, so it asked me",
  none: "Found no matching contact",
  failed: "Contact linking failed",
};
const MOOD: Readonly<Record<string, string>> = {
  scored: "Scored the entry's mood",
  cap: "Mood scoring paused: the monthly spend cap was reached",
  failed: "Mood scoring failed",
  changed: "Mood score not saved: the entry changed while it was being scored",
};
const CALENDAR: Readonly<Record<string, string>> = {
  created: "Suggested a calendar event",
  none: "Found no plan to put in the calendar",
  "no-zone": "No time zone was known, so it made no calendar suggestion",
  cap: "Calendar suggestion paused: the monthly spend cap was reached",
  invalid: "The calendar suggestion was unusable, so none was made",
  failed: "The calendar suggestion failed",
  timeout: "The calendar suggestion timed out",
};

/** A step line in plain words. Unknown steps or codes read as such; nothing from the line is shown raw. */
export function stepText(s: LogStep): string {
  switch (s.step) {
    case "captured":
      return "Captured";
    case "routed": {
      if (s.by === "owner") return `I filed it as ${lower(s.kind)}${isKind(s.guess) ? ` (the model had guessed ${lower(s.guess)})` : ""}`;
      const detail = [typeof s.confidence === "number" ? `confidence ${s.confidence.toFixed(2)}` : null, typeof s.model === "string" ? s.model : null]
        .filter(Boolean)
        .join(", ");
      return `The model filed it as ${lower(s.kind)}${detail ? ` (${detail})` : ""}`;
    }
    case "needs_owner":
      return `The model was unsure (${lower(s.kind)}${typeof s.confidence === "number" ? `, confidence ${s.confidence.toFixed(2)}` : ""}), so it asked me`;
    case "route_failed":
      return `Filing failed: ${FAILURE[String(s.code)] ?? "an unknown error"}${typeof s.attempt === "number" ? ` (attempt ${s.attempt})` : ""}`;
    case "derived":
      return isKind(s.moved_from) ? `Moved the record from ${lower(s.moved_from)} to ${lower(s.kind)}` : `Created the ${lower(s.kind)}`;
    case "contact_linked":
      return LINK[String(s.outcome)] ?? "Contact linking: unknown outcome";
    case "mood_scored":
      return MOOD[String(s.outcome)] ?? "Mood scoring: unknown outcome";
    case "calendar_suggested":
      return CALENDAR[String(s.outcome)] ?? "Calendar suggestion: unknown outcome";
    case "corrected":
      return `I corrected it from ${lower(s.from)} to ${lower(s.to)}`;
    case "confirmed":
      return "I confirmed how it was filed";
    case "contact_chosen":
      if (s.kept === true) return "I confirmed the linked contact";
      return s.linked === true ? "I chose the contact it is about" : "I marked it as about no contact";
    case "calendar_added":
      return "I added the suggested event to my calendar";
    case "calendar_dismissed":
      return "I dismissed the suggested event";
    default:
      return "An unknown step";
  }
}

/** Is this step a problem (shown as such in the evidence)? */
export function isProblem(s: LogStep): boolean {
  return (
    s.step === "route_failed" ||
    (s.step === "contact_linked" && s.outcome === "failed") ||
    (s.step === "mood_scored" && (s.outcome === "failed" || s.outcome === "cap" || s.outcome === "changed")) ||
    (s.step === "calendar_suggested" && ["cap", "invalid", "failed", "timeout"].includes(String(s.outcome)))
  );
}

/** Is this step my own action (a verdict or my choice)? */
export function isMine(s: LogStep): boolean {
  return ["corrected", "confirmed", "contact_chosen", "calendar_added", "calendar_dismissed"].includes(s.step) || (s.step === "routed" && s.by === "owner");
}

const CHECK_TEXT: Readonly<Record<CheckCode, string>> = {
  derived_rows: "The saved records match the kind",
  usage_recorded: "Every model call has a usage record",
  failures_resolved: "Every failed step was followed by a success",
  link_recorded: "The contact-link outcome was recorded",
  link_name: "The linked contact's name appears in the note",
  calendar_recorded: "The calendar outcome was recorded",
  calendar_start: "The suggested event does not start before the note was written",
  mood_consistent: "The stored mood score matches its recorded outcome",
  body_matches: "The saved text equals the entry",
};
const RESULT_TEXT: Readonly<Record<CheckResult, string>> = { pass: "Passed", fail: "Failed", unresolved: "Unresolved" };

/** A check line in plain words, e.g. "Passed: Every model call has a usage record". */
export function checkText(c: LogCheck): string {
  return `${RESULT_TEXT[c.result]}: ${CHECK_TEXT[c.check]}`;
}

/** "All 3 checks passed", "1 check failed", "A failure is unresolved", or "" when there are no checks. */
export function checksSummary(checks: readonly LogCheck[]): string {
  if (checks.length === 0) return "";
  const failed = checks.filter((c) => c.result === "fail").length;
  const unresolved = checks.filter((c) => c.result === "unresolved").length;
  const parts: string[] = [];
  if (failed > 0) parts.push(`${failed} ${failed === 1 ? "check" : "checks"} failed`);
  if (unresolved > 0) parts.push("A failure is unresolved");
  return parts.length > 0 ? parts.join(" · ") : checks.length === 1 ? "The check passed" : `All ${checks.length} checks passed`;
}

const pct = (n: number, d: number) => Math.round((n / d) * 100);

/** The aggregate lines, in plain words. */
export function accuracyLines(a: LogAccuracy): string[] {
  const lines: string[] = [];
  if (a.routes.length === 0) lines.push("Model filings confirmed: none reviewed yet");
  for (const r of a.routes) {
    const n = r.confirmed + r.corrected;
    lines.push(`Model filings confirmed: ${r.confirmed} of ${n} (${pct(r.confirmed, n)}%), ${r.model === "unknown" ? "model not recorded" : r.model}`);
  }
  const decided = a.calendar.added + a.calendar.dismissed;
  lines.push(decided === 0 ? "Calendar suggestions added: none decided yet" : `Calendar suggestions added: ${a.calendar.added} of ${decided}`);
  const judged = a.links.confirmed + a.links.changed;
  lines.push(judged === 0 ? "Contact links confirmed: none reviewed yet" : `Contact links confirmed: ${a.links.confirmed} of ${judged} (${pct(a.links.confirmed, judged)}%)`);
  return lines;
}

/** The one-line outcome of a record: how its filing was judged, and a recovery when there was one. */
export function summary(r: LogRecord): string {
  const parts: string[] = [];
  const corrected = r.steps.find((s) => s.step === "corrected");
  const byMe = r.steps.find((s) => s.step === "routed" && s.by === "owner");
  if (corrected) parts.push(`Corrected: ${kind(corrected.from)} → ${kind(corrected.to)}`);
  else if (byMe) parts.push("Filed by me");
  else if (r.steps.some((s) => s.step === "confirmed")) parts.push("Filed by the model, confirmed");
  // A recovery: filing failed at least once and a later step filed the entry after all.
  const lastFail = r.steps.map((s) => s.step).lastIndexOf("route_failed");
  if (lastFail >= 0 && r.steps.slice(lastFail + 1).some((s) => s.step === "routed")) {
    const n = r.steps.filter((s) => s.step === "route_failed").length;
    parts.push(`Recovered after ${n} failed ${n === 1 ? "attempt" : "attempts"}`);
  }
  const checks = checksSummary(r.checks);
  if (checks) parts.push(checks);
  return parts.join(" · ");
}
