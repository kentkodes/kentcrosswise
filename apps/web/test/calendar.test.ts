// H5 calendar suggestions: time zones, strict reply validation, one suggestion per note, the model-call guards,
// Add (idempotent, 409, 401), Dismiss and the delete trigger. PGlite, FakeProvider and an injected fetch only.
import type { PGlite } from "@electric-sql/pglite";
import { FakeProvider } from "@kcw/core/models";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  addSuggestionToCalendar,
  calendarInstructions,
  dismissSuggestion,
  eventBody,
  eventIdFor,
  listPendingSuggestions,
  parseCalendarReply,
  suggestFromNote,
  validTimeZone,
  zonedToUtc,
} from "../src/server/calendar";
import { saveEntry } from "../src/server/capture";
import { runAs } from "../src/server/db";
import { routeEntry, routerFromEnv, type DbRun } from "../src/server/router";
import { freshDb, pglitePool } from "./pglite";

// Sunday 2026-11-15 10:00 in New York (EST).
const NOW = new Date("2026-11-15T15:00:00Z");
const NY = "America/New_York";
const plan = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ plan: true, title: "Lunch with Sam", date: "2026-11-20", time: "12:30", duration_minutes: 45, ...o });

describe("validTimeZone", () => {
  it("accepts IANA names and rejects junk, empty, non-strings and over 64 characters", () => {
    expect(validTimeZone(NY)).toBe(NY);
    expect(validTimeZone("UTC")).toBe("UTC");
    expect(validTimeZone("Mars/Olympus")).toBeNull();
    expect(validTimeZone("")).toBeNull();
    expect(validTimeZone(5)).toBeNull();
    expect(validTimeZone(null)).toBeNull();
    expect(validTimeZone("A".repeat(65))).toBeNull();
  });
});

describe("zonedToUtc", () => {
  it.each([
    ["New York summer", "2026-07-04", "12:00", NY, "2026-07-04T16:00:00.000Z"],
    ["New York winter", "2026-12-04", "15:00", NY, "2026-12-04T20:00:00.000Z"],
    ["New York gap (02:30 does not exist) moves an hour on", "2026-03-08", "02:30", NY, "2026-03-08T07:30:00.000Z"],
    ["New York overlap takes the first 01:30", "2026-11-01", "01:30", NY, "2026-11-01T05:30:00.000Z"],
    ["London gap", "2026-03-29", "01:30", "Europe/London", "2026-03-29T01:30:00.000Z"],
    ["London overlap takes the first 01:30", "2026-10-25", "01:30", "Europe/London", "2026-10-25T00:30:00.000Z"],
    ["London winter", "2026-12-04", "09:00", "Europe/London", "2026-12-04T09:00:00.000Z"],
    ["UTC", "2026-12-04", "23:59", "UTC", "2026-12-04T23:59:00.000Z"],
    ["Kolkata +05:30", "2026-12-04", "10:00", "Asia/Kolkata", "2026-12-04T04:30:00.000Z"],
    ["midnight", "2026-12-04", "00:00", NY, "2026-12-04T05:00:00.000Z"],
  ])("%s", (_n, date, time, zone, iso) => {
    expect(zonedToUtc(date, time, zone).toISOString()).toBe(iso);
  });
});

