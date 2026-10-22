/**
 * The minimal SQL surface the runner and seeds need, with adapters for
 * node-postgres (Neon) and PGlite (tests, local). Keep it this small.
 */
export interface SqlClient {
  query<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: R[] }>;
  /** Runs one or more statements without parameters (simple query protocol). */
  exec(sql: string): Promise<void>;
}

/** Structural type of a PGlite instance (avoids importing PGlite in production bundles). */
export interface PgliteLike {
  query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
  exec(sql: string): Promise<unknown>;
}

export function fromPglite(db: PgliteLike): SqlClient {
  return {
    query: async <R>(sql: string, params?: readonly unknown[]) => {
      const res = await db.query<R>(sql, params ? [...params] : undefined);
      return { rows: res.rows };
    },
    exec: async (sql) => {
      await db.exec(sql);
    },
  };
}

/** Structural type of a node-postgres Client (one connection; do not pass a Pool: transactions need one session). */
export interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export function fromPg(client: PgClientLike): SqlClient {
  return {
    query: async <R>(sql: string, params?: readonly unknown[]) => {
      const res = await client.query(sql, params ? [...params] : undefined);
      return { rows: res.rows as R[] };
    },
    exec: async (sql) => {
      await client.query(sql);
    },
  };
}
