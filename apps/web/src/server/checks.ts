// Read-back checks of a published record (slice PL6, DESIGN §4.6, migration 0028). Owner decision 2026-11-17 (PH4):
// deterministic pass/fail facts read back from stored state after the steps, never a model judge. A check must be
// able to fail on a bug, a provider misbehaving or a lost write; a check that does not apply to a record is left out.
// The list is versioned: a record stores the version it was checked against, so a change to the list shows.
//
// The results are fixed codes only ({check, result}); nothing here returns text, ids, names or values. Runs as web_rw
// inside publishEntry's transaction.
import { localParts, validTimeZone, ymd } from "./calendar";
import type { CheckCode, PublicCheck } from "./check-codes";
import { containsWord } from "./contacts";
import type { Queryable } from "./db";
import type { StepRow } from "./steps";

export { CHECK_CODES, CHECK_RESULTS, CHECKS_VERSION, type CheckCode, type CheckResult, type PublicCheck } from "./check-codes";

type Kind = "crm_note" | "diary" | "todo" | "idea" | "agent_request";
const TABLES = { crm_note: "crm_notes", diary: "diary_entries", todo: "todos", idea: "ideas" } as const;

/** Everything the checks read back, gathered once per publication. */
export interface CheckFacts {
  kind: Kind;
  rawText: string;
  createdAt: Date;
  timeZone: string | null;
  steps: Pick<StepRow, "step" | "detail">[];
  /** Rows per derived table that point at the entry. */
  derived: Record<keyof typeof TABLES, number>;
  /** The body of the todo or idea row (when exactly one). */
  body: string | null;
  /** The CRM note: its body, link status and the linked contact's names (name and aliases). */
  note: { body: string; linkStatus: string; names: string[] } | null;
  /** The note's calendar suggestion. */
  suggestion: { startAt: Date; allDay: boolean; timeZone: string | null } | null;
  /** Whether the diary row has a stored mood score. */
  moodRow: boolean;
  /** Completed usage records (outcome other than "started") per purpose, for this entry's subjects. */
  usage: Record<string, number>;
}

const failedRoute = (s: CheckFacts["steps"][number]) => s.step === "route_failed";
const outcome = (s: CheckFacts["steps"][number]) => String(s.detail.outcome);
const MOOD_FAIL = ["failed", "cap", "changed"];
const CALENDAR_FAIL = ["cap", "failed", "timeout", "invalid"];

/** Which purposes the steps prove a model call for (a reply came back, or the provider was reached). */
function calledPurposes(steps: CheckFacts["steps"]): Set<string> {
  const out = new Set<string>();
  for (const s of steps) {
    if ((s.step === "routed" && s.detail.by === "model") || s.step === "needs_owner") out.add("route");
    if (s.step === "route_failed" && (s.detail.code === "provider_error" || s.detail.code === "invalid_label")) out.add("route");
    if (s.step === "mood_scored" && (outcome(s) === "scored" || outcome(s) === "changed")) out.add("mood");
    if (s.step === "calendar_suggested" && ["created", "none", "invalid"].includes(outcome(s))) out.add("calendar");
  }
  return out;
}

/** True when every failure in the steps is followed later by a success of the same step. Null: no failure. */
function failuresResolved(steps: CheckFacts["steps"]): boolean | null {
  let any = false;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    const later = steps.slice(i + 1);
    let resolved: boolean | null = null;
    if (failedRoute(s)) resolved = later.some((x) => x.step === "routed");
    else if (s.step === "mood_scored" && MOOD_FAIL.includes(outcome(s))) resolved = later.some((x) => x.step === "mood_scored" && outcome(x) === "scored");
    else if (s.step === "calendar_suggested" && CALENDAR_FAIL.includes(outcome(s)))
      resolved = later.some((x) => x.step === "calendar_suggested" && (outcome(x) === "created" || outcome(x) === "none"));
    if (resolved === null) continue;
    any = true;
    if (!resolved) return false;
  }
  return any ? true : null;
}

/** The local date of an instant in a zone (UTC when the zone is unknown). */
const localDate = (at: Date, zone: string | null) => ymd(localParts(at, validTimeZone(zone) ?? "UTC"));

/** The check list, evaluated on facts already read back. Pure. */
export function evaluateChecks(f: CheckFacts): PublicCheck[] {
  const out: PublicCheck[] = [];
  const add = (check: CheckCode, ok: boolean) => out.push({ check, result: ok ? "pass" : "fail" });

  // all kinds
  const expected = f.kind === "agent_request" ? null : f.kind;
  add("derived_rows", (Object.keys(TABLES) as (keyof typeof TABLES)[]).every((k) => f.derived[k] === (k === expected ? 1 : 0)));
  const purposes = calledPurposes(f.steps);
  if (purposes.size > 0) add("usage_recorded", [...purposes].every((p) => (f.usage[p] ?? 0) > 0));
  const resolved = failuresResolved(f.steps);
  if (resolved !== null) out.push({ check: "failures_resolved", result: resolved ? "pass" : "unresolved" });

  if (f.kind === "crm_note") {
    add("link_recorded", f.steps.some((s) => s.step === "contact_linked"));
    // The name check is about the automatic link: left out once the owner chose another contact or none.
    const chosen = f.steps.some((s) => s.step === "contact_chosen" && s.detail.kept !== true);
    if (f.note && f.note.linkStatus === "linked" && !chosen) add("link_name", f.note.names.some((n) => n.trim() !== "" && containsWord(f.note!.body, n)));
    add("calendar_recorded", f.steps.some((s) => s.step === "calendar_suggested"));
    if (f.suggestion) {
      const s = f.suggestion;
      add(
        "calendar_start",
        s.allDay ? localDate(s.startAt, s.timeZone ?? f.timeZone) >= localDate(f.createdAt, f.timeZone) : s.startAt.getTime() >= f.createdAt.getTime(),
      );
    }
  }

  if (f.kind === "diary") {
    const last = [...f.steps].reverse().find((s) => s.step === "mood_scored");
    const lastOutcome = last ? outcome(last) : null;
    add("mood_consistent", f.moodRow ? lastOutcome === "scored" : lastOutcome !== null && MOOD_FAIL.includes(lastOutcome));
  }

  // A row moved from a diary entry carries the diary's body, which the owner may have edited: not comparable.
  const fromDiary = f.steps.some((s) => s.step === "derived" && s.detail.moved_from === "diary");
  if ((f.kind === "todo" || f.kind === "idea") && !fromDiary) add("body_matches", f.body !== null && f.body === f.rawText);

  return out;
}

