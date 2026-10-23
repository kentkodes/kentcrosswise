// Lambda entry point (handler `index.handler` once bundled; infra/modules/orchestrator).
// Cold start: read the DB URL (and the LangSmith key when tracing is on) from Secrets Manager (D9),
// set up the checkpointer tables in schema lg, build the graph. Warm invocations reuse all of it.
import { SecretKeyMissingError, SecretNotFoundError, SecretStore } from "@kcw/secrets";
import type pg from "pg";
import { checkpointerFromPool, createPool, setupCheckpointer } from "./checkpointer";
import { buildGraph, type TaskGraph } from "./graph";
import { handleSqsEvent, type SqsBatchResponse, type SqsEvent } from "./handler";

/** Env var names (values are secret *names*, set by infra/modules/orchestrator via infra/prod). */
export const ORCHESTRATOR_SECRET_ENV = "KCW_ORCHESTRATOR_SECRET";
export const MODELS_SECRET_ENV = "KCW_MODELS_SECRET";

export interface SecretReader {
  get(name: string, key: string): Promise<string>;
  /** Forget cached values so a failed cold start re-reads them (SecretStore has it). */
  clearCache?(): void;
}

export interface LambdaDeps {
  env: Record<string, string | undefined>;
  secrets: SecretReader;
  makePool?: (connectionString: string) => pg.Pool;
  log?: (line: string) => void;
}

/** Missing or empty configuration (env var or secret value). Its message names the setting, never a value. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

function required(env: LambdaDeps["env"], name: string): string {
  const v = env[name];
  if (!v) throw new ConfigError(`${name} is not set`);
  return v;
}

/**
 * LangSmith reads LANGSMITH_API_KEY from the environment; the key itself lives in the models
 * secret, so it is copied into this process's env at cold start. A models secret without a value,
 * a missing key or an empty key turns tracing off instead of failing every message. Other errors
 * (access denied, malformed secret) still fail the cold start.
 */
async function configureTracing(deps: LambdaDeps, log: (line: string) => void): Promise<void> {
  const { env } = deps;
  if (env.LANGSMITH_TRACING !== "true" || env.LANGSMITH_API_KEY) return;
  let key: string;
  try {
    key = await deps.secrets.get(required(env, MODELS_SECRET_ENV), "langsmith_api_key");
  } catch (err) {
    if (!(err instanceof SecretKeyMissingError || err instanceof SecretNotFoundError)) throw err;
    env.LANGSMITH_TRACING = "false";
    log(`langsmith_api_key missing${err instanceof SecretNotFoundError ? " (no secret value)" : ""}: tracing off`);
    return;
  }
  if (key.trim().length === 0) {
    env.LANGSMITH_TRACING = "false";
    log("langsmith_api_key empty: tracing off");
    return;
  }
  env.LANGSMITH_API_KEY = key;
}

async function init(deps: LambdaDeps): Promise<TaskGraph> {
  const log = deps.log ?? ((line: string) => console.log(line));
  await configureTracing(deps, log);
  const dbUrl = await deps.secrets.get(required(deps.env, ORCHESTRATOR_SECRET_ENV), "db_url");
  // An empty URL would make node-postgres fall back to its localhost defaults.
  if (dbUrl.trim().length === 0) throw new ConfigError("db_url is empty");
  const pool = (deps.makePool ?? createPool)(dbUrl);
  await setupCheckpointer(pool);
  return buildGraph(checkpointerFromPool(pool));
}

/**
 * Builds a handler; one per process (each Lambda instance has its own graph and pool).
 *
 * If the cold start fails (a secret without a value or key, an empty db_url, the database
 * unreachable, schema lg missing), every record of the batch is returned as a batch item failure
 * and one line logs the error class (never a value or message). SQS makes the messages visible
 * again after the queue's visibility timeout (6x the function timeout) and moves them to the DLQ
 * after max_receive_count receives, as for any transient failure (P2-08), so there is no busy
 * loop. The next invocation retries the cold start with fresh secret reads.
 */
export function createHandler(deps: LambdaDeps): (event: SqsEvent) => Promise<SqsBatchResponse> {
  const log = deps.log ?? ((line: string) => console.log(line));
  let ready: Promise<TaskGraph> | undefined;
  return async (event) => {
    ready ??= init(deps);
    let graph: TaskGraph;
    try {
      graph = await ready;
    } catch (err) {
      ready = undefined; // retry the cold start on the next invocation
      deps.secrets.clearCache?.();
      const records = event.Records ?? [];
      log(`init failed (${err instanceof Error ? err.name : "error"}): ${records.length} message(s) returned to the queue`);
      return { batchItemFailures: records.map((r) => ({ itemIdentifier: r.messageId })) };
    }
    return handleSqsEvent(event, { graph, ...(deps.log ? { log: deps.log } : {}) });
  };
}

export const handler = createHandler({ env: process.env, secrets: new SecretStore() });
