// Import docs/essays/SEED-LIST.json into seed_items as approved rows. Idempotent; metadata only.
// Usage: pnpm import-seed-list [--file <path>] [--pglite <dir> | --secret <name>]
import { importSeedList, loadSeedList } from "@kcw/db/seed-list";
import { parseArgs } from "./lib/args";
import { DB_HELP, openDb } from "./lib/db";
import { runMain } from "./lib/main";

const args = parseArgs(process.argv.slice(2));

await runMain(async () => {
  if (args.help) {
    console.log(`Usage: pnpm import-seed-list [--file <path>] [db option]\n\n${DB_HELP}`);
    return;
  }
  const entries = await loadSeedList(typeof args.file === "string" ? args.file : undefined);
  const { db, label, close } = await openDb(args);
  try {
    const inserted = await importSeedList(db, entries);
    console.log(`${label}: ${entries.length} entries, ${inserted} inserted`);
  } finally {
    await close();
  }
});
