// Restores the candidate's plain-SQL dump (preview-db.sql) into the preview Neon branch.
// Usage: pnpm restore-preview-db --file <preview-db.sql>      env DATABASE_URL (the branch)
// Why not psql: psql runs backslash meta-commands (a `\!` line runs a shell command), so a hostile dump
// would execute code in the credentialed job. node-postgres sends the text as one simple query: it is SQL
// or an error, and one query string is one implicit transaction, so a failure restores nothing.
// The dump comes from `pg_dump --inserts` (no COPY ... FROM stdin, which a simple query cannot carry).
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { parseArgs } from "./lib/args";
import { checkDbDump, prepareDumpForRestore } from "./lib/candidate-artifact";
import { runMain } from "./lib/main";

const args = parseArgs(process.argv.slice(2));

await runMain(async () => {
  if (typeof args.file !== "string") throw new Error("Usage: pnpm restore-preview-db --file <preview-db.sql>");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const data = readFileSync(path.resolve(process.env.INIT_CWD ?? process.cwd(), args.file));
  checkDbDump(data);
  const sql = prepareDumpForRestore(data.toString("utf8"));
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
  console.log("restore-preview-db: restored");
});
