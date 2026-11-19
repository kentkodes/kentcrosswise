// The public log as the browser sees it (PL5, DESIGN §4.6). Public pages may not import server code (D10), so this
// file has its own copy of the record shape served by GET /api/public/log, a strict parser that keeps only those
// fields (anything else is dropped), and the plain-words text for each step line. Pure: no React, no clock.

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

export interface LogRecord {
  id: string;
  capturedHour: string;
  kind: Kind;
  text: string;
  steps: LogStep[];
}

export interface LogCounts {
  published: number;
  withheld: number;
  awaitingReview: number;
}

export type PublicLog =
  | { available: true; label: string; counts: LogCounts; records: LogRecord[] }
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
  return { id: o.id, capturedHour: o.capturedHour, kind: o.kind, text: o.text, steps };
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
  return { available: true, label: o.label, counts: { published: c.published, withheld: c.withheld, awaitingReview: c.awaitingReview }, records };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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
  return parts.join(" · ");
}
