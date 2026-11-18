import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, type SqlClient } from "../src/index";
import { freshDb } from "./helpers";

// 0026: public text inputs per entry (public log slice PL3, DESIGN §4.6). Synthetic text only.
describe("0026 entry_public", () => {
  let pg: PGlite;
  let db: SqlClient;
  const entry = async () =>
    (await db.query<{ id: string }>("INSERT INTO entries (source, raw_text) VALUES ('web', 'synthetic') RETURNING id")).rows[0]!.id;
  beforeAll(async () => {
    ({ pg, db } = await freshDb());
  });
  afterAll(async () => {
    await pg.close();
  });

  it("is migration 0026", async () => {
    expect((await loadMigrations()).find((m) => m.version === "0026")?.name).toBe("entry_public");
  });

  it("stores a proposal with defaults for the owner's terms", async () => {
    const id = await entry();
    await db.query("INSERT INTO entry_public (entry_id, spans_state, people, places) VALUES ($1, 'ok', '{Ann}', '{Cafe Lune}')", [id]);
    const row = (await db.query<{ owner_people: string[]; private_other: boolean }>("SELECT owner_people, private_other FROM entry_public WHERE entry_id = $1", [id])).rows[0]!;
    expect(row).toEqual({ owner_people: [], private_other: false });
  });

  it.each([
    ["an unknown state", "INSERT INTO entry_public (entry_id, spans_state) VALUES ($1, 'nonsense')"],
    ["terms on a failed proposal", "INSERT INTO entry_public (entry_id, spans_state, people) VALUES ($1, 'failed', '{Ann}')"],
    ["private_other on a failed proposal", "INSERT INTO entry_public (entry_id, spans_state, private_other) VALUES ($1, 'timeout', true)"],
    ["more than 50 owner terms", "INSERT INTO entry_public (entry_id, spans_state, owner_people) VALUES ($1, 'ok', array_fill('x'::text, ARRAY[51]))"],
  ])("rejects %s", async (_name, sql) => {
    const id = await entry();
    await expect(db.query(sql, [id])).rejects.toThrow();
  });

  it("is deleted with its entry", async () => {
    const id = await entry();
    await db.query("INSERT INTO entry_public (entry_id, spans_state) VALUES ($1, 'failed')", [id]);
    await db.query("DELETE FROM entries WHERE id = $1", [id]);
    expect((await db.query("SELECT 1 FROM entry_public WHERE entry_id = $1", [id])).rows).toHaveLength(0);
  });

  it("lets web_rw read, insert and update, but not delete; web_public and orch_rw have no access", async () => {
    const id = await entry();
    const as = async (role: string, sql: string) => {
      await db.exec(`BEGIN; SET LOCAL ROLE ${role};`);
      try {
        await db.query(sql, [id]);
      } finally {
        await db.exec("ROLLBACK");
      }
    };
    await as("web_rw", "INSERT INTO entry_public (entry_id, spans_state) VALUES ($1, 'ok')");
    await db.query("INSERT INTO entry_public (entry_id, spans_state) VALUES ($1, 'ok')", [id]);
    await as("web_rw", "UPDATE entry_public SET owner_places = array_append(owner_places, 'x') WHERE entry_id = $1");
    await as("web_rw", "SELECT * FROM entry_public WHERE entry_id = $1");
    await expect(as("web_rw", "DELETE FROM entry_public WHERE entry_id = $1")).rejects.toThrow();
    await expect(as("web_public", "SELECT * FROM entry_public WHERE entry_id = $1")).rejects.toThrow();
    await expect(as("orch_rw", "SELECT * FROM entry_public WHERE entry_id = $1")).rejects.toThrow();
  });
});
