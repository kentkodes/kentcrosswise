// Restore rehearsal (AR8a): checks that a restored, isolated database is usable by the application.
// Read-only apart from the runner's `CREATE TABLE IF NOT EXISTS schema_migrations` that its dry run issues.
// Output is counts and migration versions only, never row content or a connection string.
import { loadMigrations, migrate, type Migration, type SqlClient } from "@kcw/db";
import type { ParsedArgs } from "./args";

/** Tables read by the rehearsal: the hub, the essays and the agent system. Fixed, so the output is predictable. */
export const REHEARSAL_TABLES = [
  "entries",
  "todos",
  "ideas",
  "projects",
  "contacts",
  "essays",
  "sources",
  "ratings",
  "tasks",
  "agent_events",
  "agent_runs",
  "usage_events",
] as const;

export interface RehearsalReport {
  ok: boolean;
  /** Migration files on disk. */
  onDisk: number;
  /** Versions recorded in the database with a matching checksum. */
  recorded: number;
  /** Versions on disk that the database has not applied. */
  pending: string[];
  /** Row counts by table (a table that could not be read is absent). */
  counts: Record<string, number>;
  /** One line per failure, no row content. */
  failures: string[];
}

/**
 * How the rehearsal decides it is not looking at production: it needs the explicit `--isolated` flag
 * (the operator states the URL points at a restored branch), and it refuses any `--secret` whose name is
 * a production secret (a path segment `prod`, e.g. `kcw/prod/migrator`). `--pglite` is always local, so it
 * needs neither. A bare `DATABASE_URL` cannot be inspected for its host, so for it the flag is the only guard.
 */
export function assertIsolatedTarget(args: ParsedArgs): void {
  if (typeof args.pglite === "string") return;
  if (typeof args.secret === "string" && /(^|[/_.-])prod(uction)?([/_.-]|$)/i.test(args.secret)) {
    throw new Error("refusing to run: the secret name looks like production");
  }
  if (args.isolated !== true) {
    throw new Error("refusing to run without --isolated (state that the database is a restored, isolated copy)");
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message.split("\n")[0] ?? err.name;
  return "unknown failure";
}

export async function rehearse(
  db: SqlClient,
  opts: { migrations?: Migration[]; tables?: readonly string[] } = {},
): Promise<RehearsalReport> {
  const migrations = opts.migrations ?? (await loadMigrations());
  const tables = opts.tables ?? REHEARSAL_TABLES;
  const report: RehearsalReport = { ok: false, onDisk: migrations.length, recorded: 0, pending: [], counts: {}, failures: [] };

  // The runner's dry run throws if a recorded migration was edited or is missing on disk.
  try {
    const res = await migrate(db, { migrations, dryRun: true });
    report.recorded = res.alreadyApplied.length;
    report.pending = res.applied;
    if (res.applied.length > 0) report.failures.push(`pending migrations: ${res.applied.join(", ")}`);
  } catch (err) {
    report.failures.push(`migrations: ${describeError(err)}`);
  }

  for (const table of tables) {
    try {
      const { rows } = await db.query<{ n: string | number }>(`SELECT count(*) AS n FROM "${table}"`);
      report.counts[table] = Number(rows[0]?.n ?? 0);
    } catch (err) {
      report.failures.push(`read ${table}: ${describeError(err)}`);
    }
  }

  report.ok = report.failures.length === 0;
  return report;
}

export function formatReport(r: RehearsalReport): string[] {
  const lines = [`migrations: ${r.recorded} recorded of ${r.onDisk} on disk, ${r.pending.length} pending`];
  for (const [table, n] of Object.entries(r.counts)) lines.push(`${table}: ${n}`);
  for (const f of r.failures) lines.push(`FAIL ${f}`);
  lines.push(r.ok ? "restore rehearsal passed" : "restore rehearsal FAILED");
  return lines;
}
