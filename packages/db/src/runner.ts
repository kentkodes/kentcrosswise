import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlClient } from "./client";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

/** `0001_hub_essays.sql` -> version "0001", name "hub_essays". */
const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** Arbitrary constant key for pg_advisory_lock so two deploys never migrate at once. */
const LOCK_KEY = 74_201_022;

export interface Migration {
  version: string;
  name: string;
  sql: string;
  /** sha256 of the file with CRLF normalized to LF, so a Windows checkout gives the same checksum. */
  checksum: string;
}

export class MigrationError extends Error {
  constructor(
    message: string,
    readonly version?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MigrationError";
  }
}

const BOM = String.fromCharCode(0xfeff);
const stripBom = (s: string) => (s.startsWith(BOM) ? s.slice(1) : s);

export function checksumOf(sql: string): string {
  return createHash("sha256").update(stripBom(sql).replace(/\r\n/g, "\n")).digest("hex");
}

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const seen = new Set<string>();
  const out: Migration[] = [];
  for (const file of files) {
    const m = FILE_RE.exec(file);
    if (!m) throw new MigrationError(`Bad migration file name "${file}" (expected NNNN_name.sql)`);
    const [, version, name] = m as unknown as [string, string, string];
    if (seen.has(version)) throw new MigrationError(`Duplicate migration version ${version}`, version);
    seen.add(version);
    const sql = await readFile(join(dir, file), "utf8");
    out.push({ version, name, sql, checksum: checksumOf(sql) });
  }
  return out;
}

export interface MigrateOptions {
  migrations?: Migration[];
  /** Report what would run without changing anything. */
  dryRun?: boolean;
  log?: (line: string) => void;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Applies pending migrations in order, each in its own transaction, recording them in
 * `schema_migrations`. Idempotent. Fails if an applied migration's file changed or is missing.
 */
export async function migrate(db: SqlClient, opts: MigrateOptions = {}): Promise<MigrateResult> {
  const migrations = opts.migrations ?? (await loadMigrations());
  const log = opts.log ?? (() => {});

  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    text PRIMARY KEY,
    name       text NOT NULL,
    checksum   text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    const { rows } = await db.query<{ version: string; checksum: string }>(
      "SELECT version, checksum FROM schema_migrations ORDER BY version",
    );
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));
    const known = new Set(migrations.map((m) => m.version));
    for (const version of applied.keys()) {
      if (!known.has(version)) {
        throw new MigrationError(`Migration ${version} is applied in the database but missing on disk`, version);
      }
    }

    const result: MigrateResult = { applied: [], alreadyApplied: [] };
    for (const m of migrations) {
      const prev = applied.get(m.version);
      if (prev !== undefined) {
        if (prev !== m.checksum) {
          throw new MigrationError(
            `Migration ${m.version}_${m.name} was edited after it was applied; add a new migration instead`,
            m.version,
          );
        }
        result.alreadyApplied.push(m.version);
        continue;
      }
      if (opts.dryRun) {
        log(`would apply ${m.version}_${m.name}`);
        result.applied.push(m.version);
        continue;
      }
      log(`applying ${m.version}_${m.name}`);
      await db.exec("BEGIN");
      try {
        await db.exec(m.sql);
        await db.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [
          m.version,
          m.name,
          m.checksum,
        ]);
        await db.exec("COMMIT");
      } catch (err) {
        await db.exec("ROLLBACK");
        throw new MigrationError(`Migration ${m.version}_${m.name} failed`, m.version, { cause: err });
      }
      result.applied.push(m.version);
    }
    return result;
  } finally {
    await db.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
  }
}
