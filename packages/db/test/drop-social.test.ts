import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, type SqlClient } from "../src/index";
import { freshDb } from "./helpers";

// 0024 drops the social tables from 0001 (the owner removed the social feature, 2026-11-17).
describe("0024 drop_social", () => {
  let pg: PGlite;
  let db: SqlClient;
  beforeAll(async () => {
    ({ pg, db } = await freshDb());
  });
  afterAll(async () => {
    await pg.close();
  });

  it("is migration 0024", async () => {
    expect((await loadMigrations()).find((m) => m.version === "0024")?.name).toBe("drop_social");
  });

  it("leaves no social tables after migrating", async () => {
    const { rows } = await db.query<{ t: string | null }>(
      "SELECT to_regclass('public.social_accounts')::text AS t UNION ALL SELECT to_regclass('public.social_snapshots')::text",
    );
    expect(rows.map((r) => r.t)).toEqual([null, null]);
  });
});
