// Derived records and capture recovery (AR7): one derived row per routed entry, moves on reassignment,
// no duplicates on retry, and failed or never-attempted entries stay listed and retryable.
// PGlite and FakeProvider only.
import type { PGlite } from "@electric-sql/pglite";
import { FakeProvider } from "@kcw/core/models";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { entryStatus, listRecentEntries, listUnresolvedEntries, saveEntry } from "../src/server/capture";
import { runAs } from "../src/server/db";
import { applyRoute } from "../src/server/derived";
import { reassignEntry, routeEntry, type DbRun } from "../src/server/router";
import { freshDb, pglitePool } from "./pglite";

describe("derived records and capture recovery (web_rw on PGlite)", () => {
  let pg: PGlite;
  const run: DbRun = (fn) => runAs(pglitePool(pg), "web_rw", fn);
  const q = <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => pg.query<R>(sql, params);
  const good = (label: string, confidence = 0.9) => new FakeProvider({ classify: { label, confidence } });

  beforeAll(async () => {
    pg = await freshDb();
  });
  afterAll(async () => {
    await pg.close();
  });

  const newEntry = (text: string) => run((db) => saveEntry(db, text));
  async function derivedRows(id: string): Promise<string[]> {
    const out: string[] = [];
    for (const t of ["crm_notes", "diary_entries", "todos", "ideas"]) {
      const { rows } = await q(`SELECT 1 FROM ${t} WHERE entry_id = $1`, [id]);
      if (rows.length > 0) out.push(t);
    }
    return out;
  }

  it("a model route creates exactly one derived row of the kind (crm_note: raw text, link_status none)", async () => {
    const id = await newEntry("Sam said the plan works");
    await routeEntry(run, id, good("crm_note"));
    const { rows } = await q<{ body: string; link_status: string }>("SELECT body, link_status FROM crm_notes WHERE entry_id = $1", [id]);
    expect(rows).toEqual([{ body: "Sam said the plan works", link_status: "none" }]);
    expect(await derivedRows(id)).toEqual(["crm_notes"]);
  });

  it("a diary row takes written_at from the entry's created_at; todo and idea rows hold the text", async () => {
    const d = await newEntry("Long day, good dinner");
    await q("UPDATE entries SET created_at = '2021-03-04T05:06:07Z' WHERE id = $1", [d]);
    await routeEntry(run, d, good("diary"));
    const diary = await q<{ body: string; written_at: Date }>("SELECT body, written_at FROM diary_entries WHERE entry_id = $1", [d]);
    expect(diary.rows[0]!.body).toBe("Long day, good dinner");
    expect(new Date(diary.rows[0]!.written_at).toISOString()).toBe("2021-03-04T05:06:07.000Z");

    const t = await newEntry("Buy stamps");
    await routeEntry(run, t, good("todo"));
    expect((await q<{ body: string }>("SELECT body FROM todos WHERE entry_id = $1", [t])).rows).toEqual([{ body: "Buy stamps" }]);
    const i = await newEntry("A tiny tool idea");
    await routeEntry(run, i, good("idea"));
    expect((await q<{ body: string }>("SELECT body FROM ideas WHERE entry_id = $1", [i])).rows).toEqual([{ body: "A tiny tool idea" }]);
  });

  it("agent_request and a needs-you entry create nothing; the owner's choice then creates the row", async () => {
    const a = await newEntry("Add a page to the site");
    await routeEntry(run, a, good("agent_request"));
    expect(await derivedRows(a)).toEqual([]);

    const n = await newEntry("Unsure entry");
    await routeEntry(run, n, good("todo", 0.3));
    expect(await derivedRows(n)).toEqual([]);
    await run((db) => reassignEntry(db, n, "todo"));
    expect(await derivedRows(n)).toEqual(["todos"]);
  });

  it("reassignment moves the edited body to a new row, deletes the old row and keeps raw_text", async () => {
    const id = await newEntry("Call Sam tomorrow");
    await routeEntry(run, id, good("todo"));
    await q("UPDATE todos SET body = 'Call Sam tomorrow (edited)' WHERE entry_id = $1", [id]);
    await run((db) => reassignEntry(db, id, "crm_note"));
    expect(await derivedRows(id)).toEqual(["crm_notes"]);
    expect((await q<{ body: string }>("SELECT body FROM crm_notes WHERE entry_id = $1", [id])).rows[0]!.body).toBe("Call Sam tomorrow (edited)");
    expect((await q<{ raw_text: string }>("SELECT raw_text FROM entries WHERE id = $1", [id])).rows[0]!.raw_text).toBe("Call Sam tomorrow");
  });

  it("moving to agent_request removes the row; moving back creates one from the raw text", async () => {
    const id = await newEntry("Idea or request");
    await routeEntry(run, id, good("idea"));
    await run((db) => reassignEntry(db, id, "agent_request"));
    expect(await derivedRows(id)).toEqual([]);
    await run((db) => reassignEntry(db, id, "diary"));
    expect(await derivedRows(id)).toEqual(["diary_entries"]);
  });

  it("Save with the unchanged kind of a routed entry is a no-op: a deleted derived row stays deleted", async () => {
    const id = await newEntry("Finished todo");
    await routeEntry(run, id, good("todo"));
    await q("DELETE FROM todos WHERE entry_id = $1", [id]);
    await run((db) => reassignEntry(db, id, "todo"));
    expect(await derivedRows(id)).toEqual([]);
    const { rows } = await q<{ routed_by: string }>("SELECT routed_by FROM entries WHERE id = $1", [id]);
    expect(rows).toEqual([{ routed_by: "model" }]);
    expect((await q("SELECT 1 FROM route_corrections WHERE entry_id = $1", [id])).rows).toHaveLength(0);
  });

  it("confirming the guessed kind of a needs-you entry still creates its row and marks the owner route", async () => {
    const id = await newEntry("Guess confirmed");
    await routeEntry(run, id, good("idea", 0.3));
    await run((db) => reassignEntry(db, id, "idea"));
    expect(await derivedRows(id)).toEqual(["ideas"]);
    const { rows } = await q<{ routed_by: string; status: string }>("SELECT routed_by, status FROM entries WHERE id = $1", [id]);
    expect(rows).toEqual([{ routed_by: "owner", status: "routed" }]);
  });

  it("moving an edited todo to agent_request discards the row (edits included) and keeps raw_text", async () => {
    const id = await newEntry("Raw todo text");
    await routeEntry(run, id, good("todo"));
    await q("UPDATE todos SET body = 'edited body' WHERE entry_id = $1", [id]);
    await run((db) => reassignEntry(db, id, "agent_request"));
    expect(await derivedRows(id)).toEqual([]);
    expect((await q<{ raw_text: string }>("SELECT raw_text FROM entries WHERE id = $1", [id])).rows[0]!.raw_text).toBe("Raw todo text");
  });

  it("a retry never duplicates: applyRoute twice and the unique index", async () => {
    const id = await newEntry("Twice");
    const first = await run((db) => applyRoute(db, id, null, "todo"));
    expect(first).toMatchObject({ kind: "todo" });
    await expect(run((db) => applyRoute(db, id, null, "todo"))).resolves.toBeNull();
    await expect(run((db) => applyRoute(db, id, "todo", "todo"))).resolves.toBeNull();
    expect((await q("SELECT 1 FROM todos WHERE entry_id = $1", [id])).rows).toHaveLength(1);
    // Same-kind reassignment by the owner is a no-op for the derived row.
    await run((db) => reassignEntry(db, id, "todo"));
    expect((await q("SELECT 1 FROM todos WHERE entry_id = $1", [id])).rows).toHaveLength(1);
  });

  it("an owner correction made during the model call wins, keeps the raw text and has exactly one derived row", async () => {
    const id = await newEntry("Owner wins");
    const provider = new FakeProvider({
      classify: async () => {
        await run((db) => reassignEntry(db, id, "diary"));
        return { label: "todo", confidence: 0.95 };
      },
    });
    await expect(routeEntry(run, id, provider)).resolves.toEqual({ code: "already" });
    expect(await derivedRows(id)).toEqual(["diary_entries"]);
    const { rows } = await q<{ raw_text: string; route_kind: string; routed_by: string }>(
      "SELECT raw_text, route_kind, routed_by FROM entries WHERE id = $1",
      [id],
    );
    expect(rows).toEqual([{ raw_text: "Owner wins", route_kind: "diary", routed_by: "owner" }]);
  });

  it("failures store a fixed code, the attempt count and the time, and never text or provider messages", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const id = await newEntry("secret entry text");
    await routeEntry(run, id, new FakeProvider({ classify: new Error("provider echo: secret entry text") }));
    let row = (await q<{ route_error: string; route_attempts: number; route_attempted_at: Date | null }>(
      "SELECT route_error, route_attempts, route_attempted_at FROM entries WHERE id = $1",
      [id],
    )).rows[0]!;
    expect(row.route_error).toBe("provider_error");
    expect(row.route_attempts).toBe(1);
    expect(row.route_attempted_at).not.toBeNull();

    await routeEntry(run, id, good("project"));
    row = (await q<{ route_error: string; route_attempts: number; route_attempted_at: Date | null }>(
      "SELECT route_error, route_attempts, route_attempted_at FROM entries WHERE id = $1",
      [id],
    )).rows[0]!;
    expect(row).toMatchObject({ route_error: "invalid_label", route_attempts: 2 });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");

    await routeEntry(run, id, good("todo"));
    expect((await q<{ route_error: string | null; route_attempts: number }>("SELECT route_error, route_attempts FROM entries WHERE id = $1", [id])).rows).toEqual([
      { route_error: null, route_attempts: 3 },
    ]);
    expect(await derivedRows(id)).toEqual(["todos"]);
    log.mockRestore();
  });

  it("the spend cap is stored as spend_cap and shown as paused", async () => {
    await q(
      "INSERT INTO usage_events (kind, agent, provider, model, input_tokens, output_tokens, cost_usd) VALUES ('model', 'orchestrator', 'deepseek', 'deepseek-flash', 1, 1, 50)",
    );
    try {
      const id = await newEntry("Capped entry");
      await routeEntry(run, id, good("todo"));
      const [row] = (await run((db) => listUnresolvedEntries(db))).filter((e) => e.id === id);
      expect(row).toMatchObject({ routeError: "spend_cap", routeAttempts: 1 });
      expect(entryStatus(row!).label).toBe("Routing paused: spend cap");
    } finally {
      await q("DELETE FROM usage_events WHERE agent = 'orchestrator'");
    }
  });

  it("more than ten failed captures and a never-attempted one stay listed, oldest first, and can be retried", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ids: string[] = [];
    for (let n = 0; n < 12; n++) {
      const id = await newEntry(`backlog ${n}`);
      await q("UPDATE entries SET created_at = $2 WHERE id = $1", [id, new Date(Date.UTC(2020, 0, 1, 0, n)).toISOString()]);
      ids.push(id);
      await routeEntry(run, id, new FakeProvider({ classify: new Error("down") }));
    }
    const never = await newEntry("saved just before a crash");
    await q("UPDATE entries SET created_at = '2020-01-02T00:00:00Z' WHERE id = $1", [never]);
    log.mockRestore();

    const unresolved = await run((db) => listUnresolvedEntries(db));
    const mine = unresolved.filter((e) => [...ids, never].includes(e.id));
    expect(mine.map((e) => e.id)).toEqual([...ids, never]);
    expect(mine.slice(0, 12).every((e) => entryStatus(e).label === "Routing failed")).toBe(true);
    expect(mine[12]).toMatchObject({ routeError: null, routeAttempts: 0 });
    expect(entryStatus(mine[12]!).label).toBe("Waiting for router");
    // The latest-ten list cannot hold them all.
    expect(await run((db) => listRecentEntries(db))).toHaveLength(10);

    // Retry one failed and the never-attempted one; the third is corrected by the owner.
    await expect(routeEntry(run, ids[0]!, good("idea"))).resolves.toMatchObject({ code: "routed", kind: "idea" });
    await expect(routeEntry(run, never, good("todo"))).resolves.toMatchObject({ code: "routed", kind: "todo" });
    await run((db) => reassignEntry(db, ids[1]!, "diary"));
    const after = (await run((db) => listUnresolvedEntries(db))).map((e) => e.id);
    expect(after).not.toContain(ids[0]);
    expect(after).not.toContain(never);
    expect(after).not.toContain(ids[1]);
    expect(after).toContain(ids[2]);
  });

  it("a needs-you entry is unresolved and shows Needs you; a routed one is not listed", async () => {
    const n = await newEntry("Needs me");
    await routeEntry(run, n, good("idea", 0.2));
    const r = await newEntry("Routed fine");
    await routeEntry(run, r, good("idea"));
    const list = await run((db) => listUnresolvedEntries(db));
    expect(list.find((e) => e.id === n)).toBeDefined();
    expect(entryStatus(list.find((e) => e.id === n)!).label).toBe("Needs you");
    expect(list.find((e) => e.id === r)).toBeUndefined();
  });
});
