import { PGlite } from "@electric-sql/pglite";
import { fromPglite, migrate, type SqlClient } from "../src/index";

/** A fresh in-memory Postgres with all migrations applied. */
export async function freshDb(): Promise<{ pg: PGlite; db: SqlClient }> {
  const pg = new PGlite();
  const db = fromPglite(pg);
  await migrate(db);
  return { pg, db };
}
