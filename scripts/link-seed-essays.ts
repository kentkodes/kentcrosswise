// Creates a link-only essay for each approved seed that has none yet (category from the SEED-LIST type, no model).
// Idempotent; prints read-only before/after counts. Any non-PGlite target needs --confirm for a real run.
// --dry-run prints the plan and writes nothing; it needs no --confirm because the session is set read-only.
// Usage: pnpm link-seed-essays [--dry-run] [--confirm] [--pglite <dir> | --secret <name>]
import { loadSeedList } from "@kcw/db/seed-list";
import { parseArgs } from "./lib/args";
import { DB_HELP, openDb } from "./lib/db";
import { runMain } from "./lib/main";
import { formatSeedLinks, runSeedLinks } from "./lib/seed-links";
import { assertWriteAllowed } from "./lib/write-guard";

const args = parseArgs(process.argv.slice(2));

await runMain(async () => {
  if (args.help) {
    console.log(
      `Usage: pnpm link-seed-essays [--dry-run] [--confirm] [db option]\n\n` +
        `--dry-run  print the plan and counts, write nothing (no --confirm needed)\n` +
        `--confirm  required for a real run against any target other than --pglite\n\n${DB_HELP}`,
    );
    return;
  }
  const dryRun = args["dry-run"] === true;
  if (!dryRun) assertWriteAllowed(args, "link-seed-essays");
  const entries = await loadSeedList();
  const { db, label, close } = await openDb(args);
  try {
    if (dryRun) await db.exec("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
    for (const line of formatSeedLinks(label, await runSeedLinks(db, entries, { dryRun }))) console.log(line);
  } finally {
    await close();
  }
});
