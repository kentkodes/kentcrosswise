import { BOT_USER_AGENT } from "../crawl/bot-contact";
import type { Db } from "../db";
import { EXTRACTOR_VERSION } from "../extract/gutenberg-text";
import { CATALOG_URL } from "../discovery/watcher";

export const GUTENBERG_SLUG = "gutenberg";

/**
 * Only what discovery and matching need: the published catalog CSV, and candidate links under
 * /ebooks/ (the watcher checks them against allow_paths). Book bodies are not fetched from the
 * website, so no path for them is allowed.
 */
const GUTENBERG_CRAWL_RULES = {
  min_delay_ms: 3000,
  daily_request_cap: 500,
  allow_paths: ["/ebooks/", "/cache/epub/feeds/"],
  user_agent: BOT_USER_AGENT,
};

/**
 * Registers the Project Gutenberg source. Idempotent: an existing row (including one the owner has
 * edited) is never touched. Returns the row id and whether this call created it.
 */
export async function registerGutenbergSource(db: Db): Promise<{ id: string; inserted: boolean }> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO sources
       (name, slug, base_url, discovery_mode, discovery, extractor_id, extractor_version, crawl_rules, license_policy)
     VALUES ('Project Gutenberg', $1, 'https://www.gutenberg.org', 'seed_targeted', $2::jsonb, 'gutenberg-txt', $3, $4::jsonb, 'pd_only')
     ON CONFLICT (slug) DO NOTHING RETURNING id`,
    [
      GUTENBERG_SLUG,
      JSON.stringify({ kind: "catalog_csv", url: CATALOG_URL }),
      EXTRACTOR_VERSION,
      JSON.stringify(GUTENBERG_CRAWL_RULES),
    ],
  );
  if (rows[0]) return { id: rows[0].id, inserted: true };
  const existing = await db.query<{ id: string }>("SELECT id FROM sources WHERE slug = $1", [GUTENBERG_SLUG]);
  return { id: (existing.rows[0] as { id: string }).id, inserted: false };
}
