// Lambda entry point (handler `index.handler` once bundled; infra/modules/orchestrator).
// Cold start: read the configuration from Secrets Manager (D9), set up the checkpointer tables in
// schema lg, and build the task graph (P2-10) with its dependencies: the task store (orch_rw), the
// GitHub client (orchestrator App), the planner and public-title nodes (P2-11, Haiku via
// AnthropicProvider) and the sanitizer's contact list (read per step by the graph). Warm
// invocations reuse all of it.
//
//   KCW_ORCHESTRATOR_SECRET  kcw/prod/orchestrator: db_url, github_app_client_id,
//                            github_app_installation_id, github_app_private_key
//   KCW_MODELS_SECRET        kcw/prod/models: anthropic_api_key, langsmith_api_key
import { AnthropicProvider, type ModelProvider, type UsageCallback } from "@kcw/core/models";
import { SecretKeyMissingError, SecretNotFoundError, SecretStore } from "@kcw/secrets";
import type pg from "pg";
import { checkpointerFromPool, createPool, setupCheckpointer } from "./checkpointer";
import { githubClientFromSecret, type GitHubClient } from "./github";
import { PgTaskStore, buildTaskGraph, handleTaskSqsEvent, type TaskGraph } from "./graph";
import type { SqsBatchResponse, SqsEvent } from "./handler";
import { ModelPlanner, trackPlannerUsage } from "./nodes";

/** Env var names (values are secret *names*, set by infra/modules/orchestrator via infra/prod). */
export const ORCHESTRATOR_SECRET_ENV = "KCW_ORCHESTRATOR_SECRET";
export const MODELS_SECRET_ENV = "KCW_MODELS_SECRET";

/** Key of the Anthropic API key in the models secret (DESIGN §6). */
export const ANTHROPIC_KEY = "anthropic_api_key";

export interface SecretReader {
  get(name: string, key: string): Promise<string>;
  /** Forget cached values so a failed cold start re-reads them (SecretStore has it). */
  clearCache?(): void;
}

export interface LambdaDeps {
  env: Record<string, string | undefined>;
  secrets: SecretReader;
  makePool?: (connectionString: string) => pg.Pool;
  /** The GitHub client; defaults to the orchestrator App from the orchestrator secret. Tests inject a fake. */
  makeGitHub?: (orchestratorSecret: string, secrets: SecretReader) => Promise<GitHubClient>;
  /**
   * The planner's model provider; defaults to AnthropicProvider (Haiku 5.5, Q3). It must report
   * every call to `onUsage`, which writes the task's usage row. Tests inject a FakeProvider.
   */
  makeProvider?: (opts: { apiKey: () => Promise<string>; onUsage: UsageCallback }) => ModelProvider;
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

const defaultGitHub: NonNullable<LambdaDeps["makeGitHub"]> = (name, secrets) => githubClientFromSecret(name, { secrets });
const defaultProvider: NonNullable<LambdaDeps["makeProvider"]> = (opts) => new AnthropicProvider(opts);

async function init(deps: LambdaDeps, log: (line: string) => void): Promise<TaskGraph> {
  await configureTracing(deps, log);
  const orchestratorSecret = required(deps.env, ORCHESTRATOR_SECRET_ENV);
  const modelsSecret = required(deps.env, MODELS_SECRET_ENV);

  const dbUrl = await deps.secrets.get(orchestratorSecret, "db_url");
  // An empty URL would make node-postgres fall back to its localhost defaults.
  if (dbUrl.trim().length === 0) throw new ConfigError("db_url is empty");
  // Read the Anthropic key now, so a missing or empty one fails the cold start (messages go back
  // to the queue) instead of failing every planning step. The provider reads it again (cached).
  const apiKey = () => deps.secrets.get(modelsSecret, ANTHROPIC_KEY);
  if ((await apiKey()).trim().length === 0) throw new ConfigError(`${ANTHROPIC_KEY} is empty`);
  const github = await (deps.makeGitHub ?? defaultGitHub)(orchestratorSecret, deps.secrets);

  const pool = (deps.makePool ?? createPool)(dbUrl);
  try {
    await setupCheckpointer(pool);
  } catch (err) {
    await pool.end().catch(() => undefined); // the next cold start makes a new pool
    throw err;
  }
  const store = new PgTaskStore(pool);

  // Planner usage goes to usage_events (kind model, agent orchestrator, cost_usd null: §11 Q13(1)).
  const usage = trackPlannerUsage(
    (taskId, u) =>
      store.addUsage(taskId, "orchestrator", [
        { kind: "model", provider: u.provider, model: u.model, input_tokens: u.inputTokens, output_tokens: u.outputTokens },
      ]),
    log,
  );
  const provider = (deps.makeProvider ?? defaultProvider)({ apiKey, onUsage: usage.onUsage });
  const planner = usage.planner(new ModelPlanner({ provider }));

  return buildTaskGraph(checkpointerFromPool(pool), { github, store, planner, log });
}

/**
 * Builds a handler; one per process (each Lambda instance has its own graph and pool). It accepts
 * every message of the task graph (`parseTaskMessage`): task.created, owner.decision, sweep, relay
 * events and agent reports.
 *
 * If the cold start fails (a secret without a value or key, an empty db_url or Anthropic key,
 * invalid App credentials, the database unreachable, schema lg missing), every record of the batch
 * is returned as a batch item failure and one line logs the error class (never a value or message).
 * SQS makes the messages visible again after the queue's visibility timeout (6x the function
 * timeout) and moves them to the DLQ after max_receive_count receives, as for any transient
 * failure (P2-08), so there is no busy loop. The next invocation retries the cold start with fresh
 * secret reads.
 */
export function createHandler(deps: LambdaDeps): (event: SqsEvent) => Promise<SqsBatchResponse> {
  const log = deps.log ?? ((line: string) => console.log(line));
  let ready: Promise<TaskGraph> | undefined;
  return async (event) => {
    ready ??= init(deps, log);
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
    return handleTaskSqsEvent(event, { graph, log });
  };
}

export const handler = createHandler({ env: process.env, secrets: new SecretStore() });
