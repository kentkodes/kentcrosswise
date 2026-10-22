import { PGlite } from "@electric-sql/pglite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fromPg, fromPglite, type SqlClient } from "@kcw/db";
import { getSecret, SecretFormatError, SecretKeyMissingError, SecretNotFoundError } from "@kcw/secrets";
import pg from "pg";
import type { ParsedArgs } from "./args";

export const DB_HELP = `Database (pick one):
  --pglite <dir>         local PGlite data directory (created if missing); never touches a real DB
  --secret <name>        read the URL from a secret (key db_url; "/..." names are SSM parameters)
  (default)              the DATABASE_URL environment variable
  --skip-if-unset        with --secret: if the secret has no value, no db_url key or no postgres URL,
                         print a notice and do nothing (exit 0). Access errors still fail.`;

/** Thrown by openDb when --skip-if-unset applies; the scripts turn it into a notice. */
export class DbNotConfigured extends Error {}

/**
 * Reads a postgres URL through `read`. With `optional`, a missing secret, value or key, or a value
 * that is not a postgres URL becomes DbNotConfigured; other errors (permissions, network) pass through.
 * Messages never include the value.
 */
export async function readDbUrl(name: string, read: () => Promise<string>, optional: boolean): Promise<string> {
  let url: string;
  try {
    url = await read();
  } catch (err) {
    const unset = err instanceof SecretNotFoundError || err instanceof SecretKeyMissingError || err instanceof SecretFormatError;
    if (optional && unset) throw new DbNotConfigured(`secret ${name} has no usable db_url (${err.name})`);
    throw err;
  }
  if (!/^postgres(ql)?:\/\/\S+$/.test(url.trim())) {
    if (optional) throw new DbNotConfigured(`secret ${name} has no usable db_url (not a postgres:// URL)`);
    throw new Error(`secret ${name}: db_url is not a postgres:// URL`);
  }
  return url.trim();
}

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
    const name = args.secret;
    url = await readDbUrl(
      name,
      async () => (name.startsWith("/") ? String(await getSecret(name)) : await getSecret(name, "db_url")),
      args["skip-if-unset"] === true,
    );
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
