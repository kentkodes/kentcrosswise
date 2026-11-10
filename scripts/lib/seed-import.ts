import { countSeedItems, importSeedList, type SeedCounts, type SeedListEntry } from "@kcw/db/seed-list";
import type { SqlClient } from "@kcw/db";

export interface SeedImportReport {
  before: SeedCounts;
  after: SeedCounts;
  entries: number;
  inserted: number;
}

const fmt = (c: SeedCounts) => `total=${c.total} approved=${c.approved} listed=${c.listed}`;

/** Counts, the idempotent single-transaction import, counts again. Output is counts only. */
export async function runSeedImport(db: SqlClient, entries: readonly SeedListEntry[]): Promise<SeedImportReport> {
  const before = await countSeedItems(db);
  const inserted = await importSeedList(db, entries);
  const after = await countSeedItems(db);
  return { before, after, entries: entries.length, inserted };
}

export function formatSeedImport(label: string, r: SeedImportReport): string[] {
  return [`${label}: seed_items before: ${fmt(r.before)}`, `${label}: ${r.entries} entries, ${r.inserted} inserted`, `${label}: seed_items after: ${fmt(r.after)}`];
}
