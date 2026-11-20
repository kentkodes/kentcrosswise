// The dummy calendar of the public log (PL7, DESIGN §4.6 "Calendar", migration 0029). Runs as web_rw.
// Mirrors the calendar suggestions the owner added (status 'added') from contact notes whose record is published into
// the primary calendar of the dummy Google account (server/google.ts demoGoogle), never the owner's:
//   - the title goes through the record's redactor (review.ts publicField); a title that cannot be made safe is not
//     mirrored;
//   - times are rounded down to the hour in UTC (an all-day event stays all-day, on its date in the suggestion's zone),
//     and events are written in UTC, so the public calendar shows no zone;
//   - the Google event id is derived from the suggestion id (a hash, so the private id is not public), and a repeat
//     is a no-op: an insert that meets an existing id (409, also a deleted one) is written over instead.
// A stored copy of each mirrored event (demo_calendar_events) is what the public log lists, so visitors cause no Google
// call. The sync compares what should be mirrored with the stored copies and only calls Google for the difference:
// deletes for records no longer published (withheld, deleted, or the suggestion gone), inserts and updates for the
// rest. It runs after each publication (publish.ts publishNow, one entry) and in full after a consent or from
// "Sync now" on /connections. It never throws; logs carry codes and error classes only.
import { createHash } from "node:crypto";
import { localParts, validTimeZone, ymd } from "./calendar";
import type { Queryable } from "./db";
import { withDb } from "./db";
import { demoGoogle, GOOGLE_TIMEOUT_MS } from "./google";
import { GOOGLE_DEMO_TOKEN_SECRET_ENV } from "../auth/google-consent";
import { contactNames, publicField, type PublicInputs } from "./review";

const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export type DemoRun = <T>(fn: (db: Queryable) => Promise<T>) => Promise<T>;
const defaultRun: DemoRun = (fn) => withDb("web_rw", fn);

/** Fixed outcome codes (stored in demo_calendar.last_sync_outcome when a sync had work to do). */
export type SyncOutcome = "synced" | "nothing" | "not-configured" | "not-connected" | "reconnect" | "failed";

/** The event as stored and as Google holds it. Times are ISO strings in UTC, on the hour. */
export interface DemoEvent {
  suggestionId: string;
  entryId: string;
  eventId: string;
  title: string;
  allDay: boolean;
  start: string;
  end: string;
}

/** The Google event id: 32 hex characters of a hash of the suggestion id (hex is within Google's base32hex alphabet). */
export function demoEventId(suggestionId: string): string {
  return createHash("sha256").update(`kcw-demo-event:${suggestionId.toLowerCase()}`).digest("hex").slice(0, 32);
}

/**
 * Rounded times: a timed event starts and ends on the hour below (in UTC) and lasts at least an hour; an all-day
 * event covers its date in the suggestion's zone, from midnight UTC to the next.
 */
