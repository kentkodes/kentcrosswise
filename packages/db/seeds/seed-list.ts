// Imports docs/essays/SEED-LIST.json (owner-approved essay metadata, no URLs, no text) into seed_items.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { SqlClient } from "../src/client";

export const SEED_LIST_PATH = fileURLToPath(new URL("../../../docs/essays/SEED-LIST.json", import.meta.url));

export interface SeedListEntry {
  title: string;
  author: string;
  year: string;
  type: string;
  evidence: "direct" | "weak";
  public_domain_likely: boolean | null;
  batch: string;
  access: string;
  length: string;
}

export async function loadSeedList(path: string = SEED_LIST_PATH): Promise<SeedListEntry[]> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as { entries?: SeedListEntry[] };
  if (!Array.isArray(parsed.entries)) throw new Error("Seed list has no entries array");
  return parsed.entries;
}

/** Stable identity of a listed entry; the import conflicts on it. */
export function seedListKey(e: Pick<SeedListEntry, "title" | "author">): string {
  return createHash("sha256").update(`${e.title}|${e.author}`).digest("hex");
}

/** "1841" -> 1841; "unknown" or "Original year unresolved" -> null. */
function parseYear(year: string): number | null {
  return /^\d{4}$/.test(year) ? Number(year) : null;
}

/**
 * Inserts the entries as `approved` seed items. Idempotent: an entry already imported (same title and
 * author) is left exactly as it is, so later enrichment in the database is never overwritten.
 * Returns the number of rows inserted. Runs in one transaction.
 */
export async function importSeedList(db: SqlClient, entries: readonly SeedListEntry[]): Promise<number> {
  let inserted = 0;
  await db.exec("BEGIN");
  try {
    for (const e of entries) {
      const res = await db.query(
        `INSERT INTO seed_items
           (title, author, year, status, seed_list_key, category_hint, evidence, public_domain_likely, batch, access, length)
         VALUES ($1, $2, $3, 'approved', $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (seed_list_key) DO NOTHING RETURNING 1`,
        [
          e.title, e.author, parseYear(e.year), seedListKey(e), e.type, e.evidence,
          e.public_domain_likely, e.batch, e.access, e.length,
        ],
      );
      inserted += res.rows.length;
    }
    await db.exec("COMMIT");
  } catch (err) {
    await db.exec("ROLLBACK");
    throw err;
  }
  return inserted;
}
