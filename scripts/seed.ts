// Insert the synthetic seed (@kcw/demo-data) into a migrated database. Idempotent.
// Usage: pnpm seed [--seed <string>] [--days <n>] [--pglite <dir> | --secret <name>]
import { seedDemo } from "@kcw/db/seeds";
import { parseArgs } from "./lib/args";
import { DB_HELP, openDb } from "./lib/db";
import { runMain } from "./lib/main";

const args = parseArgs(process.argv.slice(2));

await runMain(async () => {
  if (args.help) {
    console.log(`Usage: pnpm seed [--seed <string>] [--days <n>] [db option]\n\n${DB_HELP}`);
    return;
  }
  const { db, label, close } = await openDb(args);
  try {
    const { inserted } = await seedDemo(db, {
      ...(typeof args.seed === "string" && { seed: args.seed }),
      ...(typeof args.days === "string" && { days: Number(args.days) }),
    });
    const total = Object.values(inserted).reduce((a, b) => a + b, 0);
    console.log(`${label}: inserted ${total} rows`, inserted);
  } finally {
    await close();
  }
});
