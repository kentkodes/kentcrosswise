import { PGlite } from "@electric-sql/pglite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fromPg, fromPglite, type SqlClient } from "@kcw/db";
import { getSecret } from "@kcw/secrets";
import pg from "pg";
import type { ParsedArgs } from "./args";

export const DB_HELP = `Database (pick one):
  --pglite <dir>         local PGlite data directory (created if missing); never touches a real DB
  --secret <name>        read the URL from a secret (key db_url; "/..." names are SSM parameters)
  (default)              the DATABASE_URL environment variable`;

/**
 * Opens the database chosen by the CLI flags. The URL is never printed.
 * Returns a SqlClient and a close function.
 */
export async function openDb(args: ParsedArgs): Promise<{ db: SqlClient; label: string; close: () => Promise<void> }> {
  if (typeof args.pglite === "string") {
    // pnpm runs scripts from scripts/; resolve relative paths against where the user ran pnpm.
    const dir = resolve(process.env.INIT_CWD ?? process.cwd(), args.pglite);
    mkdirSync(dir, { recursive: true });
    const lite = new PGlite(dir);
    return { db: fromPglite(lite), label: `PGlite (${args.pglite})`, close: () => lite.close() };
  }
  let url: string | undefined;
  let label: string;
  if (typeof args.secret === "string") {
    url = args.secret.startsWith("/") ? String(await getSecret(args.secret)) : await getSecret(args.secret, "db_url");
    label = `secret ${args.secret}`;
  } else {
    url = process.env.DATABASE_URL;
    label = "DATABASE_URL";
  }
  if (!url) throw new Error("No database: pass --pglite <dir>, --secret <name>, or set DATABASE_URL");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return { db: fromPg(client), label, close: () => client.end() };
}
