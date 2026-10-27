// Test-only: reuse the @kcw/db PGlite helper by path so @kcw/essays needs no new dependency.
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "../src/db";
import { freshDb } from "../../db/test/helpers";

export async function essaysDb(): Promise<{ pg: PGlite; db: Db }> {
  return freshDb();
}

/** Inserts a source and returns its uuid. `crawl_rules` is the snake_case jsonb of the design. */
export async function addSource(
  db: Db,
  slug: string,
  baseUrl: string,
  crawlRules: Record<string, unknown> = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO sources (name, base_url, slug, crawl_rules) VALUES ($1, $2, $3, $4::jsonb) RETURNING id",
    [slug, baseUrl, slug, JSON.stringify(crawlRules)],
  );
  return (rows[0] as { id: string }).id;
}