describe("parseCalendarReply", () => {
  it("accepts a timed plan: the instant is the zone's local time, the end follows the duration", () => {
    const r = parseCalendarReply(plan(), NOW, NY);
    expect(r.ok && r.plan).toMatchObject({ title: "Lunch with Sam", allDay: false });
    if (r.ok) {
      expect(r.plan.startAt.toISOString()).toBe("2026-11-20T17:30:00.000Z");
      expect(r.plan.endAt?.toISOString()).toBe("2026-11-20T18:15:00.000Z");
    }
  });

  it("accepts an all-day plan (time null) and defaults the duration to 60", () => {
    const allDay = parseCalendarReply(plan({ time: null, duration_minutes: null }), NOW, NY);
    expect(allDay.ok && allDay.plan.allDay).toBe(true);
    const dflt = parseCalendarReply(plan({ duration_minutes: null }), NOW, NY);
    expect(dflt.ok && dflt.plan.endAt!.getTime() - dflt.plan.startAt.getTime()).toBe(3600000);
  });

  it("accepts today and today + 365 days, and trims the title", () => {
    expect(parseCalendarReply(plan({ date: "2026-11-15" }), NOW, NY).ok).toBe(true);
    expect(parseCalendarReply(plan({ date: "2027-11-15", title: "  Trip  " }), NOW, NY).ok).toBe(true);
  });

  it("reads 'today' in the entry's zone, not UTC", () => {
    const lateNy = new Date("2026-11-16T03:00:00Z"); // still the 15th in New York
    expect(parseCalendarReply(plan({ date: "2026-11-15", time: null }), lateNy, NY).ok).toBe(true);
    expect(parseCalendarReply(plan({ date: "2026-11-15", time: null }), lateNy, "UTC")).toMatchObject({ ok: false, reason: "past" });
  });

  it("rejects a time that has already passed today, in the entry's zone", () => {
    // NOW is 10:00 in New York.
    expect(parseCalendarReply(plan({ date: "2026-11-15", time: "09:59" }), NOW, NY)).toMatchObject({ ok: false, reason: "past" });
    expect(parseCalendarReply(plan({ date: "2026-11-15", time: "10:00" }), NOW, NY).ok).toBe(true);
    expect(parseCalendarReply(plan({ date: "2026-11-15", time: null }), NOW, NY).ok).toBe(true);
    expect(parseCalendarReply(plan({ date: "2026-11-16", time: "00:05" }), NOW, NY).ok).toBe(true);
  });

  it("turns control and format characters in the title into single spaces", () => {
    const odd = parseCalendarReply(plan({ title: "Lunch" + String.fromCharCode(10, 0) + "with" + String.fromCharCode(0x202e) + "Sam" }), NOW, NY);
    expect(odd.ok && odd.plan.title).toBe("Lunch with Sam");
    expect(parseCalendarReply(plan({ title: String.fromCharCode(0x200b, 9) }), NOW, NY)).toMatchObject({ ok: false, reason: "title" });
  });

  const bad: [string, string, string][] = [
    ["plan false", plan({ plan: false }), "none"],
    ["plan not boolean", plan({ plan: "true" }), "fields"],
    ["prose", "No plan here.", "not-json"],
    ["broken json", '{"plan": true,', "not-json"],
    ["an array", "[1]", "not-json"],
    ["a missing field", JSON.stringify({ plan: true, title: "x", date: "2026-11-20", time: null }), "fields"],
    ["an extra field", plan({ note: 1 }), "fields"],
    ["an empty title", plan({ title: "  " }), "title"],
    ["an oversized title", plan({ title: "x".repeat(81) }), "title"],
    ["a non-string title", plan({ title: 5 }), "title"],
    ["a past date", plan({ date: "2026-11-14" }), "past"],
    ["a date beyond a year", plan({ date: "2027-11-16" }), "date"],
    ["an impossible date", plan({ date: "2026-02-30" }), "date"],
    ["a malformed date", plan({ date: "11/20/2026" }), "date"],
    ["a bad time", plan({ time: "24:00" }), "time"],
    ["a time without leading zero", plan({ time: "9:00" }), "time"],
    ["a duration under 15", plan({ duration_minutes: 10 }), "duration"],
    ["a duration over 480", plan({ duration_minutes: 481 }), "duration"],
    ["a fractional duration", plan({ duration_minutes: 30.5 }), "duration"],
    ["a string duration", plan({ duration_minutes: "30" }), "duration"],
  ];
  it.each(bad)("rejects %s", (_n, text, reason) => {
    expect(parseCalendarReply(text, NOW, NY)).toEqual({ ok: false, reason });
  });

  it("reads only the first object of a reply with text around it", () => {
    expect(parseCalendarReply(`Sure:\n${plan()}\nDone`, NOW, NY).ok).toBe(true);
  });

  it("gives the model now, the weekday and the zone", () => {
    const s = calendarInstructions(NOW, NY);
    expect(s).toContain("2026-11-15T10:00 (Sunday)");
    expect(s).toContain(NY);
  });
});

