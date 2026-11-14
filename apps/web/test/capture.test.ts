import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { entryStatus, listRecentEntries, MAX_CAPTURE_CHARS, parseCapture, saveEntry } from "../src/server/capture";
import { runAs, type Queryable } from "../src/server/db";
import { freshDb, pglitePool } from "./pglite";

describe("parseCapture", () => {
  it("rejects empty and whitespace-only input", () => {
    expect(parseCapture("")).toEqual({ ok: false, error: "empty" });
    expect(parseCapture(" \t\r\n  ")).toEqual({ ok: false, error: "empty" });
    expect(parseCapture(null)).toEqual({ ok: false, error: "empty" });
    expect(parseCapture(undefined)).toEqual({ ok: false, error: "empty" });
  });

  it("keeps the text as typed, only turning CRLF into LF", () => {
    expect(parseCapture("  call Sam  \n")).toEqual({ ok: true, text: "  call Sam  \n" });
    expect(parseCapture("line one\r\nline two\r\n")).toEqual({ ok: true, text: "line one\nline two\n" });
  });

  it("accepts exactly the maximum length and rejects one more", () => {
    expect(MAX_CAPTURE_CHARS).toBe(10000);
    expect(parseCapture("x".repeat(10000))).toEqual({ ok: true, text: "x".repeat(10000) });
    expect(parseCapture("x".repeat(10001))).toEqual({ ok: false, error: "too-long" });
  });

  it("counts the length after CRLF becomes LF", () => {
    const half = "x".repeat(4999);
    expect(parseCapture(`${half}\r\n${half}\r\n`).ok).toBe(true); // 9998 + 2 LF = 10000 after normalising
    expect(parseCapture(`${half}\r\n${half}\r\nx`)).toEqual({ ok: false, error: "too-long" });
  });
});

describe("entryStatus", () => {
  it("shows Needs you (warn) when the status is needs_owner, whatever the route", () => {
    expect(entryStatus({ routeKind: null, status: "needs_owner" })).toEqual({ label: "Needs you", tone: "warn" });
    expect(entryStatus({ routeKind: "todo", status: "needs_owner" })).toEqual({ label: "Needs you", tone: "warn" });
  });

  it("shows the route label (ok) for every routed kind", () => {
    const labels = {
      crm_note: "CRM note",
      diary: "Diary",
      todo: "Todo",
      idea: "Idea",
      agent_request: "Agent request",
    } as const;
    for (const [kind, label] of Object.entries(labels)) {
      expect(entryStatus({ routeKind: kind as keyof typeof labels, status: "routed" })).toEqual({ label, tone: "ok" });
    }
  });

  it("is Waiting for router (idle) while the entry has no route", () => {
    expect(entryStatus({ routeKind: null, status: null })).toEqual({ label: "Waiting for router", tone: "idle" });
  });
});

describe("saveEntry and listRecentEntries as web_rw", () => {
  let pg: PGlite;
  const asRw = <T>(fn: (db: Queryable) => Promise<T>) => runAs(pglitePool(pg), "web_rw", fn);

  beforeAll(async () => {
    pg = await freshDb();
  });
  afterAll(async () => {
    await pg.close();
  });

  it("returns an empty list before anything is captured", async () => {
    await expect(asRw((db) => listRecentEntries(db))).resolves.toEqual([]);
  });

  it("stores a web entry as pending (no route, no status)", async () => {
    const id = await asRw((db) => saveEntry(db, "Buy stamps\nand call Sam"));
    const { rows } = await pg.query<{ source: string; raw_text: string; route_kind: string | null; status: string | null }>(
      "SELECT source, raw_text, route_kind, status FROM entries WHERE id = $1",
      [id],
    );
    expect(rows).toEqual([{ source: "web", raw_text: "Buy stamps\nand call Sam", route_kind: null, status: null }]);
  });

  it("lists newest first, limited, with the route and status of each row", async () => {
    // The row saved above has created_at = now(), so the fixed rows below are dated 2021 to sort older than it.
    // Explicit times keep the order independent of the clock resolution of the test run.
    for (let i = 0; i < 12; i++) {
      await pg.query("INSERT INTO entries (created_at, source, raw_text) VALUES ($1::timestamptz, 'web', $2)", [
        `2021-01-01T00:${String(i).padStart(2, "0")}:00Z`,
        `old ${i}`,
      ]);
    }
    await pg.query(
      "INSERT INTO entries (created_at, source, raw_text, route_kind, status) VALUES ('2021-02-02T00:00:00Z', 'web', 'a todo', 'todo', 'routed')",
    );
    await pg.query(
      "INSERT INTO entries (created_at, source, raw_text, status) VALUES ('2021-03-03T00:00:00Z', 'web', 'unclear', 'needs_owner')",
    );

    const recent = await asRw((db) => listRecentEntries(db));
    expect(recent).toHaveLength(10);
    // Newest first: the saved row (now), then the 2021 rows from the latest down.
    expect(recent.map((e) => e.rawText).slice(0, 3)).toEqual(["Buy stamps\nand call Sam", "unclear", "a todo"]);
    expect(recent[1]).toMatchObject({ createdAt: "2021-03-03T00:00:00.000Z", routeKind: null, status: "needs_owner" });
    expect(recent[2]).toMatchObject({ routeKind: "todo", status: "routed" });
    expect(recent[3]!.rawText).toBe("old 11");
    expect(recent[9]!.rawText).toBe("old 5");
    expect(recent.map((e) => e.createdAt)).toEqual([...recent.map((e) => e.createdAt)].sort().reverse());

    const limited = await asRw((db) => listRecentEntries(db, 3));
    expect(limited.map((e) => e.rawText)).toEqual(["Buy stamps\nand call Sam", "unclear", "a todo"]);
  });
});