export function roundedTimes(s: { startAt: Date; endAt: Date | null; allDay: boolean; timeZone: string | null }): { start: string; end: string } {
  if (s.allDay) {
    const day = ymd(localParts(s.startAt, validTimeZone(s.timeZone) ?? "UTC"));
    const start = Date.parse(`${day}T00:00:00Z`);
    return { start: new Date(start).toISOString(), end: new Date(start + DAY_MS).toISOString() };
  }
  const floor = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS;
  const start = floor(s.startAt.getTime());
  const endRaw = floor((s.endAt ?? new Date(s.startAt.getTime() + HOUR_MS)).getTime());
  const end = endRaw > start ? endRaw : start + HOUR_MS;
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

/** The Calendar API body: UTC times (no zone of the owner's), the all-day date as is. */
export function demoEventBody(e: DemoEvent): Record<string, unknown> {
  const when = (iso: string) => (e.allDay ? { date: iso.slice(0, 10) } : { dateTime: iso.replace(".000Z", "Z"), timeZone: "UTC" });
  return { id: e.eventId, summary: e.title, start: when(e.start), end: when(e.end), status: "confirmed" };
}

type SuggestionRow = {
  id: string;
  entry_id: string;
  title: string;
  start_at: Date | string;
  end_at: Date | string | null;
  all_day: boolean;
  time_zone: string | null;
  raw_text: string;
} & PublicInputs;

/** What should be mirrored: added suggestions of contact notes whose record is published (one entry, or all). */
export async function desiredEvents(db: Queryable, entryId: string | null): Promise<DemoEvent[]> {
  const { rows } = await db.query<SuggestionRow>(
    `SELECT s.id, r.entry_id, s.title, s.start_at, s.end_at, s.all_day, s.time_zone, e.raw_text,
            p.spans_state, p.people, p.places, p.private_other, p.owner_people, p.owner_places
       FROM public_records r
       JOIN entries e ON e.id = r.entry_id
       JOIN entry_public p ON p.entry_id = r.entry_id
       JOIN crm_notes n ON n.entry_id = r.entry_id
       JOIN calendar_suggestions s ON s.crm_note_id = n.id AND s.status = 'added'
      WHERE r.state = 'published' AND r.kind = 'crm_note' AND ($1::uuid IS NULL OR r.entry_id = $1::uuid)
      ORDER BY s.id`,
    [entryId],
  );
  if (rows.length === 0) return [];
  const contacts = await contactNames(db);
  const out: DemoEvent[] = [];
  for (const r of rows) {
    const title = publicField(r.raw_text, r, contacts, r.title);
    if (title === null || title.trim() === "" || title.length > 500) continue;
    const times = roundedTimes({
      startAt: new Date(r.start_at),
      endAt: r.end_at === null ? null : new Date(r.end_at),
      allDay: r.all_day,
      timeZone: r.time_zone,
    });
    out.push({ suggestionId: r.id, entryId: r.entry_id, eventId: demoEventId(r.id), title, allDay: r.all_day, ...times });
  }
  return out;
}

/** The stored copies (one entry, or all). */
export async function mirroredEvents(db: Queryable, entryId: string | null): Promise<DemoEvent[]> {
  const { rows } = await db.query<{
    suggestion_id: string;
    entry_id: string;
    event_id: string;
    title: string;
    all_day: boolean;
    start_at: Date | string;
    end_at: Date | string;
  }>(
    `SELECT suggestion_id, entry_id, event_id, title, all_day, start_at, end_at FROM demo_calendar_events
      WHERE ($1::uuid IS NULL OR entry_id = $1::uuid) ORDER BY suggestion_id`,
    [entryId],
  );
  return rows.map((r) => ({
    suggestionId: r.suggestion_id,
    entryId: r.entry_id,
    eventId: r.event_id,
    title: r.title,
    allDay: r.all_day,
    start: new Date(r.start_at).toISOString(),
    end: new Date(r.end_at).toISOString(),
  }));
}

const same = (a: DemoEvent, b: DemoEvent) =>
  a.eventId === b.eventId && a.title === b.title && a.allDay === b.allDay && a.start === b.start && a.end === b.end && a.entryId === b.entryId;

/** The calls a sync needs: events to remove, and events to write (new or changed). */
export function planSync(desired: readonly DemoEvent[], mirrored: readonly DemoEvent[]): { remove: DemoEvent[]; write: { event: DemoEvent; exists: boolean }[] } {
  const want = new Map(desired.map((e) => [e.suggestionId, e]));
  const have = new Map(mirrored.map((e) => [e.suggestionId, e]));
  return {
    remove: mirrored.filter((e) => !want.has(e.suggestionId)),
    write: desired.filter((e) => !have.has(e.suggestionId) || !same(e, have.get(e.suggestionId)!)).map((event) => ({ event, exists: have.has(event.suggestionId) })),
  };
}

export interface SyncDeps {
  fetch?: typeof fetch;
  /** Default: the dummy account's access token. */
  accessToken?: () => Promise<string | null>;
  run?: DemoRun;
}

type CallResult = "ok" | "missing" | "conflict" | "unauthorized" | "failed";

async function call(f: typeof fetch, token: string, method: string, url: string, body?: unknown): Promise<CallResult> {
  let status: number;
  try {
    const res = await f(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
    status = res.status;
  } catch (err) {
    console.error(`[demo-calendar] ${method.toLowerCase()}-${err instanceof Error ? err.name : "error"}`);
    return "failed";
  }
  if (status >= 200 && status < 300) return "ok";
  if (status === 404 || status === 410) return "missing";
  if (status === 409) return "conflict";
  if (status === 401) return "unauthorized";
  console.error(`[demo-calendar] ${method.toLowerCase()}-${status}`);
  return "failed";
}

/** Writes an event: an insert, or an update; each falls back to the other (a deleted id still exists at Google). */
async function writeEvent(f: typeof fetch, token: string, e: DemoEvent, exists: boolean): Promise<CallResult> {
  const body = demoEventBody(e);
  const put = () => call(f, token, "PUT", `${EVENTS_URL}/${e.eventId}`, body);
  const insert = () => call(f, token, "POST", EVENTS_URL, body);
  if (exists) {
    const r = await put();
    return r === "missing" ? insert() : r;
  }
  const r = await insert();
  return r === "conflict" ? put() : r;
}

const configured = () => Boolean(process.env[GOOGLE_DEMO_TOKEN_SECRET_ENV]);

/**
 * Brings the dummy calendar in line with the published records: one entry (after its publication) or all of them
 * (entryId null). Calls Google only for what differs from the stored copies. Records the outcome when there was work.
 */
export async function syncDemoCalendar(entryId: string | null, deps: SyncDeps = {}): Promise<SyncOutcome> {
  if (!deps.accessToken && !configured()) return "not-configured";
  const run = deps.run ?? defaultRun;
  try {
    const plan = await run(async (db) => planSync(await desiredEvents(db, entryId), await mirroredEvents(db, entryId)));
    if (plan.remove.length === 0 && plan.write.length === 0) return "nothing";
    const outcome = await apply(plan, run, deps);
    await run((db) => recordOutcome(db, outcome));
    return outcome;
  } catch (err) {
    console.error(`[demo-calendar] sync-${err instanceof Error ? err.name : "error"}`);
    return "failed";
  }
}

async function apply(plan: ReturnType<typeof planSync>, run: DemoRun, deps: SyncDeps): Promise<SyncOutcome> {
  let token: string | null;
  try {
    token = await (deps.accessToken ?? (() => demoGoogle.accessToken("calendar")))();
  } catch (err) {
    console.error(`[demo-calendar] token-${err instanceof Error ? err.name : "error"}`);
    return "failed";
  }
  if (!token) return "not-connected";
  const f = deps.fetch ?? fetch;
  let failed = false;
  for (const e of plan.remove) {
    const r = await call(f, token, "DELETE", `${EVENTS_URL}/${e.eventId}`);
    if (r === "unauthorized") return reconnect();
    if (r === "ok" || r === "missing") {
      await run((db) => db.query("DELETE FROM demo_calendar_events WHERE suggestion_id = $1", [e.suggestionId]));
    } else failed = true;
  }
  for (const { event: e, exists } of plan.write) {
    const r = await writeEvent(f, token, e, exists);
    if (r === "unauthorized") return reconnect();
    if (r !== "ok") {
      failed = true;
      continue;
    }
    await run((db) =>
      db.query(
        `INSERT INTO demo_calendar_events (suggestion_id, entry_id, event_id, title, all_day, start_at, end_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (suggestion_id) DO UPDATE SET entry_id = EXCLUDED.entry_id, event_id = EXCLUDED.event_id,
           title = EXCLUDED.title, all_day = EXCLUDED.all_day, start_at = EXCLUDED.start_at, end_at = EXCLUDED.end_at,
           mirrored_at = now()`,
        [e.suggestionId, e.entryId, e.eventId, e.title, e.allDay, e.start, e.end],
      ),
    );
  }
  return failed ? "failed" : "synced";
}

function reconnect(): SyncOutcome {
  console.error("[demo-calendar] 401");
  demoGoogle.resetCache();
  return "reconnect";
}

async function recordOutcome(db: Queryable, outcome: SyncOutcome): Promise<void> {
  await db.query(
    `INSERT INTO demo_calendar (id, last_sync_at, last_sync_outcome) VALUES (true, now(), $1)
     ON CONFLICT (id) DO UPDATE SET last_sync_at = EXCLUDED.last_sync_at, last_sync_outcome = EXCLUDED.last_sync_outcome`,
    [outcome],
  );
}

/**
 * Stores the dummy calendar's id after a consent. A different account than before: the stored copies belong to the
 * other calendar (whose token is gone), so they are dropped and the next full sync writes everything again.
 */
export async function saveDemoCalendarId(db: Queryable, calendarId: string): Promise<void> {
  const { rows } = await db.query<{ calendar_id: string | null }>("SELECT calendar_id FROM demo_calendar WHERE id FOR UPDATE");
  const before = rows[0]?.calendar_id ?? null;
  if (before !== null && before.toLowerCase() !== calendarId.toLowerCase()) await db.query("DELETE FROM demo_calendar_events");
  await db.query(
    `INSERT INTO demo_calendar (id, calendar_id) VALUES (true, $1) ON CONFLICT (id) DO UPDATE SET calendar_id = EXCLUDED.calendar_id`,
    [calendarId],
  );
}

export interface DemoCalendarStatus {
  calendarId: string | null;
  mirrored: number;
  lastSyncAt: string | null;
  lastSyncOutcome: SyncOutcome | null;
}

const OUTCOMES: readonly SyncOutcome[] = ["synced", "nothing", "not-configured", "not-connected", "reconnect", "failed"];

/** What /connections shows about the dummy calendar. */
export async function demoCalendarStatus(db: Queryable): Promise<DemoCalendarStatus> {
  const { rows } = await db.query<{ calendar_id: string | null; last_sync_at: Date | string | null; last_sync_outcome: string | null; mirrored: number | string }>(
    `SELECT c.calendar_id, c.last_sync_at, c.last_sync_outcome, (SELECT count(*) FROM demo_calendar_events) AS mirrored
       FROM (SELECT true AS id) one LEFT JOIN demo_calendar c ON c.id`,
  );
  const r = rows[0];
  const outcome = r?.last_sync_outcome ?? null;
  return {
    calendarId: r?.calendar_id ?? null,
    mirrored: Number(r?.mirrored ?? 0),
    lastSyncAt: r?.last_sync_at ? new Date(r.last_sync_at).toISOString() : null,
    lastSyncOutcome: OUTCOMES.includes(outcome as SyncOutcome) ? (outcome as SyncOutcome) : null,
  };
}
