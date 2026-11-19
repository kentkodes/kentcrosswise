// The public log (slice PL4, DESIGN §4.6, migration 0027): the shape of a published record, the step-line builder
// shared by the writer (publish.ts, web_rw) and the reader (here, web_public), and the reader itself.
// Owner decision 2026-11-18: a record shows its kind, its sanitized text, the hour it was captured, and step lines
// made of fixed codes only (route label, model confidence and model name, failure codes and attempt numbers, the
// contact-link, calendar and mood outcomes without values, corrections from and to, the owner's verdicts). Never mood
// values, calendar titles, contact names or internal ids. Every field of a step line is rebuilt from an allowlist of
// codes and bounded numbers, at write time and again at read time, so nothing else can pass through.
// PL6: each record also carries its read-back checks ({check, result} codes, rebuilt from CHECK_CODES) and the
// check-list version, and the log carries accuracy aggregates computed from the published records' own step lines
// only (owner decision 2026-11-19), so a visitor can recount them from the records.
import { ROUTER_STEPS, type RouterStep } from "@kcw/core/events";
import { CHECK_CODES, CHECK_RESULTS, type PublicCheck } from "./check-codes";
import { DbNotConfiguredError, dbErrorLabel, withDb, type Queryable } from "./db";

const KINDS = ["crm_note", "diary", "todo", "idea", "agent_request"] as const;
const ROUTE_ERRORS = ["provider_error", "invalid_label", "spend_cap"] as const;
const LINK_OUTCOMES = ["linked", "ambiguous", "none", "failed"] as const;
const MOOD_OUTCOMES = ["scored", "cap", "failed", "changed"] as const;
const CALENDAR_OUTCOMES = ["created", "none", "no-zone", "cap", "invalid", "failed", "timeout"] as const;
const MODEL = /^[a-z0-9][a-z0-9.-]{0,39}$/;

export const LOG_LABEL = "Tasks published automatically after sanitization; some records withheld for privacy/security";
export const LOG_LIMIT = 50;

/** One public step line: the step, its hour (rounded) and only the allowlisted fields of that step. */
export type PublicStep = { step: RouterStep; hour: string } & Record<string, string | number | boolean>;

export interface PublicRecord {
  id: string;
  capturedHour: string;
  kind: (typeof KINDS)[number];
  text: string;
  steps: PublicStep[];
  checks: PublicCheck[];
  checksVersion: number | null;
}

/** Route accuracy per model (records the model filed that the owner confirmed or corrected) and calendar acceptance. */
export interface PublicAccuracy {
  routes: { model: string; confirmed: number; corrected: number }[];
  calendar: { added: number; dismissed: number };
}

export interface PublicLogCounts {
  published: number;
  withheld: number;
  awaitingReview: number;
}

export type PublicLog =
  | { available: true; label: string; counts: PublicLogCounts; accuracy: PublicAccuracy; records: PublicRecord[] }
  | { available: false; label: string; note: string; diag?: string };

/** The only fields a record may have, in order. */
export const PUBLIC_RECORD_FIELDS = ["id", "capturedHour", "kind", "text", "steps", "checks", "checksVersion"] as const;

const oneOf = <T extends string>(set: readonly T[], v: unknown): v is T => typeof v === "string" && (set as readonly string[]).includes(v);

