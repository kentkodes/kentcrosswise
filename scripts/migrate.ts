// Apply SQL migrations from packages/db/migrations.
// Usage: pnpm migrate [--dry-run] [--pglite <dir> | --secret <name>]
import { migrate } from "@kcw/db";
import { parseArgs } from "./lib/args";
import { DB_HELP, openDb } from "./lib/db";
import { runMain } from "./lib/main";

const args = parseArgs(process.argv.slice(2));

await runMain(async () => {
  if (args.help) {
    console.log(`Usage: pnpm migrate [--dry-run] [db option]\n\n${DB_HELP}`);
    return;
  }
  const { db, label, close } = await openDb(args);
  try {
    const dryRun = args["dry-run"] === true;
    const res = await migrate(db, { dryRun, log: (line) => console.log(line) });
    console.log(
      `${label}: ${res.applied.length} ${dryRun ? "pending" : "applied"}, ${res.alreadyApplied.length} already applied`,
    );
  } finally {
    await close();
  }
});
