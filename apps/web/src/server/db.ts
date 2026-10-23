// Server-only Postgres access for the web app (DESIGN §3.4). Two roles:
//   web_rw      owner pages (boss console, inbox, pause switches)
//   web_public  public API routes; it can read v_public_agent_events and nothing else
// Every call runs in its own transaction that starts with `SET LOCAL ROLE <role>`, so a query runs
// with that role's grants even when the login user could do more (previews use one Neon URL).
//
// Where the URL comes from (D9: env vars hold names, never values):
//   prod     secret KCW_WEB_SECRET (kcw/prod/web), key db_url (web_rw) or db_url_public (web_public)
//   preview  SSM SecureString named by KCW_DATABASE_URL_PARAM (D21), the same URL for both roles
//   local    preview builds only: KCW_LOCAL_DATABASE_URL (Playwright's local PGlite, e2e/local-db.ts)
// A missing secret, key or value means "not configured" (prod has no DB yet): callers get
// DbNotConfiguredError and degrade to an empty page with a note instead of failing.
import {
  SecretFormatError,
  SecretKeyMissingError,
  SecretNotFoundError,
  defaultSecretStore,
  type SecretStore,
} from "@kcw/secrets";
import pg from "pg";
import type { EnvLike } from "@/auth/settings";

export type DbRole = "web_rw" | "web_public";

/** The query surface handed to callers (a pg client inside the role's transaction, or PGlite in tests). */
export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: R[] }>;
}

export const WEB_SECRET_ENV = "KCW_WEB_SECRET";
export const DEFAULT_WEB_SECRET = "kcw/prod/web";
export const DATABASE_URL_PARAM_ENV = "KCW_DATABASE_URL_PARAM";
export const LOCAL_DATABASE_URL_ENV = "KCW_LOCAL_DATABASE_URL";

const SECRET_KEYS: Record<DbRole, string> = { web_rw: "db_url", web_public: "db_url_public" };

/** The database is not configured for this environment (no secret value, key or URL). */
export class DbNotConfiguredError extends Error {
  override name = "DbNotConfiguredError";
}

const isUnset = (err: unknown) =>
  err instanceof SecretNotFoundError || err instanceof SecretKeyMissingError || err instanceof SecretFormatError;

function checkUrl(url: string, where: string): string {
  const u = url.trim();
  if (!/^postgres(ql)?:\/\/\S+$/.test(u)) throw new DbNotConfiguredError(`${where} is not a postgres:// URL`);
  return u;
}

/**
 * The connection URL for `role`. `preview` is the build kind (KCW_ENV is inlined at build time, so
 * prod builds never take the preview branches). Messages never contain the URL.
 */
export async function resolveDatabaseUrl(
  role: DbRole,
  env: EnvLike,
  store: Pick<SecretStore, "get">,
  preview: boolean,
): Promise<string> {
  if (preview) {
    const local = env[LOCAL_DATABASE_URL_ENV];
    if (local) return checkUrl(local, LOCAL_DATABASE_URL_ENV);
    const param = env[DATABASE_URL_PARAM_ENV];
    if (!param) throw new DbNotConfiguredError(`${DATABASE_URL_PARAM_ENV} is not set`);
    return checkUrl(await readOrUnset(store, param), `parameter ${param}`);
  }
  const name = env[WEB_SECRET_ENV] || DEFAULT_WEB_SECRET;
  const key = SECRET_KEYS[role];
  return checkUrl(await readOrUnset(store, name, key), `secret ${name} key ${key}`);
}

async function readOrUnset(store: Pick<SecretStore, "get">, name: string, key?: string): Promise<string> {
  try {
    const value = key === undefined ? await store.get(name) : await store.get(name, key);
    if (typeof value !== "string") throw new DbNotConfiguredError(`${name} is not a string value`);
    return value;
  } catch (err) {
    if (isUnset(err)) throw new DbNotConfiguredError(`${name}${key ? ` key ${key}` : ""} is not set (${(err as Error).name})`);
    throw err;
  }
}

/** Minimal pg pool surface (tests pass a fake). */
export interface PoolLike {
  connect(): Promise<ClientLike>;
}
export interface ClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(err?: Error | boolean): void;
}

/**
 * Runs `fn` in one transaction as `role`. `readOnly` adds READ ONLY. A connection that fails on
 * BEGIN (e.g. closed by the server while the Lambda was frozen) is dropped and retried once;
 * nothing has run at that point, so the retry is safe.
 */
export async function runAs<T>(
  pool: PoolLike,
  role: DbRole,
  fn: (db: Queryable) => Promise<T>,
  opts: { readOnly?: boolean } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query(opts.readOnly ? "BEGIN READ ONLY" : "BEGIN");
    } catch (err) {
      client.release(true);
      if (attempt < 2) continue;
      throw err;
    }
    try {
      // role is a closed union of constant identifiers, never input.
      await client.query(`SET LOCAL ROLE ${role}`);
      const db: Queryable = {
        query: async <R>(sql: string, params?: readonly unknown[]) => {
          const res = await client.query(sql, params ? [...params] : undefined);
          return { rows: res.rows as R[] };
        },
      };
      const result = await fn(db);
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
}

// ---------------------------------------------------------------- process-wide pools

const urlPromises = new Map<DbRole, Promise<string>>();
const pools = new Map<string, pg.Pool>();

/** One connection per URL: a Lambda instance serves one request at a time, and PGlite has one session. */
function poolFor(url: string): pg.Pool {
  let pool = pools.get(url);
  if (!pool) {
    pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 60_000 });
    // An idle client that dies (server closed it) must not crash the process; the pool drops it.
    pool.on("error", (err) => console.error(`[db] idle client error (${err.name})`));
    pools.set(url, pool);
  }
  return pool;
}

/**
 * `runAs` on the process-wide pool for `role`. The URL is resolved once per process; a failed
 * lookup is not cached, so a secret filled later is picked up by the next request.
 */
export async function withDb<T>(
  role: DbRole,
  fn: (db: Queryable) => Promise<T>,
  opts: { readOnly?: boolean } = {},
): Promise<T> {
  let urlPromise = urlPromises.get(role);
  if (!urlPromise) {
    urlPromise = (async () => {
      // Keep the literal comparison: Next inlines KCW_ENV, so prod builds drop the preview branches.
      return resolveDatabaseUrl(role, process.env, defaultSecretStore(), process.env.KCW_ENV === "preview");
    })();
    urlPromises.set(role, urlPromise);
    urlPromise.catch(() => urlPromises.delete(role));
  }
  return runAs(poolFor(await urlPromise), role, fn, opts);
}

/** One log line for a DB failure: error class and SQLSTATE only (messages may hold hosts or data). */
export function dbErrorLabel(err: unknown): string {
  if (!(err instanceof Error)) return "error";
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? `${err.name} ${code}` : err.name;
}