/** Rounds a time down to the hour (ISO string), or null when it is not a valid time. */
export function toHour(ts: unknown): string | null {
  const d = ts instanceof Date ? new Date(ts.getTime()) : typeof ts === "string" ? new Date(ts) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

/**
 * The public step line for one stored step (`detail` is the private detail, or a stored public line). Returns null
 * when the step or a required field is not one of the allowed values: the caller withholds the record.
 */
export function publicStep(step: unknown, ts: unknown, detail: unknown): PublicStep | null {
  if (!oneOf(ROUTER_STEPS, step)) return null;
  const hour = toHour(ts);
  if (!hour) return null;
  const d = detail !== null && typeof detail === "object" ? (detail as Record<string, unknown>) : {};
  const out: PublicStep = { step, hour };
  const kind = (key: string, required = true): boolean => {
    if (oneOf(KINDS, d[key])) out[key] = d[key];
    else if (required) return false;
    return true;
  };
  const outcome = (set: readonly string[]): boolean => {
    if (!oneOf(set, d.outcome)) return false;
    out.outcome = d.outcome;
    return true;
  };
  const model = () => {
    if (typeof d.model === "string" && MODEL.test(d.model)) out.model = d.model;
  };
  const confidence = () => {
    if (typeof d.confidence === "number" && d.confidence >= 0 && d.confidence <= 1) out.confidence = Math.round(d.confidence * 100) / 100;
  };
  switch (step) {
    case "captured":
    case "calendar_added":
    case "calendar_dismissed":
      return out;
    case "routed":
      if (!kind("kind") || (d.by !== "model" && d.by !== "owner")) return null;
      out.by = d.by;
      if (d.by === "model") {
        confidence();
        model();
      } else kind("guess", false);
      return out;
    case "needs_owner":
      if (!kind("kind")) return null;
      confidence();
      model();
      return out;
    case "route_failed":
      if (!oneOf(ROUTE_ERRORS, d.code) || !Number.isInteger(d.attempt) || (d.attempt as number) < 1 || (d.attempt as number) > 1000) return null;
      out.code = d.code;
      out.attempt = d.attempt as number;
      return out;
    case "derived":
      if (!kind("kind")) return null;
      kind("moved_from", false);
      return out;
    case "contact_linked":
      return outcome(LINK_OUTCOMES) ? out : null;
    case "mood_scored":
      return outcome(MOOD_OUTCOMES) ? out : null;
    case "calendar_suggested":
      return outcome(CALENDAR_OUTCOMES) ? out : null;
    case "corrected":
      return kind("from") && kind("to") ? out : null;
    case "confirmed":
      return kind("kind") ? out : null;
    case "contact_chosen":
      if (typeof d.linked !== "boolean") return null;
      out.linked = d.linked;
      return out;
  }
}

/** One check line rebuilt from the allowlist, or null when it is not one. */
export function publicCheck(v: unknown): PublicCheck | null {
  const o = v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return oneOf(CHECK_CODES, o.check) && oneOf(CHECK_RESULTS, o.result) ? { check: o.check, result: o.result } : null;
}

/** Every stored step line rebuilt, or null when one is malformed. */
function rebuildSteps(v: unknown): PublicStep[] | null {
  if (!Array.isArray(v)) return null;
  const steps: PublicStep[] = [];
  for (const s of v as unknown[]) {
    const o = s !== null && typeof s === "object" ? (s as Record<string, unknown>) : {};
    const line = publicStep(o.step, o.hour, o);
    if (!line) return null;
    steps.push(line);
  }
  return steps;
}

/**
 * The aggregates over published records' step lines. Route accuracy: a record counts once, under the model of its
 * first model route, by the owner's last verdict after it (confirmed or corrected); records without one are not
 * counted. Calendar: a record's last added or dismissed verdict.
 */
export function accuracyOf(records: readonly PublicStep[][]): PublicAccuracy {
  const routes = new Map<string, { confirmed: number; corrected: number }>();
  const calendar = { added: 0, dismissed: 0 };
  for (const steps of records) {
    const first = steps.findIndex((s) => s.step === "routed" && s.by === "model");
    if (first >= 0) {
      const verdict = steps
        .slice(first + 1)
        .filter((s) => s.step === "confirmed" || s.step === "corrected")
        .pop();
      if (verdict) {
        const m = typeof steps[first]!.model === "string" ? String(steps[first]!.model) : "unknown";
        const row = routes.get(m) ?? { confirmed: 0, corrected: 0 };
        row[verdict.step === "confirmed" ? "confirmed" : "corrected"]++;
        routes.set(m, row);
      }
    }
    const cal = steps.filter((s) => s.step === "calendar_added" || s.step === "calendar_dismissed").pop();
    if (cal) calendar[cal.step === "calendar_added" ? "added" : "dismissed"]++;
  }
  return {
    routes: [...routes].map(([model, n]) => ({ model, ...n })).sort((a, b) => a.model.localeCompare(b.model)),
    calendar,
  };
}

interface RecordRow {
  public_id: string;
  captured_hour: Date | string;
  kind: string;
  body: string;
  steps: unknown;
  checks: unknown;
  checks_version: number | string | null;
}

/** The newest published records (at most LOG_LIMIT), each rebuilt field by field; a malformed row is skipped. */
export async function queryPublicLog(db: Queryable): Promise<{ counts: PublicLogCounts; accuracy: PublicAccuracy; records: PublicRecord[] }> {
  const { rows } = await db.query<RecordRow>(
    "SELECT public_id, captured_hour, kind, body, steps, checks, checks_version FROM v_public_records ORDER BY captured_hour DESC, public_id LIMIT $1",
    [LOG_LIMIT],
  );
  const c = (await db.query<{ published: string | number; withheld: string | number; awaiting_review: string | number }>(
    "SELECT published, withheld, awaiting_review FROM v_public_log_counts",
  )).rows[0];
  const records: PublicRecord[] = [];
  for (const r of rows) {
    const hour = toHour(r.captured_hour);
    if (!hour || !oneOf(KINDS, r.kind) || typeof r.body !== "string") continue;
    const steps = rebuildSteps(r.steps);
    if (!steps || !Array.isArray(r.checks)) continue;
    const checks = (r.checks as unknown[]).map(publicCheck);
    if (checks.some((c) => c === null)) continue;
    const version = r.checks_version === null ? null : Number(r.checks_version);
    if (version !== null && !(Number.isInteger(version) && version >= 1 && version <= 1000)) continue;
    records.push({ id: String(r.public_id), capturedHour: hour, kind: r.kind, text: r.body, steps, checks: checks as PublicCheck[], checksVersion: version });
  }
  // The aggregates count every published record (not only the newest LOG_LIMIT), from their step lines only.
  const all = (await db.query<{ steps: unknown }>("SELECT steps FROM v_public_records")).rows
    .map((r) => rebuildSteps(r.steps))
    .filter((x): x is PublicStep[] => x !== null);
  return {
    counts: {
      published: Number(c?.published ?? 0),
      withheld: Number(c?.withheld ?? 0),
      awaitingReview: Number(c?.awaiting_review ?? 0),
    },
    accuracy: accuracyOf(all),
    records,
  };
}

export const LOG_NOT_CONFIGURED = "The public log is not connected yet.";
export const LOG_UNAVAILABLE = "The public log is unavailable right now.";

/** The public log through web_public, or a note when there is no database or it fails (preview adds `diag`). */
export async function loadPublicLog(
  run: <T>(fn: (db: Queryable) => Promise<T>) => Promise<T> = (fn) => withDb("web_public", fn, { readOnly: true }),
  preview: boolean = process.env.KCW_ENV === "preview",
): Promise<PublicLog> {
  try {
    return { available: true, label: LOG_LABEL, ...(await run((db) => queryPublicLog(db))) };
  } catch (err) {
    if (err instanceof DbNotConfiguredError) return { available: false, label: LOG_LABEL, note: LOG_NOT_CONFIGURED };
    const diag = dbErrorLabel(err);
    console.error(`[public-log] ${diag}`);
    return { available: false, label: LOG_LABEL, note: LOG_UNAVAILABLE, ...(preview ? { diag } : {}) };
  }
}
