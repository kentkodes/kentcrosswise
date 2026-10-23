// Lambda entry point (handler `index.handler` once bundled; infra/modules/orchestrator).
// Cold start: read the DB URL (and the LangSmith key when tracing is on) from Secrets Manager (D9),
// set up the checkpointer tables in schema lg, build the graph. Warm invocations reuse all of it.
import { SecretKeyMissingError, SecretStore } from "@kcw/secrets";
import type pg from "pg";
import { checkpointerFromPool, createPool, setupCheckpointer } from "./checkpointer";
import { buildGraph, type TaskGraph } from "./graph";
import { handleSqsEvent, type SqsBatchResponse, type SqsEvent } from "./handler";

/** Env var names (values are secret *names*, set by infra/modules/orchestrator via infra/prod). */
export const ORCHESTRATOR_SECRET_ENV = "KCW_ORCHESTRATOR_SECRET";
export const MODELS_SECRET_ENV = "KCW_MODELS_SECRET";

export interface SecretReader {
  get(name: string, key: string): Promise<string>;
}

export interface LambdaDeps {
  env: Record<string, string | undefined>;
  secrets: SecretReader;
  makePool?: (connectionString: string) => pg.Pool;
  log?: (line: string) => void;
}

function required(env: LambdaDeps["env"], name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/**
 * LangSmith reads LANGSMITH_API_KEY from the environment; the key itself lives in the models
 * secret, so it is copied into this process's env at cold start. A missing key turns tracing off
 * instead of failing every message.
 */
async function configureTracing(deps: LambdaDeps, log: (line: string) => void): Promise<void> {
  const { env } = deps;
  if (env.LANGSMITH_TRACING !== "true" || env.LANGSMITH_API_KEY) return;
  try {
    env.LANGSMITH_API_KEY = await deps.secrets.get(required(env, MODELS_SECRET_ENV), "langsmith_api_key");
  } catch (err) {
    if (!(err instanceof SecretKeyMissingError)) throw err;
    env.LANGSMITH_TRACING = "false";
    log("langsmith_api_key missing: tracing off");
  }
}

async function init(deps: LambdaDeps): Promise<TaskGraph> {
  const log = deps.log ?? ((line: string) => console.log(line));
  await configureTracing(deps, log);
  const dbUrl = await deps.secrets.get(required(deps.env, ORCHESTRATOR_SECRET_ENV), "db_url");
  const pool = (deps.makePool ?? createPool)(dbUrl);
  await setupCheckpointer(pool);
  return buildGraph(checkpointerFromPool(pool));
}

/** Builds a handler; one per process (each Lambda instance has its own graph and pool). */
export function createHandler(deps: LambdaDeps): (event: SqsEvent) => Promise<SqsBatchResponse> {
  let ready: Promise<TaskGraph> | undefined;
  return async (event) => {
    ready ??= init(deps);
    let graph: TaskGraph;
    try {
      graph = await ready;
    } catch (err) {
      ready = undefined; // retry the cold start on the next invocation
      throw err;
    }
    return handleSqsEvent(event, { graph, ...(deps.log ? { log: deps.log } : {}) });
  };
}

export const handler = createHandler({ env: process.env, secrets: new SecretStore() });
