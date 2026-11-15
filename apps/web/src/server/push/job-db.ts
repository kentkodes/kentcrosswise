// The inbox-push job's own database access. ../db cannot be used here: it imports the `@/` alias (a type from
// auth/settings), and the job's import graph is bundled into the OpenNext wrapper and type-checked by the
// scripts package, which has no such alias. Same contract as db.ts withDb("web_rw"): one connection, one
// transaction, SET LOCAL ROLE web_rw, URL from the web secret's db_url key (prod only; jobs have no preview).
import { defaultSecretStore } from "@kcw/secrets";
import pg from "pg";

export interface JobQueryable {
  query<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: R[] }>;
}

let pool: pg.Pool | undefined;

async function getPool(): Promise<pg.Pool> {
  if (pool) return pool;
  const name = process.env.KCW_WEB_SECRET || "kcw/prod/web";
  const url = (await defaultSecretStore().get(name, "db_url")).trim();
  if (!/^postgres(ql)?:\/\/\S+$/.test(url)) throw new Error("db_url is not a postgres URL");
  pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 60_000 });
  pool.on("error", (err) => console.error(`[db] idle client error (${err.name})`));
  return pool;
}

export async function withWebRw<T>(fn: (db: JobQueryable) => Promise<T>): Promise<T> {
  const client = await (await getPool()).connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE web_rw");
    const result = await fn({
      query: async <R>(sql: string, params?: readonly unknown[]) => ({
        rows: (await client.query(sql, params ? [...params] : undefined)).rows as R[],
      }),
    });
    await client.query("COMMIT");
    client.release();
    return result;
  } catch (err) {
    let broken = false;
    await client.query("ROLLBACK").catch(() => {
      broken = true;
    });
    client.release(broken);
    throw err;
  }
}
