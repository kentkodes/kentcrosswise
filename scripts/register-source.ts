// Registers the Project Gutenberg source row (idempotent; an existing row is never changed).
// Prints before/after counts. Any non-PGlite target needs --confirm.
// Usage: pnpm register-source [--confirm] [--pglite <dir> | --secret <name>]
import { parseArgs } from "./lib/args";
import { DB_HELP, openDb } from "./lib/db";
import { runMain } from "./lib/main";
import { formatRegister, runRegisterSource } from "./lib/register-source";
import { assertWriteAllowed } from "./lib/write-guard";

const args = parseArgs(process.argv.slice(2));

await runMain(async () => {
  if (args.help) {
    console.log(`Usage: pnpm register-source [--confirm] [db option]\n\n--confirm  required for any target other than --pglite\n\n${DB_HELP}`);
    return;
  }
  assertWriteAllowed(args, "register-source");
  const { db, label, close } = await openDb(args);
  try {
    for (const line of formatRegister(label, await runRegisterSource(db))) console.log(line);
  } finally {
    await close();
  }
});
