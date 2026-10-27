import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseOfficeEnvelope, type AvailableOffice } from "../src/office-contract";
import { DbNotConfiguredError, runAs, type Queryable } from "../src/server/db";
import {
  OFFICE_PAGE_DEFAULT,
  OfficeRequestError,
  decodeOfficeCursor,
  encodeOfficeCursor,
  loadOfficeProjection,
  readOfficeProjection,
  type OfficeRequest,
} from "../src/server/office-projection";
import { freshDb, pglitePool } from "./pglite";

// Unit 2 read adapter (docs/office/LIVE-CONTRACT.md) on PGlite as web_public through the
// production runAs path. PGlite has one session: concurrent writers are reproduced as sequential
// commits in reversed source order (packages/db/test/office-projection.test.ts checks the lock).

describe("office projection read adapter", () => {
  let pg: PGlite;
  let source = 0;
  const project = async (transition: unknown, key = `delivery-${++source}`) =>
    (await pg.query<{ r: number | null }>("SELECT office_project($1, $2::jsonb)::int AS r", [key, JSON.stringify(transition)])).rows[0]!.r;
  const read = (request: OfficeRequest) => runAs(pglitePool(pg), "web_public", (db) => readOfficeProjection(db, request), { readOnly: true });
  /** Every adapter response must pass the unit-1 strict parser unchanged. */
  const parsed = async (request: OfficeRequest): Promise<AvailableOffice> => {
    const envelope = await read(request);
    const result = parseOfficeEnvelope(envelope);
    expect(result).toEqual({ ok: true, value: envelope });
    return envelope;
  };

  beforeAll(async () => {
    pg = await freshDb();
  });
  afterAll(async () => {
    await pg.close();
  });

  it("bootstraps an empty projection at revision 0 with complete (empty) replay", async () => {
    const office = await parsed({ mode: "bootstrap" });
    expect(office).toMatchObject({ revision: "0", privacy_epoch: "0", events: [] });
    expect(office.history).toMatchObject({
      mode: "bootstrap", watermark: { revision: "0", ordinal: 0 }, through: { revision: "0", ordinal: 0 }, oldest_available: null,
      replay: { events: [], from: null, through: null, completeness: "complete" },
    });
    expect(office.snapshot).toEqual({ tasks: [], executions: [], related_tasks: [], pause: { paused: null, observed_at: null } });
  });

  it("returns snapshot, replay and watermark from one statement, consistent at that watermark", async () => {
    await project({
      tasks: [
        { task_id: 1, is_private: false, public_title: "Add a health endpoint", kind: "work", state: "merged", role: "developer" },
        { task_id: 2, is_private: true, public_title: "Synthetic private title", kind: "work", state: "in_progress", role: "developer" },
      ],
      executions: [{ key: "run:2:1", task_id: 2, role: "developer", station: "developer", seat: 1, reported_activity: "coding", reported_at: "2026-10-25T18:00:00Z" }],
    });
    await project({
      tasks: [
        { task_id: 2, execution: "run:2:1" },
        { task_id: 3, is_private: false, public_title: "Document the health endpoint", kind: "docs", state: "queued", role: "docs", parent_task_id: 1, parent_kind: "docs_parent" },
      ],
      events: [
        { task_id: 1, role: "developer", type: "merged", recorded_at: "2026-10-25T18:01:00Z" },
        { task_id: 2, execution: "run:2:1", role: "developer", type: "coding" },
        { task_id: 3, role: "orchestrator", type: "task_assigned" },
      ],
      pause: { paused: false },
    });
    const statements: string[] = [];
    const office = await runAs(pglitePool(pg), "web_public", (db) => {
      const counting: Queryable = { query: (sql, params) => (statements.push(sql), db.query(sql, params)) };
      return readOfficeProjection(counting, { mode: "bootstrap" });
    }, { readOnly: true });
    expect(statements).toHaveLength(1);
    expect(parseOfficeEnvelope(office).ok).toBe(true);
    expect(office.revision).toBe("2");
    expect(office.history.watermark).toEqual({ revision: "2", ordinal: 2 });
    expect(office.history.replay!.events.map((e) => [e.position, e.description])).toEqual([
      [{ revision: "2", ordinal: 0 }, "Add a health endpoint"],
      [{ revision: "2", ordinal: 1 }, "Private task"],
      [{ revision: "2", ordinal: 2 }, "Document the health endpoint"],
    ]);
    expect(office.history.replay!.completeness).toBe("complete");
    expect(office.snapshot.related_tasks).toEqual([
      { task_ref: office.history.replay!.events[2]!.task_ref, related_task_ref: office.history.replay!.events[0]!.task_ref, kind: "docs_parent", visibility: "public", description: "Add a health endpoint" },
    ]);
    expect(office.snapshot.executions).toHaveLength(1);
    expect(office.snapshot.executions![0]).toMatchObject({ role: "developer", assignment: { station: "developer", seat: 1 }, phase: "unknown" });
    expect(office.snapshot.pause.paused).toBe(false);
    const text = JSON.stringify(office);
    expect(text).not.toContain("Synthetic private title");
    expect(text).not.toContain("run:2:1");
    expect(text).not.toMatch(/"task_id"|source_key/);
  });

  it("marks the latest-20 replay partial once older history exists", async () => {
    await project({ events: Array.from({ length: 25 }, () => ({ task_id: 1, role: "qa", type: "qa_reviewing" })) });
    const office = await parsed({ mode: "bootstrap" });
    expect(office.history.replay!.events).toHaveLength(20);
    expect(office.history.replay!.completeness).toBe("partial");
    expect(office.history.replay!.through).toEqual(office.history.watermark);
  });

  it("pages across an intra-revision boundary with has_more relative to the read watermark", async () => {
    const start = await parsed({ mode: "bootstrap" });
    await project({ events: [0, 1, 2].map(() => ({ task_id: 2, execution: "run:2:1", role: "developer", type: "coding" })) });
    const first = await parsed({ mode: "incremental", cursor: start.history.cursor!, limit: 2 });
    expect(first.events.map((e) => e.position)).toEqual([{ revision: "4", ordinal: 0 }, { revision: "4", ordinal: 1 }]);
    expect(first.history).toMatchObject({ has_more: true, completeness: "partial", through: { revision: "4", ordinal: 1 }, watermark: { revision: "4", ordinal: 2 } });
    const second = await parsed({ mode: "incremental", cursor: first.history.cursor! });
    expect(second.events.map((e) => e.position)).toEqual([{ revision: "4", ordinal: 2 }]);
    expect(second.history).toMatchObject({ has_more: false, completeness: "complete" });
    const empty = await parsed({ mode: "incremental", cursor: second.history.cursor! });
    expect(empty.events).toEqual([]);
    expect(empty.history.through).toEqual(empty.history.from);
    expect(OFFICE_PAGE_DEFAULT).toBe(50);
  });

  it("delivers source event 102 committed before 101 without a gap", async () => {
    const before = await parsed({ mode: "bootstrap" });
    await project({ events: [{ task_id: 1, role: "qa", type: "approved" }] }, "agent_event:102");
    const afterFirst = await parsed({ mode: "incremental", cursor: before.history.cursor! });
    expect(afterFirst.events.map((e) => e.type)).toEqual(["approved"]);
    await project({ events: [{ task_id: 1, role: "qa", type: "qa_reviewing" }] }, "agent_event:101");
    // Redelivery of either source event changes nothing.
    expect(await project({ events: [{ task_id: 1, role: "qa", type: "approved" }] }, "agent_event:102")).toBeNull();
    const afterSecond = await parsed({ mode: "incremental", cursor: afterFirst.history.cursor! });
    expect(afterSecond.events.map((e) => e.type)).toEqual(["qa_reviewing"]);
    expect(await parsed({ mode: "incremental", cursor: afterSecond.history.cursor! })).toMatchObject({ events: [] });
  });

  it("does not expose rolled-back transitions", async () => {
    const before = await parsed({ mode: "bootstrap" });
    await pg.exec("BEGIN");
    await project({ tasks: [{ task_id: 9, is_private: false, public_title: "Rolled back", state: "queued" }], events: [{ task_id: 9, role: "developer", type: "coding" }] });
    await pg.exec("ROLLBACK");
    const after = await parsed({ mode: "incremental", cursor: before.history.cursor! });
    expect(after.revision).toBe(before.revision);
    expect(after.events).toEqual([]);
    expect(JSON.stringify(after)).not.toContain("Rolled back");
  });

  it("redacts earlier journal entries after a privacy flip and requires an explicit rebind", async () => {
    const before = await parsed({ mode: "bootstrap" });
    expect(JSON.stringify(before)).toContain("Add a health endpoint");
    const oldCursor = before.history.cursor!;
    await project({ tasks: [{ task_id: 1, is_private: true }] });
    const now = await parsed({ mode: "bootstrap" });
    expect(BigInt(now.privacy_epoch)).toBe(BigInt(before.privacy_epoch) + 1n);
    expect(JSON.stringify(now)).not.toContain("Add a health endpoint");
    expect(now.history.replay!.events.filter((e) => e.task_ref === before.history.replay!.events.find((x) => x.description === "Add a health endpoint")?.task_ref).every((e) => e.description === "Private task")).toBe(true);
    const healthRef = now.snapshot.related_tasks![0]!.related_task_ref;
    expect(now.snapshot.related_tasks![0]).toMatchObject({ visibility: "private", description: "Private task" });

    const stale = await parsed({ mode: "incremental", cursor: oldCursor });
    expect(stale.events).toEqual([]);
    expect(stale.history).toMatchObject({
      completeness: "gap", cursor: null, gap: { reason: "privacy_changed", recovery: "rebind", from: decodeOfficeCursor(oldCursor).position },
      invalidations: [{ task_ref: healthRef, kind: "redact" }],
    });
    const rebound = await parsed({ mode: "incremental", cursor: oldCursor, rebind: true });
    expect(rebound.history.invalidations).toEqual([{ task_ref: healthRef, kind: "redact" }]);
    expect(rebound.history.privacy_epoch).toBe(now.privacy_epoch);
    expect(decodeOfficeCursor(rebound.history.cursor).privacy_epoch).toBe(now.privacy_epoch);
    expect(JSON.stringify(rebound)).not.toContain("Add a health endpoint");
  });

  it("answers a cursor of another generation or a future watermark with an explicit restart", async () => {
    const office = await parsed({ mode: "bootstrap" });
    const c = decodeOfficeCursor(office.history.cursor);
    const other = encodeOfficeCursor({ ...c, generation: "gen_0b6d6f53-6a3f-4c1e-9d55-1f7e8a2b3c4d" });
    expect((await parsed({ mode: "incremental", cursor: other })).history.gap).toEqual({ reason: "generation_changed", from: null, through: null, recovery: "restart" });
    const future = encodeOfficeCursor({ ...c, position: { revision: "999", ordinal: 0 }, watermark: { revision: "999", ordinal: 0 } });
    expect((await parsed({ mode: "incremental", cursor: future })).history.gap).toMatchObject({ reason: "cursor_unavailable", recovery: "restart" });
    const epoch = encodeOfficeCursor({ ...c, privacy_epoch: "99" });
    expect((await parsed({ mode: "incremental", cursor: epoch })).history.gap).toMatchObject({ reason: "cursor_unavailable" });
  });

  it("rejects malformed cursors and page sizes before touching the database", async () => {
    const good = (await parsed({ mode: "bootstrap" })).history.cursor!;
    const c = decodeOfficeCursor(good);
    const raw = (body: string) => `cur_${Buffer.from(body).toString("base64url")}`;
    const bad: unknown[] = [
      "", "cur_", "cur_short", `${good}=`, good.replace("cur_", "cux_"), `${good}A`, "cur_" + "A".repeat(600), 42, null,
      raw(`o2.${c.generation.slice(4)}.0.1.0.1.0`),
      raw(`o1.${c.generation.slice(4).toUpperCase()}.0.1.0.1.0`),
      raw("o1.0b6d6f53-6a3f-1c1e-9d55-1f7e8a2b3c4d.0.1.0.1.0"),
      raw(`o1.${c.generation.slice(4)}.0.1.70000.1.70000`),
      raw(`o1.${c.generation.slice(4)}.0.0.1.1.0`),
      raw(`o1.${c.generation.slice(4)}.0.2.0.1.0`),
      raw(`o1.${c.generation.slice(4)}.01.1.0.1.0`),
      raw(`o1.${c.generation.slice(4)}.0.99999999999999999999.0.99999999999999999999.0`),
    ];
    const run = vi.fn();
    for (const cursor of bad) {
      expect(() => decodeOfficeCursor(cursor), String(cursor)).toThrow(OfficeRequestError);
      await expect(loadOfficeProjection({ mode: "incremental", cursor: cursor as string }, run)).rejects.toThrow(OfficeRequestError);
    }
    for (const limit of [0, 51, 1.5, -1]) {
      await expect(loadOfficeProjection({ mode: "incremental", cursor: good, limit }, run)).rejects.toMatchObject({ code: "limit" });
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("state mode returns the snapshot only", async () => {
    const office = await parsed({ mode: "state" });
    expect(office.events).toEqual([]);
    expect(office.history).toMatchObject({ mode: "state", cursor: null, replay: null, from: null, through: null });
  });

  it("loadOfficeProjection returns the parsed envelope, or a content-free unavailable one", async () => {
    const asPublic = <T>(fn: (db: Queryable) => Promise<T>) => runAs(pglitePool(pg), "web_public", fn, { readOnly: true });
    expect(await loadOfficeProjection({ mode: "bootstrap" }, asPublic)).toMatchObject({ available: true, version: 1 });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unavailable = { version: 1, available: false, generation: null, privacy_epoch: null, observed_at: null, revision: null, snapshot: null, events: [], history: null, capabilities: null };
    expect(await loadOfficeProjection({ mode: "bootstrap" }, () => Promise.reject(new DbNotConfiguredError("no db")))).toEqual(unavailable);
    const err = Object.assign(new Error("connect to secret-host failed"), { code: "ECONNREFUSED" });
    expect(await loadOfficeProjection({ mode: "bootstrap" }, () => Promise.reject(err))).toEqual(unavailable);
    expect(log).toHaveBeenLastCalledWith("[office] Error ECONNREFUSED");
    // Output that fails the unit-1 parser is never served.
    const leaky = async <T>(fn: (db: Queryable) => Promise<T>): Promise<T> => {
      const office = (await asPublic(fn)) as AvailableOffice;
      return { ...office, owner_text: "x" } as T;
    };
    expect(await loadOfficeProjection({ mode: "bootstrap" }, leaky)).toEqual(unavailable);
    expect(log).toHaveBeenLastCalledWith("[office] invalid projection (shape)");
    log.mockRestore();
  });

  it("bounds the public read with a transaction-local 3 s statement timeout", async () => {
    const asPublic = <T>(fn: (db: Queryable) => Promise<T>) => runAs(pglitePool(pg), "web_public", fn, { readOnly: true });
    const seen: string[] = [];
    let inside: string | undefined;
    const traced = <T>(fn: (db: Queryable) => Promise<T>) => asPublic(async (db) => {
      const result = await fn({ query: (sql, params) => { seen.push(sql); return db.query(sql, params); } });
      inside = (await db.query<{ t: string }>("SELECT current_setting('statement_timeout') AS t")).rows[0]!.t;
      return result;
    });
    for (const request of [{ mode: "bootstrap" }, { mode: "state" }] as const) {
      seen.length = 0;
      expect(await loadOfficeProjection(request, traced)).toMatchObject({ available: true });
      expect(seen[0]).toBe("SET LOCAL statement_timeout = '3s'");
      expect(seen).toHaveLength(2);
      expect(inside).toBe("3s");
    }
    // SET LOCAL ends with the read transaction; later transactions on the session are unaffected.
    expect(await asPublic(async (db) => (await db.query<{ t: string }>("SELECT current_setting('statement_timeout') AS t")).rows[0]!.t)).toBe("0");
  });

  it("leaves the five-field public feed untouched", async () => {
    const { rows } = await runAs(pglitePool(pg), "web_public", (db) => db.query("SELECT * FROM v_public_agent_events LIMIT 1"), { readOnly: true });
    expect(rows).toEqual([]);
  });
});
