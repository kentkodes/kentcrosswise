// Restore rehearsal: is a restored, isolated database usable by the application?
// Usage: pnpm restore-rehearsal --isolated [--secret <name>] (default: DATABASE_URL)
import { parseArgs } from "./lib/args";
import { DB_HELP, openDb } from "./lib/db";
import { runMain } from "./lib/main";
import { assertIsolatedTarget, formatReport, rehearse } from "./lib/restore-rehearsal";

const args = parseArgs(process.argv.slice(2));

await runMain(async () => {
  if (args.help) {
    console.log(
      `Usage: pnpm restore-rehearsal --isolated [db option]\n\n` +
        `Checks a restored database: every migration on disk recorded with a matching checksum and none pending,\n` +
        `and row counts of the hub, essays and agent tables. Prints counts only. Exits 1 on any failure.\n` +
        `Refuses to run without --isolated, and refuses production secret names (kcw/prod/...).\n\n${DB_HELP}`,
    );
    return;
  }
  assertIsolatedTarget(args);
  const { db, label, close } = await openDb(args);
  try {
    console.log(`restore rehearsal on ${label}`);
    const report = await rehearse(db);
    for (const line of formatReport(report)) console.log(line);
    if (!report.ok) process.exitCode = 1;
  } finally {
    await close();
  }
});
