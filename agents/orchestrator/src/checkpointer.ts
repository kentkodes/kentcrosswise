// Postgres checkpointer in schema `lg` (DESIGN §3). Migration 0002 creates the schema and grants
// orch_rw USAGE + CREATE on it; the checkpointer creates its own tables there, owned by orch_rw.
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";

export const CHECKPOINT_SCHEMA = "lg";

/** A checkpointer on an existing pool (tests, or a pool with custom settings). */
export function checkpointerFromPool(pool: pg.Pool): PostgresSaver {
  return new PostgresSaver(pool, undefined, { schema: CHECKPOINT_SCHEMA });
}

/**
 * One connection: a Lambda instance handles one message at a time (batch size 1), and the
 * checkpointer's transactions each take a pooled client.
 */
export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 1 });
}

const CREATE_SCHEMA_SQL = `CREATE SCHEMA IF NOT EXISTS "${CHECKPOINT_SCHEMA}"`;

export class CheckpointSchemaMissingError extends Error {
  override name = "CheckpointSchemaMissingError";
  constructor() {
    super(`schema ${CHECKPOINT_SCHEMA} does not exist: run the DB migrations (0002) first`);
  }
}

/**
 * Creates or migrates the checkpointer tables in `lg` as orch_rw.
 *
 * `PostgresSaver.setup()` starts with `CREATE SCHEMA IF NOT EXISTS "lg"`. Postgres checks CREATE
 * on the *database* before it looks for an existing schema, so that statement fails for orch_rw
 * ("permission denied for database") even though the schema exists. Instead of granting orch_rw
 * CREATE on the database, setup runs on a pool whose clients skip exactly that statement after
 * checking that the schema exists. All other setup statements (tables, the library's own
 * migrations table) run unchanged.
 */
export async function setupCheckpointer(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ ok: number }>("SELECT 1 AS ok FROM pg_namespace WHERE nspname = $1", [
    CHECKPOINT_SCHEMA,
  ]);
  if (rows.length === 0) throw new CheckpointSchemaMissingError();

  const skipCreateSchema = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (text: string, values?: unknown[]) =>
          text.trim() === CREATE_SCHEMA_SQL ? Promise.resolve({ rows: [], rowCount: 0 }) : client.query(text, values),
        release: (err?: Error | boolean) => client.release(err),
      };
    },
  };
  await checkpointerFromPool(skipCreateSchema as unknown as pg.Pool).setup();
}
