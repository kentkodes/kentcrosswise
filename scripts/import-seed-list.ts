// Import docs/essays/SEED-LIST.json into seed_items as approved rows. Idempotent; metadata only.
// Prints read-only before/after counts. Any non-PGlite target needs --confirm.
// Usage: pnpm import-seed-list [--file <path>] [--confirm] [--pglite <dir> | --secret <name>]
import { loadSeedList } from "@kcw/db/seed-list";
import { parseArgs } from "./lib/args";
import { DB_HELP, openDb } from "./lib/db";
import { runMain } from "./lib/main";
import { formatSeedImport, runSeedImport } from "./lib/seed-import";
import { assertWriteAllowed } from "./lib/write-guard";

const args = parseArgs(process.argv.slice(2));

await runMain(async () => {
  if (args.help) {
    console.log(`Usage: pnpm import-seed-list [--file <path>] [--confirm] [db option]\n\n--confirm  required for any target other than --pglite\n\n${DB_HELP}`);
    return;
  }
  assertWriteAllowed(args, "import-seed-list");
  const entries = await loadSeedList(typeof args.file === "string" ? args.file : undefined);
  const { db, label, close } = await openDb(args);
  try {
    for (const line of formatSeedImport(label, await runSeedImport(db, entries))) console.log(line);
  } finally {
    await close();
  }
});
