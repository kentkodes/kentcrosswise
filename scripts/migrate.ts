// Apply SQL migrations from packages/db/migrations.
// Usage: pnpm migrate [--dry-run] [--pglite <dir> | --secret <name> [--skip-if-unset]]
import { migrate } from "@kcw/db";
import { parseArgs } from "./lib/args";
import { DB_HELP, DbNotConfigured, openDb } from "./lib/db";
import { runMain } from "./lib/main";

const args = parseArgs(process.argv.slice(2));

await runMain(async () => {
  if (args.help) {
    console.log(`Usage: pnpm migrate [--dry-run] [db option]\n\n${DB_HELP}`);
    return;
  }
  let opened: Awaited<ReturnType<typeof openDb>>;
  try {
    opened = await openDb(args);
  } catch (err) {
    if (!(err instanceof DbNotConfigured)) throw err;
    // --skip-if-unset (deploy.yml used it until the prod DB was wired, DESIGN §11). A notice in the Actions UI.
    const line = `migrate skipped: ${err.message}`;
    console.log(process.env.GITHUB_ACTIONS === "true" ? `::notice title=Migrations skipped::${line}` : line);
    return;
  }
  const { db, label, close } = opened;
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
