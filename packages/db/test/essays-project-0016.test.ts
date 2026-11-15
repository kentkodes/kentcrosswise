import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, type SqlClient } from "../src/index";
import { freshDb } from "./helpers";
import type { PGlite } from "@electric-sql/pglite";

// 0016 projects Essays tab: the row is inserted once, with ON CONFLICT DO NOTHING, and nothing else.
describe("0016 essays project", () => {
  let pg: PGlite;
  let db: SqlClient;
  beforeAll(async () => {
    ({ pg, db } = await freshDb());
  });
  afterAll(async () => {
    await pg.close();
  });

  it("is the migration named projects_essays_tab", async () => {
    const m = (await loadMigrations()).find((x) => x.version === "0016");
    expect(m?.name).toBe("projects_essays_tab");
  });

  it("the migration applies on a fresh database and adds the Essays project at sort 0", async () => {
    const { rows } = await db.query<{ slug: string; title: string; sort: number }>(
      "SELECT slug, title, sort FROM projects WHERE slug = 'essays'",
    );
    expect(rows).toEqual([{ slug: "essays", title: "Essays", sort: 0 }]);
  });

  it("does not overwrite an existing essays row when its SQL runs again", async () => {
    await db.query("UPDATE projects SET title = 'Writing', sort = 5 WHERE slug = 'essays'");
    const m = (await loadMigrations()).find((x) => x.version === "0016")!;
    await db.exec(m.sql);
    const { rows } = await db.query<{ title: string; sort: number }>("SELECT title, sort FROM projects WHERE slug = 'essays'");
    expect(rows).toEqual([{ title: "Writing", sort: 5 }]);
  });

  it("the migration is a single INSERT and touches nothing else", async () => {
    const m = (await loadMigrations()).find((x) => x.version === "0016")!;
    const statements = m.sql
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.trim().startsWith("--"));
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^INSERT INTO projects \(slug, title, sort\) VALUES \('essays', 'Essays', 0\) ON CONFLICT DO NOTHING;$/);
  });
});
