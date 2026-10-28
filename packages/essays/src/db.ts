/**
 * The slice of `SqlClient` (@kcw/db) the pipeline code needs. A structural copy, so this package
 * takes no dependency on @kcw/db; a SqlClient is assignable to it.
 */
export interface Db {
  query<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: R[] }>;
}
