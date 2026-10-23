import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DbNotConfiguredError, runAs } from "../src/server/db";
import {
  FEED_LIMIT,
  NOTE_NOT_CONFIGURED,
  NOTE_UNAVAILABLE,
  PUBLIC_EVENT_FIELDS,
  loadPublicFeed,
  parseSince,
  queryPublicEvents,
} from "../src/server/public-feed";
import { freshDb, pglitePool } from "./pglite";

describe("parseSince", () => {
  it("accepts event ids and rejects anything else", () => {
    expect(parseSince(null)).toBeUndefined();
    expect(parseSince("")).toBeUndefined();
    expect(parseSince("42")).toBe(42);
    for (const bad of ["-1", "1.5", "abc", "1e3", "9999999999999999", " 1"]) expect(parseSince(bad)).toBeNull();
  });
});

describe("public feed on PGlite as web_public", () => {
  let pg: PGlite;
  const asPublic = <T>(fn: Parameters<typeof runAs<T>>[2]) => runAs(pglitePool(pg), "web_public", fn, { readOnly: true });

  beforeAll(async () => {
    pg = await freshDb({ seed: true });
  });
  afterAll(async () => {
    await pg.close();
  });

  it("returns only id, ts, agent, type, title; private and untitled tasks are 'Private task'", async () => {
    const events = await asPublic((db) => queryPublicEvents(db));
    expect(events).toHaveLength(13);
    for (const e of events) {
      expect(Object.keys(e)).toEqual([...PUBLIC_EVENT_FIELDS]);
      expect(typeof e.id).toBe("number");
      expect(e.ts).toMatch(/^\d{4}-\d\d-\d\dT/);
    }
    expect(new Set(events.map((e) => e.title))).toEqual(new Set(["Add a health check page", "Private task"]));
    const text = JSON.stringify(events);
    expect(text).not.toContain("[seed]");
    expect(text).not.toContain("Seed private title");
    expect(text).not.toContain("Example Person");
  });

  it("pages by id: latest FEED_LIMIT ascending, then events after `since`", async () => {
    for (let i = 0; i < FEED_LIMIT + 5; i++) {
      await pg.query("INSERT INTO agent_events (agent, event_type) VALUES ('docs', 'coding')");
    }
    const latest = await asPublic((db) => queryPublicEvents(db));
    expect(latest).toHaveLength(FEED_LIMIT);
    const ids = latest.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    const { rows } = await pg.query<{ max: number }>("SELECT max(id)::int AS max FROM agent_events");
    expect(ids.at(-1)).toBe(rows[0]!.max);
    const after = await asPublic((db) => queryPublicEvents(db, ids.at(-3)));
    expect(after.map((e) => e.id)).toEqual(ids.slice(-2));
    // An event without a task is also "Private task".
    expect(after.every((e) => e.title === "Private task")).toBe(true);
  });
});

describe("loadPublicFeed degrades", () => {
  it("not configured: empty list with a note", async () => {
    const feed = await loadPublicFeed(undefined, () => Promise.reject(new DbNotConfiguredError("no db_url_public")));
    expect(feed).toEqual({ available: false, events: [], note: NOTE_NOT_CONFIGURED });
  });

  it("DB failure: empty list with a note, one log line without the message", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const err = Object.assign(new Error("connect to secret-host failed"), { code: "ECONNREFUSED" });
    const feed = await loadPublicFeed(undefined, () => Promise.reject(err));
    expect(feed).toEqual({ available: false, events: [], note: NOTE_UNAVAILABLE });
    expect(log).toHaveBeenCalledWith("[public-feed] Error ECONNREFUSED");
    log.mockRestore();
  });
});