/** Reads back the facts for one entry (in the caller's transaction). Null when the entry is gone. */
export async function loadCheckFacts(db: Queryable, entryId: string, steps: StepRow[]): Promise<CheckFacts | null> {
  const e = (await db.query<{ raw_text: string; route_kind: Kind | null; created_at: Date | string; time_zone: string | null }>(
    "SELECT raw_text, route_kind, created_at, time_zone FROM entries WHERE id = $1",
    [entryId],
  )).rows[0];
  if (!e || e.route_kind === null) return null;

  const derived = { crm_note: 0, diary: 0, todo: 0, idea: 0 };
  for (const k of Object.keys(TABLES) as (keyof typeof TABLES)[]) {
    derived[k] = Number((await db.query<{ n: string | number }>(`SELECT count(*) AS n FROM ${TABLES[k]} WHERE entry_id = $1`, [entryId])).rows[0]?.n ?? 0);
  }

  let body: string | null = null;
  if (e.route_kind === "todo" || e.route_kind === "idea") {
    const rows = (await db.query<{ body: string }>(`SELECT body FROM ${TABLES[e.route_kind]} WHERE entry_id = $1`, [entryId])).rows;
    body = rows.length === 1 ? rows[0]!.body : null;
  }

  let note: CheckFacts["note"] = null;
  let suggestion: CheckFacts["suggestion"] = null;
  let noteId: string | null = null;
  if (e.route_kind === "crm_note") {
    const n = (await db.query<{ id: string; body: string; link_status: string; name: string | null; aliases: string[] | null }>(
      `SELECT n.id, n.body, n.link_status, c.name, c.aliases FROM crm_notes n LEFT JOIN contacts c ON c.id = n.contact_id
        WHERE n.entry_id = $1 ORDER BY n.created_at LIMIT 1`,
      [entryId],
    )).rows[0];
    if (n) {
      noteId = n.id;
      note = { body: n.body, linkStatus: n.link_status, names: n.name === null ? [] : [n.name, ...(n.aliases ?? [])] };
      const s = (await db.query<{ start_at: Date | string; all_day: boolean; time_zone: string | null }>(
        "SELECT start_at, all_day, time_zone FROM calendar_suggestions WHERE crm_note_id = $1",
        [n.id],
      )).rows[0];
      if (s) suggestion = { startAt: new Date(s.start_at), allDay: s.all_day, timeZone: s.time_zone };
    }
  }

  let moodRow = false;
  let diaryId: string | null = null;
  if (e.route_kind === "diary") {
    const d = (await db.query<{ id: string; scored: boolean }>(
      `SELECT d.id, EXISTS (SELECT 1 FROM mood_scores m WHERE m.diary_entry_id = d.id) AS scored
         FROM diary_entries d WHERE d.entry_id = $1 ORDER BY d.written_at LIMIT 1`,
      [entryId],
    )).rows[0];
    if (d) {
      diaryId = d.id;
      moodRow = d.scored;
    }
  }

  // Completed call records (AR3) of this entry's subjects: routing on the entry, mood on its diary row, calendar on
  // its note. A row still "started" is not completed. Rows of an earlier note or diary row (moved away) don't count.
  const usage: Record<string, number> = {};
  const subjects: [string, string, string | null][] = [
    ["route", "entry", entryId],
    ["mood", "diary_entry", diaryId],
    ["calendar", "crm_note", noteId],
  ];
  for (const [purpose, kind, id] of subjects) {
    if (id === null) continue;
    usage[purpose] = Number((await db.query<{ n: string | number }>(
      "SELECT count(*) AS n FROM usage_events WHERE purpose = $1 AND subject_kind = $2 AND subject_id = $3 AND outcome <> 'started'",
      [purpose, kind, id],
    )).rows[0]?.n ?? 0);
  }

  return {
    kind: e.route_kind,
    rawText: e.raw_text,
    createdAt: new Date(e.created_at),
    timeZone: e.time_zone,
    steps: steps.map((s) => ({ step: s.step, detail: s.detail })),
    derived,
    body,
    note,
    suggestion,
    moodRow,
    usage,
  };
}

/** The checks of one entry; empty when the entry is gone. */
export async function runChecks(db: Queryable, entryId: string, steps: StepRow[]): Promise<PublicCheck[]> {
  const facts = await loadCheckFacts(db, entryId, steps);
  return facts ? evaluateChecks(facts) : [];
}
