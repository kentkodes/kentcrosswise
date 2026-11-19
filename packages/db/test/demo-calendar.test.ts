import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, type SqlClient } from "../src/index";
import { freshDb } from "./helpers";

// 0029: the dummy calendar of the public log (slice PL7, DESIGN §4.6). Owner-critical: web_public reads two views.
// Synthetic text only.
describe("0029 demo calendar", () => {
  let pg: PGlite;
  let db: SqlClient;
  let n = 0;
  const entry = async () =>
    (await db.query<{ id: string }>("INSERT INTO entries (source, raw_text, route_kind, status, routed_by) VALUES ('web', 'synthetic', 'crm_note', 'routed', 'model') RETURNING id")).rows[0]!.id;
  const as = async <T>(role: string, fn: () => Promise<T>): Promise<T> => {
    await db.exec(`BEGIN; SET LOCAL ROLE ${role};`);
    try {
      return await fn();
    } finally {
      await db.exec("ROLLBACK");
    }
  };
  const publish = (id: string, state: "published" | "withheld" = "published") =>
    state === "published"
      ? db.query("INSERT INTO public_records (entry_id, state, kind, captured_hour, body) VALUES ($1, 'published', 'crm_note', date_trunc('hour', now()), 'text')", [id])
      : db.query("INSERT INTO public_records (entry_id, state, withheld_reason, kind, captured_hour) VALUES ($1, 'withheld', 'private-other', 'crm_note', date_trunc('hour', now()))", [id]);
  const eventId = () => (++n).toString(16).padStart(32, "0");
  const mirror = (entryId: string, cols: { start?: string; end?: string; allDay?: boolean; event?: string; title?: string } = {}) =>
    db.query(
      "INSERT INTO demo_calendar_events (suggestion_id, entry_id, event_id, title, all_day, start_at, end_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)",
      [entryId, cols.event ?? eventId(), cols.title ?? "Call [Person 1]", cols.allDay ?? false, cols.start ?? "2026-12-01T10:00:00Z", cols.end ?? "2026-12-01T11:00:00Z"],
    );

  beforeAll(async () => {
    ({ pg, db } = await freshDb());
  });
  afterAll(async () => {
    await pg.close();
  });

  it("is migration 0029", async () => {
    expect((await loadMigrations()).find((m) => m.version === "0029")?.name).toBe("demo_calendar");
  });

  it.each([
    ["a start not on the hour", { start: "2026-12-01T10:30:00Z" }],
    ["an end not on the hour", { end: "2026-12-01T11:01:00Z" }],
    ["an end before the start", { start: "2026-12-01T11:00:00Z", end: "2026-12-01T10:00:00Z" }],
    ["an all-day event not at midnight", { allDay: true, start: "2026-12-01T10:00:00Z", end: "2026-12-02T10:00:00Z" }],
    ["an all-day event longer than a day", { allDay: true, start: "2026-12-01T00:00:00Z", end: "2026-12-03T00:00:00Z" }],
    ["an event id that is not 32 hex characters", { event: "Not-An-Id" }],
    ["an empty title", { title: "" }],
  ])("rejects %s", async (_name, cols) => {
    await expect(mirror(await entry(), cols)).rejects.toThrow();
  });

  it("keeps one settings row with a calendar address and an outcome code", async () => {
    await db.query("INSERT INTO demo_calendar (calendar_id) VALUES ('demo.calendar@example.com')");
    await expect(db.query("INSERT INTO demo_calendar (id) VALUES (false)")).rejects.toThrow();
    await expect(db.query("INSERT INTO demo_calendar (id) VALUES (true)")).rejects.toThrow();
    await expect(db.query("UPDATE demo_calendar SET calendar_id = 'not an address'")).rejects.toThrow();
    await expect(db.query("UPDATE demo_calendar SET last_sync_at = now(), last_sync_outcome = 'Some Text!'")).rejects.toThrow();
    await expect(db.query("UPDATE demo_calendar SET last_sync_outcome = 'synced'")).rejects.toThrow();
    await db.query("UPDATE demo_calendar SET last_sync_at = now(), last_sync_outcome = 'synced'");
  });

  it("v_public_demo_events lists events of published records only, with the record's public id", async () => {
    const pub = await entry();
    const held = await entry();
    const none = await entry();
    await publish(pub);
    await publish(held, "withheld");
    await mirror(pub, { title: "Shown" });
    await mirror(held, { title: "Held" });
    await mirror(none, { title: "Unpublished" });
    await mirror(pub, { title: "All day", allDay: true, start: "2026-12-05T00:00:00Z", end: "2026-12-06T00:00:00Z" });
    const { rows } = await as("web_public", () =>
      db.query<{ public_id: string; title: string }>("SELECT * FROM v_public_demo_events ORDER BY title"),
    );
    const cols = await db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'v_public_demo_events' ORDER BY ordinal_position");
    expect(cols.rows.map((c) => c.column_name)).toEqual(["public_id", "title", "all_day", "start_at", "end_at"]);
    expect(rows.map((r) => r.title)).toEqual(["All day", "Shown"]);
    const publicId = (await db.query<{ public_id: string }>("SELECT public_id FROM public_records WHERE entry_id = $1", [pub])).rows[0]!.public_id;
    expect(rows.every((r) => r.public_id === publicId)).toBe(true);
  });

  it("v_public_demo_calendar shows the calendar id only once it is set", async () => {
    const { rows } = await as("web_public", () => db.query<{ calendar_id: string }>("SELECT * FROM v_public_demo_calendar"));
    expect(rows).toEqual([{ calendar_id: "demo.calendar@example.com" }]);
    await db.query("UPDATE demo_calendar SET calendar_id = NULL");
    expect((await as("web_public", () => db.query("SELECT * FROM v_public_demo_calendar"))).rows).toEqual([]);
  });

  it("web_public cannot read the tables; web_rw reads, writes and deletes events; orch_rw has nothing", async () => {
    await expect(as("web_public", () => db.query("SELECT * FROM demo_calendar_events"))).rejects.toThrow();
    await expect(as("web_public", () => db.query("SELECT * FROM demo_calendar"))).rejects.toThrow();
    const id = await entry();
    await as("web_rw", async () => {
      await mirror(id);
      await db.query("UPDATE demo_calendar SET last_sync_at = now(), last_sync_outcome = 'failed'");
      await db.query("DELETE FROM demo_calendar_events WHERE entry_id = $1", [id]);
    });
    await expect(as("web_rw", () => db.query("DELETE FROM demo_calendar"))).rejects.toThrow();
    await expect(as("orch_rw", () => db.query("SELECT * FROM demo_calendar_events"))).rejects.toThrow();
    await expect(as("orch_rw", () => db.query("SELECT * FROM v_public_demo_events"))).rejects.toThrow();
  });

  it("an event row outlives its entry (the sync removes it from Google first)", async () => {
    const id = await entry();
    await mirror(id);
    await db.query("DELETE FROM entries WHERE id = $1", [id]);
    expect((await db.query("SELECT 1 FROM demo_calendar_events WHERE entry_id = $1", [id])).rows).toHaveLength(1);
  });
});
