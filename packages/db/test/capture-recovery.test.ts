import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, type SqlClient } from "../src/index";
import { freshDb } from "./helpers";

// 0014 capture recovery columns and the derived-record unique indexes.
describe("0014 capture recovery", () => {
  let pg: PGlite;
  let db: SqlClient;
  beforeAll(async () => {
    ({ pg, db } = await freshDb());
  });
  afterAll(async () => {
    await pg.close();
  });

  it("is registered and adds the entry outcome columns with safe defaults", async () => {
    expect((await loadMigrations()).find((x) => x.version === "0014")?.name).toBe("capture_recovery_derived");
    const { rows } = await db.query<{ id: string }>("INSERT INTO entries (source, raw_text) VALUES ('web', 'x') RETURNING id");
    const e = await db.query("SELECT route_error, route_attempts, route_attempted_at FROM entries WHERE id = $1", [rows[0]!.id]);
    expect(e.rows).toEqual([{ route_error: null, route_attempts: 0, route_attempted_at: null }]);
    await expect(db.query("UPDATE entries SET route_error = 'oops'")).rejects.toThrow();
    await expect(db.query("UPDATE entries SET route_attempts = -1")).rejects.toThrow();
  });

  it("allows one derived row per entry in each table, and any number without an entry", async () => {
    const { rows } = await db.query<{ id: string }>("INSERT INTO entries (source, raw_text) VALUES ('web', 'y') RETURNING id");
    const id = rows[0]!.id;
    for (const t of ["crm_notes", "diary_entries", "todos", "ideas"]) {
      await db.query(`INSERT INTO ${t} (entry_id, body) VALUES ($1, 'a')`, [id]);
      await expect(db.query(`INSERT INTO ${t} (entry_id, body) VALUES ($1, 'b')`, [id])).rejects.toThrow();
      await db.query(`INSERT INTO ${t} (entry_id, body) VALUES (NULL, 'c'), (NULL, 'd')`);
    }
  });

  it("web_rw can write the new columns", async () => {
    const { rows } = await db.query<{ ok: boolean }>(
      "SELECT bool_and(has_column_privilege('web_rw', 'entries', c, 'UPDATE')) AS ok FROM unnest(ARRAY['route_error','route_attempts','route_attempted_at']) c",
    );
    expect(rows).toEqual([{ ok: true }]);
  });
});
