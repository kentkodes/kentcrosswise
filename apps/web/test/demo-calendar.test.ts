// PL7: the dummy calendar. Only suggestions the owner added in published contact notes are mirrored, with the title
// through the record's redactor and the times rounded to the hour; a record that stops being published loses its
// event; Google is only called for what differs from the stored copies; the public reader lists the stored copies.
// PGlite, FakeProvider and a fake fetch only; synthetic names and text.
import type { PGlite } from "@electric-sql/pglite";
import { FakeProvider } from "@kcw/core/models";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { saveEntry } from "../src/server/capture";
import { createContact } from "../src/server/contacts";
import { runAs } from "../src/server/db";
import {
  demoCalendarStatus,
  demoEventBody,
  demoEventId,
  planSync,
  roundedTimes,
  saveDemoCalendarId,
  syncDemoCalendar,
  type DemoEvent,
  type DemoRun,
  type SyncDeps,
} from "../src/server/demo-calendar";
import { publicCalendarUrl, queryPublicLog } from "../src/server/public-log";
import { publishEntry } from "../src/server/publish";
import { confirmEntry, prepareSpans } from "../src/server/review";
import { routeEntry, type DbRun } from "../src/server/router";
import { freshDb, pglitePool } from "./pglite";

const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

describe("roundedTimes and the event body", () => {
  it("rounds a timed event down to the hour and keeps at least an hour", () => {
    expect(roundedTimes({ startAt: new Date("2026-12-01T10:30:00Z"), endAt: new Date("2026-12-01T10:45:00Z"), allDay: false, timeZone: "Europe/London" })).toEqual({
      start: "2026-12-01T10:00:00.000Z",
      end: "2026-12-01T11:00:00.000Z",
    });
    expect(roundedTimes({ startAt: new Date("2026-12-01T10:59:00Z"), endAt: new Date("2026-12-01T12:30:00Z"), allDay: false, timeZone: null })).toEqual({
      start: "2026-12-01T10:00:00.000Z",
      end: "2026-12-01T12:00:00.000Z",
    });
    expect(roundedTimes({ startAt: new Date("2026-12-01T10:20:00Z"), endAt: null, allDay: false, timeZone: null }).end).toBe("2026-12-01T11:00:00.000Z");
  });

  it("keeps an all-day event on its date in the suggestion's zone", () => {
    // 07:00 UTC on 2 December is still 1 December in Los Angeles.
    expect(roundedTimes({ startAt: new Date("2026-12-02T07:00:00Z"), endAt: null, allDay: true, timeZone: "America/Los_Angeles" })).toEqual({
      start: "2026-12-01T00:00:00.000Z",
      end: "2026-12-02T00:00:00.000Z",
    });
  });

  it("writes UTC times or the date, and a derived id that is not the suggestion id", () => {
    const id = "0b9b7c55-3a0f-4c3e-9a3c-4b8f2f1c0d11";
    const eventId = demoEventId(id);
    expect(eventId).toMatch(/^[0-9a-f]{32}$/);
    expect(eventId).not.toBe(id.replaceAll("-", ""));
    expect(demoEventId(id.toUpperCase())).toBe(eventId);
    const e: DemoEvent = { suggestionId: id, entryId: id, eventId, title: "Call [Person 1]", allDay: false, start: "2026-12-01T10:00:00.000Z", end: "2026-12-01T11:00:00.000Z" };
    expect(demoEventBody(e)).toEqual({
      id: eventId,
      summary: "Call [Person 1]",
      start: { dateTime: "2026-12-01T10:00:00Z", timeZone: "UTC" },
      end: { dateTime: "2026-12-01T11:00:00Z", timeZone: "UTC" },
      status: "confirmed",
    });
    expect(demoEventBody({ ...e, allDay: true, start: "2026-12-01T00:00:00.000Z", end: "2026-12-02T00:00:00.000Z" })).toMatchObject({
      start: { date: "2026-12-01" },
      end: { date: "2026-12-02" },
    });
  });

  it("plans removals for events no longer wanted and writes only for new or changed ones", () => {
    const base: DemoEvent = { suggestionId: "a", entryId: "e", eventId: "x", title: "T", allDay: false, start: "s", end: "t" };
    const plan = planSync([base, { ...base, suggestionId: "b", title: "New" }, { ...base, suggestionId: "c", title: "Changed" }], [base, { ...base, suggestionId: "c" }, { ...base, suggestionId: "d" }]);
    expect(plan.remove.map((e) => e.suggestionId)).toEqual(["d"]);
    expect(plan.write.map((w) => [w.event.suggestionId, w.exists])).toEqual([
      ["b", false],
      ["c", true],
    ]);
  });

  it("links the public calendar of an address only", () => {
    expect(publicCalendarUrl("demo.calendar+log@example.com")).toBe("https://calendar.google.com/calendar/embed?src=demo.calendar%2Blog%40example.com");
    expect(publicCalendarUrl("javascript:alert(1)")).toBeNull();
    expect(publicCalendarUrl(null)).toBeNull();
  });
});