describe("eventBody and eventIdFor", () => {
  const id = "8f14e45f-ceea-4671-9d3f-0b1f5c1e2a3b";
  it("uses the uuid without dashes as the event id", () => {
    expect(eventIdFor(id)).toBe("8f14e45fceea46719d3f0b1f5c1e2a3b");
  });
  it("sends local wall time plus the zone for a timed event", () => {
    expect(eventBody({ id, title: "T", startAt: "2026-11-20T17:30:00.000Z", endAt: "2026-11-20T18:15:00.000Z", allDay: false, timeZone: NY })).toEqual({
      id: eventIdFor(id),
      summary: "T",
      start: { dateTime: "2026-11-20T12:30:00", timeZone: NY },
      end: { dateTime: "2026-11-20T13:15:00", timeZone: NY },
    });
  });
  it("sends dates for an all-day event, ending the next day", () => {
    expect(eventBody({ id, title: "T", startAt: "2026-12-31T05:00:00.000Z", endAt: null, allDay: true, timeZone: NY })).toMatchObject({
      start: { date: "2026-12-31" },
      end: { date: "2027-01-01" },
    });
  });
});

describe("suggestions in the database", () => {
  let pg: PGlite;
  const run: DbRun = (fn) => runAs(pglitePool(pg), "web_rw", fn);
  const q = <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => pg.query<R>(sql, params);
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

  beforeAll(async () => {
    pg = await freshDb();
  });
  afterAll(async () => {
    await pg.close();
  });
  afterEach(() => log.mockClear());

  /** An entry (with a zone unless null) and the CRM note it became. */
  async function note(body = "Lunch with Sam on Friday", zone: string | null = NY): Promise<string> {
    const entryId = await run((db) => saveEntry(db, body));
    if (zone) await q("UPDATE entries SET time_zone = $2 WHERE id = $1", [entryId, zone]);
    return (await q<{ id: string }>("INSERT INTO crm_notes (entry_id, body) VALUES ($1, $2) RETURNING id", [entryId, body])).rows[0]!.id;
  }
  const provider = (text: string, stop?: "max_tokens") => new FakeProvider({ complete: { text, ...(stop ? { stop } : {}) } });
  const count = async (sql: string, params: unknown[] = []) => Number((await q<{ n: number | string }>(sql, params)).rows[0]!.n);
  const suggestions = (noteId: string) => count("SELECT count(*) AS n FROM calendar_suggestions WHERE crm_note_id = $1", [noteId]);
  const openItems = (noteId: string) =>
    count(
      `SELECT count(*) AS n FROM inbox_items i JOIN calendar_suggestions c ON c.id::text = i.ref_id
        WHERE c.crm_note_id = $1 AND i.kind = 'calendar' AND i.status = 'open'`,
      [noteId],
    );

  it("stores one suggestion and one inbox item for a valid reply, and sends only the note as the prompt", async () => {
    const id = await note("Lunch with Sam on Friday");
    const p = provider(plan());
    await expect(suggestFromNote(run, id, p, NOW)).resolves.toBe("created");
    // The note is the whole prompt; the call is tagged with its purpose and the note's id (AR3), nothing else.
    expect(p.calls).toEqual([
      { op: "complete", input: "Lunch with Sam on Friday", tag: { purpose: "calendar", subject: { kind: "crm_note", id } } },
    ]);
    const row = (await q<{ title: string; start_at: Date; end_at: Date; all_day: boolean; time_zone: string; status: string }>(
      "SELECT title, start_at, end_at, all_day, time_zone, status FROM calendar_suggestions WHERE crm_note_id = $1",
      [id],
    )).rows[0]!;
    expect(row).toMatchObject({ title: "Lunch with Sam", all_day: false, time_zone: NY, status: "pending" });
    expect(new Date(row.start_at).toISOString()).toBe("2026-11-20T17:30:00.000Z");
    expect((await q<{ title: string }>("SELECT title FROM inbox_items WHERE kind = 'calendar' AND ref_id IN (SELECT id::text FROM calendar_suggestions WHERE crm_note_id = $1)", [id])).rows[0]!.title).toBe(
      "Calendar: Lunch with Sam",
    );
  });

  it("stores an all-day suggestion", async () => {
    const id = await note();
    await expect(suggestFromNote(run, id, provider(plan({ time: null, duration_minutes: null })), NOW)).resolves.toBe("created");
    expect(await count("SELECT count(*) AS n FROM calendar_suggestions WHERE crm_note_id = $1 AND all_day AND end_at IS NULL", [id])).toBe(1);
  });

  it("running twice (or a repeat route) leaves one suggestion and one open item, and the second run does not call the model", async () => {
    const id = await note();
    await suggestFromNote(run, id, provider(plan()), NOW);
    const second = provider(plan({ title: "Other" }));
    await expect(suggestFromNote(run, id, second, NOW)).resolves.toBe("exists");
    expect(second.calls).toHaveLength(0);
    expect(await suggestions(id)).toBe(1);
    expect(await openItems(id)).toBe(1);
  });

  it("the insert itself is conflict-safe: a suggestion made during the model call is kept", async () => {
    const id = await note();
    const racing = new FakeProvider({
      complete: async () => {
        await q("INSERT INTO calendar_suggestions (crm_note_id, title, start_at) VALUES ($1, 'First', now())", [id]);
        return { text: plan() };
      },
    });
    await expect(suggestFromNote(run, id, racing, NOW)).resolves.toBe("exists");
    expect(await suggestions(id)).toBe(1);
  });

  const none: [string, string, string?][] = [
    ["plan false", plan({ plan: false })],
    ["malformed JSON", "{nope"],
    ["a past date", plan({ date: "2026-11-01" })],
    ["an oversized title", plan({ title: "t".repeat(81) })],
    ["stop max_tokens", plan(), "max_tokens"],
  ];
  it.each(none)("%s makes no suggestion and logs a code only", async (_n, text, stop) => {
    const id = await note("Secret meeting text xyz");
    const out = await suggestFromNote(run, id, provider(text, stop as "max_tokens" | undefined), NOW);
    expect(out === "none" || out === "invalid").toBe(true);
    expect(await suggestions(id)).toBe(0);
    for (const call of log.mock.calls) expect(call.join(" ")).not.toMatch(/Secret|xyz|Lunch/);
  });

  it("a provider error is 'failed', logged by class, and makes nothing", async () => {
    const id = await note();
    const boom = new FakeProvider({ complete: new TypeError("secret detail") });
    await expect(suggestFromNote(run, id, boom, NOW)).resolves.toBe("failed");
    expect(log).toHaveBeenCalledWith("[calendar] TypeError");
    expect(await suggestions(id)).toBe(0);
  });

  it("makes no call when the entry has no zone, the zone is invalid or the note is gone", async () => {
    const p = provider(plan());
    await expect(suggestFromNote(run, await note("a", null), p, NOW)).resolves.toBe("no-zone");
    await expect(suggestFromNote(run, "00000000-0000-4000-8000-000000000000", p, NOW)).resolves.toBe("gone");
    expect(p.calls).toHaveLength(0);
  });

  it("makes no call when the monthly spend cap has been reached", async () => {
    await q("INSERT INTO usage_events (kind, agent, provider, model, input_tokens, output_tokens, cost_usd, ts) VALUES ('model', 'router', 'fake', 'fake-model-1', 1, 1, 60, $1)", [NOW.toISOString()]);
    const id = await note();
    const p = provider(plan());
    await expect(suggestFromNote(run, id, p, NOW)).resolves.toBe("cap");
    expect(p.calls).toHaveLength(0);
    await q("DELETE FROM usage_events WHERE cost_usd = 60");
  });

  it("is bounded: a model that never answers gives 'timeout'", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const id = await note();
      const hang = new FakeProvider({ complete: () => new Promise(() => undefined) });
      const out = suggestFromNote(run, id, hang, NOW);
      await vi.advanceTimersByTimeAsync(10001);
      await expect(out).resolves.toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("deleting the note removes the suggestion and closes its inbox item", async () => {
    const id = await note();
    await suggestFromNote(run, id, provider(plan()), NOW);
    expect(await openItems(id)).toBe(1);
    const sid = (await q<{ id: string }>("SELECT id FROM calendar_suggestions WHERE crm_note_id = $1", [id])).rows[0]!.id;
    await run((db) => db.query("DELETE FROM crm_notes WHERE id = $1", [id]));
    expect(await count("SELECT count(*) AS n FROM calendar_suggestions WHERE id = $1", [sid])).toBe(0);
    expect(await count("SELECT count(*) AS n FROM inbox_items WHERE ref_id = $1 AND status = 'done' AND resolved_at IS NOT NULL", [sid])).toBe(1);
  });

  describe("after a route", () => {
    const routed = (complete: ConstructorParameters<typeof FakeProvider>[0] extends infer O ? (O extends { complete?: infer C } ? C : never) : never) =>
      new FakeProvider({ classify: { label: "crm_note", confidence: 0.9 }, complete });
    // routeEntry uses the real clock, so the date is relative to it (inside today + 365 days).
    const soon = () => new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    const suggestionsFor = (entryId: string) =>
      count("SELECT count(*) AS n FROM calendar_suggestions c JOIN crm_notes n ON n.id = c.crm_note_id WHERE n.entry_id = $1", [entryId]);

    it("routeEntry to a CRM note creates the suggestion after the commit, from the entry's zone", async () => {
      const entryId = await run((db) => saveEntry(db, "Coffee with Sam someday"));
      await q("UPDATE entries SET time_zone = $2 WHERE id = $1", [entryId, NY]);
      const p = routed({ text: JSON.stringify({ plan: true, title: "Coffee", date: soon(), time: null, duration_minutes: null }) });
      await expect(routeEntry(run, entryId, p)).resolves.toMatchObject({ code: "routed", kind: "crm_note" });
      expect(await suggestionsFor(entryId)).toBe(1);
    });

    it("an entry without a zone is routed and gets no suggestion or model call", async () => {
      const entryId = await run((db) => saveEntry(db, "Coffee with Sam"));
      const p = routed({ text: "{}" });
      await expect(routeEntry(run, entryId, p)).resolves.toMatchObject({ code: "routed", kind: "crm_note" });
      expect(p.calls.filter((c) => c.op === "complete")).toHaveLength(0);
      expect(await suggestionsFor(entryId)).toBe(0);
    });

    it("a failing extraction never changes the route result and makes no suggestion", async () => {
      const entryId = await run((db) => saveEntry(db, "Coffee with Sam"));
      await q("UPDATE entries SET time_zone = $2 WHERE id = $1", [entryId, NY]);
      const p = routed(new Error("down"));
      await expect(routeEntry(run, entryId, p)).resolves.toMatchObject({ code: "routed", kind: "crm_note" });
      expect(await suggestionsFor(entryId)).toBe(0);
    });

    it("routing off (no models secret) has no provider, so nothing is suggested", async () => {
      await expect(routerFromEnv({})).resolves.toBeUndefined();
    });
  });

  describe("Add and Dismiss", () => {
    async function pending(): Promise<string> {
      const id = await note();
      await suggestFromNote(run, id, provider(plan()), NOW);
      return (await q<{ id: string }>("SELECT id FROM calendar_suggestions WHERE crm_note_id = $1", [id])).rows[0]!.id;
    }
    const statusOf = async (sid: string) => (await q<{ status: string; google_event_id: string | null }>("SELECT status, google_event_id FROM calendar_suggestions WHERE id = $1", [sid])).rows[0]!;
    const itemOpen = async (sid: string) => count("SELECT count(*) AS n FROM inbox_items WHERE ref_id = $1 AND status = 'open'", [sid]);
    const fakeFetch = (status: number) => vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response("{}", { status }));
    const token = async () => "tok";

    it("lists it as pending, with its time in the suggestion's zone", async () => {
      const sid = await pending();
      const row = (await run((db) => listPendingSuggestions(db))).find((s) => s.id === sid);
      expect(row).toMatchObject({ title: "Lunch with Sam", when: "2026-11-20 12:30", timeZone: NY, allDay: false });
    });

    it("Add posts the event with the client-chosen id, marks it added and closes the item", async () => {
      const sid = await pending();
      const f = fakeFetch(200);
      await expect(addSuggestionToCalendar(run, sid, { fetch: f as unknown as typeof fetch, accessToken: token })).resolves.toBe("added");
      const [url, init] = f.mock.calls[0]!;
      expect(String(url)).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
      expect(JSON.parse(String(init?.body))).toEqual({
        id: eventIdFor(sid),
        summary: "Lunch with Sam",
        start: { dateTime: "2026-11-20T12:30:00", timeZone: NY },
        end: { dateTime: "2026-11-20T13:15:00", timeZone: NY },
      });
      expect(await statusOf(sid)).toEqual({ status: "added", google_event_id: eventIdFor(sid) });
      expect(await itemOpen(sid)).toBe(0);
    });

    it("Add twice sends one request: the second tap does nothing", async () => {
      const sid = await pending();
      const f = fakeFetch(200);
      const deps = { fetch: f as unknown as typeof fetch, accessToken: token };
      await addSuggestionToCalendar(run, sid, deps);
      await expect(addSuggestionToCalendar(run, sid, deps)).resolves.toBe("already");
      expect(f).toHaveBeenCalledTimes(1);
    });

    it("HTTP 409 (the id exists) counts as success", async () => {
      const sid = await pending();
      await expect(addSuggestionToCalendar(run, sid, { fetch: fakeFetch(409) as unknown as typeof fetch, accessToken: token })).resolves.toBe("added");
      expect((await statusOf(sid)).status).toBe("added");
    });

    it("HTTP 401 leaves it pending and says reconnect", async () => {
      const sid = await pending();
      await expect(addSuggestionToCalendar(run, sid, { fetch: fakeFetch(401) as unknown as typeof fetch, accessToken: token })).resolves.toBe("reconnect");
      expect((await statusOf(sid)).status).toBe("pending");
      expect(await itemOpen(sid)).toBe(1);
    });

    it("another HTTP error or a network error is 'failed' and leaves it pending", async () => {
      const sid = await pending();
      await expect(addSuggestionToCalendar(run, sid, { fetch: fakeFetch(500) as unknown as typeof fetch, accessToken: token })).resolves.toBe("failed");
      const down = vi.fn(async () => {
        throw new TypeError("offline");
      });
      await expect(addSuggestionToCalendar(run, sid, { fetch: down as unknown as typeof fetch, accessToken: token })).resolves.toBe("failed");
      expect((await statusOf(sid)).status).toBe("pending");
    });

    it("without a Google token it calls nothing and stays pending", async () => {
      const sid = await pending();
      const f = fakeFetch(200);
      await expect(addSuggestionToCalendar(run, sid, { fetch: f as unknown as typeof fetch, accessToken: async () => null })).resolves.toBe("not-connected");
      expect(f).not.toHaveBeenCalled();
      expect((await statusOf(sid)).status).toBe("pending");
    });

    it("an unknown or malformed id is not-found", async () => {
      await expect(addSuggestionToCalendar(run, "nope")).resolves.toBe("not-found");
      await expect(addSuggestionToCalendar(run, "00000000-0000-4000-8000-000000000000")).resolves.toBe("not-found");
    });

    it("Dismiss marks it dismissed and closes the item; a second dismiss and a later Add do nothing", async () => {
      const sid = await pending();
      await expect(run((db) => dismissSuggestion(db, sid))).resolves.toBe(true);
      expect((await statusOf(sid)).status).toBe("dismissed");
      expect(await itemOpen(sid)).toBe(0);
      await expect(run((db) => dismissSuggestion(db, sid))).resolves.toBe(false);
      const f = fakeFetch(200);
      await expect(addSuggestionToCalendar(run, sid, { fetch: f as unknown as typeof fetch, accessToken: token })).resolves.toBe("already");
      expect(f).not.toHaveBeenCalled();
      expect((await run((db) => listPendingSuggestions(db))).some((s) => s.id === sid)).toBe(false);
    });
  });
});
