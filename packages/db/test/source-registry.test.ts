import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importSeedList, loadSeedList, seedListKey, type SeedListEntry } from "../seeds/seed-list";
import type { SqlClient } from "../src/index";
import { freshDb } from "./helpers";

describe("0008 source registry", () => {
  let pg: PGlite;
  let db: SqlClient;
  beforeAll(async () => {
    ({ pg, db } = await freshDb());
  });
  afterAll(async () => {
    await pg.close();
  });

  it("imports the 300 approved seed entries once", async () => {
    const entries = await loadSeedList();
    expect(entries).toHaveLength(300);
    expect(await importSeedList(db, entries)).toBe(300);
    expect(await importSeedList(db, entries)).toBe(0);
    const { rows } = await db.query<{ n: string; approved: string; pd: string; unknown_year: string }>(
      `SELECT count(*) AS n, count(*) FILTER (WHERE status = 'approved') AS approved,
              count(*) FILTER (WHERE public_domain_likely) AS pd, count(*) FILTER (WHERE year IS NULL) AS unknown_year
       FROM seed_items`,
    );
    expect(Number(rows[0]?.n)).toBe(300);
    expect(Number(rows[0]?.approved)).toBe(300);
    expect(Number(rows[0]?.pd)).toBe(63);
    expect(Number(rows[0]?.unknown_year)).toBeGreaterThan(0);
  });

  it("does not overwrite an imported row on rerun", async () => {
    const entries = await loadSeedList();
    const first = entries[0] as SeedListEntry;
    await db.query("UPDATE seed_items SET access = 'open' WHERE seed_list_key = $1", [seedListKey(first)]);
    await importSeedList(db, entries);
    const { rows } = await db.query<{ access: string }>("SELECT access FROM seed_items WHERE seed_list_key = $1", [
      seedListKey(first),
    ]);
    expect(rows[0]?.access).toBe("open");
  });

  it("gives sources the registry defaults", async () => {
    await db.query("INSERT INTO sources (name, base_url, slug) VALUES ('Test', 'https://example.com', 'test')");
    const { rows } = await db.query<Record<string, unknown>>("SELECT * FROM sources WHERE slug = 'test'");
    expect(rows[0]).toMatchObject({
      discovery_mode: "seed_targeted",
      license_policy: "pd_only",
      consecutive_failures: 0,
      paused_by: null,
      health: "ok",
      request_count: 0,
    });
  });

  it("allows one approved link per seed and unique candidates", async () => {
    const { rows: s } = await db.query<{ id: string }>("SELECT id FROM seed_items LIMIT 1");
    const { rows: src } = await db.query<{ id: string }>("SELECT id FROM sources WHERE slug = 'test'");
    const ins = (url: string, status: string) =>
      db.query(
        `INSERT INTO seed_source_links (seed_item_id, source_id, candidate_url, candidate_title, candidate_author, tier, score, status)
         VALUES ($1, $2, $3, 't', 'a', 'A', 1, $4)`,
        [s[0]?.id, src[0]?.id, url, status],
      );
    await ins("https://example.com/a", "approved");
    await expect(ins("https://example.com/a", "proposed")).rejects.toThrow(/duplicate key/);
    await expect(ins("https://example.com/b", "approved")).rejects.toThrow(/duplicate key/);
    await ins("https://example.com/b", "proposed");
  });

  it("lets pipeline_rw use the new table", async () => {
    await pg.exec("SET ROLE pipeline_rw");
    try {
      const { rows } = await db.query("SELECT count(*) FROM seed_source_links");
      expect(rows).toHaveLength(1);
    } finally {
      await pg.exec("RESET ROLE");
    }
  });
});
