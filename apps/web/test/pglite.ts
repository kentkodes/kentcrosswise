// Test helper: a migrated (and optionally seeded) in-memory Postgres, plus a PoolLike over it so
// the production `runAs` path (BEGIN, SET LOCAL ROLE, COMMIT) runs unchanged.
import { PGlite } from "@electric-sql/pglite";
import { fromPglite, migrate } from "@kcw/db";
import { seedDemo } from "@kcw/db/seeds";
import type { PoolLike } from "../src/server/db";

export async function freshDb(opts: { seed?: boolean } = {}): Promise<PGlite> {
  const pg = new PGlite();
  const db = fromPglite(pg);
  await migrate(db);
  if (opts.seed) await seedDemo(db, { seed: "web-test", days: 3, contacts: 3 });
  return pg;
}

/** One "connection" = the PGlite session (it has only one). */
export function pglitePool(pg: PGlite): PoolLike & { released: (Error | boolean | undefined)[] } {
  const released: (Error | boolean | undefined)[] = [];
  return {
    released,
    connect: async () => ({
      query: async (sql: string, params?: unknown[]) => {
        const res = await pg.query(sql, params);
        return { rows: res.rows };
      },
      release: (err?: Error | boolean) => void released.push(err),
    }),
  };
}