describe("syncDemoCalendar (web_rw writes, web_public reads)", () => {
  let pg: PGlite;
  const run: DbRun = (fn) => runAs(pglitePool(pg), "web_rw", fn);
  const pub: DbRun = (fn) => runAs(pglitePool(pg), "web_public", fn);
  const demoRun = run as DemoRun;
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  type Call = { method: string; url: string; body: Record<string, unknown> | null };
  let calls: Call[] = [];
  let reply: (c: Call) => number = () => 200;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const c = { method: String(init.method), url, body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null };
    calls.push(c);
    return new Response(null, { status: reply(c) });
  }) as unknown as typeof fetch;
  const deps: SyncDeps = { run: demoRun, fetch: fakeFetch, accessToken: async (): Promise<string | null> => "synthetic-token" };
  const sync = (entryId: string | null, extra: SyncDeps = {}) => syncDemoCalendar(entryId, { ...deps, ...extra });

  const stored = (entryId: string) =>
    pg.query<{ title: string; start_at: Date; end_at: Date; all_day: boolean; event_id: string }>("SELECT title, start_at, end_at, all_day, event_id FROM demo_calendar_events WHERE entry_id = $1 ORDER BY title", [entryId]);

  /** A reviewed, published contact note with one calendar suggestion in the given state. */
  const note = async (text: string, suggestion: { title: string; start: string; end?: string | null; allDay?: boolean; status?: string }) => {
    const id = await run((db) => saveEntry(db, text));
    await routeEntry(run, id, new FakeProvider({ classify: { label: "crm_note", confidence: 0.9 }, model: "deepseek-flash" }));
    await prepareSpans(run, id, new FakeProvider({ complete: { text: JSON.stringify({ people: [], places: ["Gull Pier"], private_other: false }) } }));
    const { rows } = await pg.query<{ id: string }>(
      `INSERT INTO calendar_suggestions (crm_note_id, title, start_at, end_at, all_day, time_zone, status)
       SELECT n.id, $2, $3, $4, $5, 'Europe/London', $6 FROM crm_notes n WHERE n.entry_id = $1 RETURNING id`,
      [id, suggestion.title, suggestion.start, suggestion.end ?? null, suggestion.allDay ?? false, suggestion.status ?? "added"],
    );
    await run((db) => confirmEntry(db, id));
    await expect(run((db) => publishEntry(db, id))).resolves.toBe("published");
    return { id, suggestionId: rows[0]!.id };
  };

  beforeAll(async () => {
    pg = await freshDb();
    await run((db) => createContact(db, { name: "Pell Rook", aliases: [], howKnown: null, birthday: null, notes: null, tags: [] }));
  });
  afterAll(async () => {
    await pg.close();
  });
  beforeEach(() => {
    calls = [];
    reply = () => 200;
  });

  it("mirrors an added suggestion of a published note with a sanitized title and rounded times, once", async () => {
    const { id, suggestionId } = await note("Coffee with Pell Rook at Gull Pier", { title: "Coffee with Pell Rook at Gull Pier", start: "2026-12-01T10:30:00Z", end: "2026-12-01T11:15:00Z" });
    await expect(sync(id)).resolves.toBe("synced");
    expect(calls).toEqual([
      {
        method: "POST",
        url: EVENTS,
        body: {
          id: demoEventId(suggestionId),
          summary: "Coffee with [Person 1] at [place]",
          start: { dateTime: "2026-12-01T10:00:00Z", timeZone: "UTC" },
          end: { dateTime: "2026-12-01T11:00:00Z", timeZone: "UTC" },
          status: "confirmed",
        },
      },
    ]);
    expect((await stored(id)).rows).toEqual([
      { title: "Coffee with [Person 1] at [place]", start_at: new Date("2026-12-01T10:00:00Z"), end_at: new Date("2026-12-01T11:00:00Z"), all_day: false, event_id: demoEventId(suggestionId) },
    ]);
    calls = [];
    await expect(sync(id)).resolves.toBe("nothing");
    await expect(sync(null)).resolves.toBe("nothing");
    expect(calls).toEqual([]);

    const log = await pub((db) => queryPublicLog(db));
    const record = log.records.find((r) => r.text === "Coffee with [Person 1] at [place]")!;
    expect(log.calendar.events).toContainEqual({ recordId: record.id, title: "Coffee with [Person 1] at [place]", allDay: false, start: "2026-12-01T10:00:00.000Z", end: "2026-12-01T11:00:00.000Z" });
    expect(JSON.stringify(log.calendar)).not.toMatch(new RegExp(`Pell|Rook|Gull|${suggestionId}|${demoEventId(suggestionId)}|${id}`));
  });

  it("does not mirror pending or dismissed suggestions, or a title that cannot be made safe", async () => {
    const pending = await note("Synthetic pending note", { title: "Pending call", start: "2026-12-02T09:00:00Z", status: "pending" });
    const dismissed = await note("Synthetic dismissed note", { title: "Dismissed call", start: "2026-12-02T09:00:00Z", status: "dismissed" });
    const unsafe = await note("Synthetic unsafe note", { title: "Call сab", start: "2026-12-02T09:00:00Z" }); // mixed scripts
    for (const n of [pending, dismissed, unsafe]) await expect(sync(n.id)).resolves.toBe("nothing");
    expect(calls).toEqual([]);
  });

  it("removes the event when the record stops being published, and an all-day event stays all-day", async () => {
    const n = await note("Synthetic all-day note", { title: "Synthetic fair", start: "2026-12-03T00:00:00Z", allDay: true });
    await sync(n.id);
    expect(calls[0]!.body).toMatchObject({ start: { date: "2026-12-03" }, end: { date: "2026-12-04" } });
    calls = [];
    await pg.query("UPDATE public_records SET state = 'withheld', withheld_reason = 'private-other', body = NULL, steps = '[]', checks = '[]', checks_version = NULL WHERE entry_id = $1", [n.id]);
    reply = () => 410; // already gone at Google counts as removed
    await expect(sync(n.id)).resolves.toBe("synced");
    expect(calls).toEqual([{ method: "DELETE", url: `${EVENTS}/${demoEventId(n.suggestionId)}`, body: null }]);
    expect((await stored(n.id)).rows).toEqual([]);
  });

  it("writes over an existing id (409) and updates a changed title in place", async () => {
    const n = await note("Synthetic repeat note", { title: "Synthetic repeat", start: "2026-12-04T15:00:00Z" });
    reply = (c) => (c.method === "POST" ? 409 : 200);
    await expect(sync(n.id)).resolves.toBe("synced");
    expect(calls.map((c) => c.method)).toEqual(["POST", "PUT"]);
    calls = [];
    reply = () => 200;
    await pg.query("UPDATE calendar_suggestions SET title = 'Synthetic renamed' WHERE id = $1", [n.suggestionId]);
    await expect(sync(n.id)).resolves.toBe("synced");
    expect(calls).toEqual([{ method: "PUT", url: `${EVENTS}/${demoEventId(n.suggestionId)}`, body: expect.objectContaining({ summary: "Synthetic renamed" }) }]);
    expect((await stored(n.id)).rows[0]!.title).toBe("Synthetic renamed");
  });

  it("pauses without a connection, on a rejected token or a failed call, and records the outcome", async () => {
    const n = await note("Synthetic paused note", { title: "Synthetic paused", start: "2026-12-05T08:00:00Z" });
    await expect(sync(n.id, { accessToken: async () => null })).resolves.toBe("not-connected");
    expect(await run((db) => demoCalendarStatus(db))).toMatchObject({ lastSyncOutcome: "not-connected" });
    reply = () => 401;
    await expect(sync(n.id)).resolves.toBe("reconnect");
    reply = () => 500;
    await expect(sync(n.id)).resolves.toBe("failed");
    expect((await stored(n.id)).rows).toEqual([]);
    expect(await run((db) => demoCalendarStatus(db))).toMatchObject({ lastSyncOutcome: "failed", lastSyncAt: expect.any(String) });
    reply = () => 200;
    await expect(sync(null)).resolves.toBe("synced");
    expect((await stored(n.id)).rows).toHaveLength(1);
  });

  it("is a no-op when the demo calendar is not configured", async () => {
    await expect(syncDemoCalendar(null, { run: demoRun, fetch: fakeFetch })).resolves.toBe("not-configured");
    expect(calls).toEqual([]);
  });

  it("stores the calendar id for the public link, and drops the stored copies when the account changes", async () => {
    await run((db) => saveDemoCalendarId(db, "demo.one@example.com"));
    const mirrored = (await run((db) => demoCalendarStatus(db))).mirrored;
    expect(mirrored).toBeGreaterThan(0);
    expect((await pub((db) => queryPublicLog(db))).calendar.link).toBe("https://calendar.google.com/calendar/embed?src=demo.one%40example.com");
    await run((db) => saveDemoCalendarId(db, "DEMO.ONE@example.com"));
    expect((await run((db) => demoCalendarStatus(db))).mirrored).toBe(mirrored);
    await run((db) => saveDemoCalendarId(db, "demo.two@example.com"));
    expect(await run((db) => demoCalendarStatus(db))).toMatchObject({ calendarId: "demo.two@example.com", mirrored: 0 });
    expect((await pub((db) => queryPublicLog(db))).calendar.events).toEqual([]);
  });
});
