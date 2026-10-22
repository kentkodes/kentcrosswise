/** Package name, used by the workspace smoke test. */
export const PACKAGE_NAME = "@kcw/db";

export { fromPg, fromPglite, type PgClientLike, type PgliteLike, type SqlClient } from "./client";
export {
  MIGRATIONS_DIR,
  MigrationError,
  checksumOf,
  loadMigrations,
  migrate,
  type MigrateOptions,
  type MigrateResult,
  type Migration,
} from "./runner";
