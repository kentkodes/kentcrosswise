// Lambda entry (Function URL, payload v2; the infra is P2-06). Wires the real dependencies:
// the webhook secret from Secrets Manager (cached per process, D9), Postgres via node-postgres,
// SQS. Environment variables hold only secret *names*, the queue URL and sender ids.
import { SQSClient } from "@aws-sdk/client-sqs";
import { fromPg } from "@kcw/db";
import { SecretStore } from "@kcw/secrets";
import pg from "pg";
import { QUEUE_URL_ENV, sqsQueue, type SqsLike } from "./queue";
import { handleDelivery, type RelayResponse } from "./relay";
import { sqlRelayStore, type RelayStore, type SqlQuery } from "./store";

export const ENV = {
  /** Secret holding the webhook secret under key `secret` (default `kcw/github/webhook-secret`, §6). */
  webhookSecretName: "KCW_WEBHOOK_SECRET_NAME",
  /** Secret holding the relay's database URL under key `db_url`. */
  dbSecretName: "KCW_RELAY_DB_SECRET_NAME",
  queueUrl: QUEUE_URL_ENV,
  /** Comma-separated GitHub account ids: the orchestrator/Developer/QA/Scraper/Docs App bots and the owner. */
  allowedSenderIds: "KCW_RELAY_ALLOWED_SENDER_IDS",
} as const;

export const DEFAULT_WEBHOOK_SECRET_NAME = "kcw/github/webhook-secret";

export interface RelayConfig {
  webhookSecretName: string;
  dbSecretName: string;
  queueUrl: string;
  allowedSenderIds: ReadonlySet<number>;
  region: string;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Reads and validates the configuration. Fails closed: no allowlist means no relay. */
export function configFromEnv(env: Readonly<Record<string, string | undefined>>): RelayConfig {
  const need = (k: string): string => {
    const v = env[k]?.trim();
    if (!v) throw new ConfigError(`${k} is not set`);
    return v;
  };
  const ids = need(ENV.allowedSenderIds)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0 || !ids.every((s) => /^[1-9]\d{0,15}$/.test(s))) {
    throw new ConfigError(`${ENV.allowedSenderIds} must be a comma-separated list of GitHub account ids`);
  }
  return {
    webhookSecretName: env[ENV.webhookSecretName]?.trim() || DEFAULT_WEBHOOK_SECRET_NAME,
    dbSecretName: need(ENV.dbSecretName),
    queueUrl: need(ENV.queueUrl),
    allowedSenderIds: new Set(ids.map(Number)),
    region: env.AWS_REGION?.trim() || "us-east-1",
  };
}

/** The subset of a Lambda Function URL (payload format 2.0) event the relay reads. */
export interface FunctionUrlEvent {
  requestContext: { http: { method: string } };
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

export interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export interface OpenedDb {
  db: SqlQuery;
  close(): Promise<void>;
}

export interface HandlerOptions {
  env?: Readonly<Record<string, string | undefined>>;
  secrets?: SecretStore;
  sqs?: SqsLike;
  /** Opens one connection for one delivery. Default: a node-postgres Client. */
  openDb?: (url: string) => Promise<OpenedDb>;
  log?: (line: string) => void;
}

/**
 * Connect timeout of the relay's database client. GitHub gives a delivery 10 s and the dispatch
 * link lookups can wait ~2 s, so a stuck connect must fail (500, redelivered) well before that.
 * node-postgres has no connect timeout by default. No query_timeout: a client-side timeout on the
 * delivery claim could leave a committed claim behind a 500, so the redelivery would be dropped
 * as a duplicate. No statement_timeout startup parameter: the pooled (PgBouncer) endpoint may refuse it.
 */
export const RELAY_PG_CONNECTION_TIMEOUT_MS = 3000;

/** The node-postgres client configuration the relay connects with. */
export function relayPgConfig(url: string): pg.ClientConfig {
  return { connectionString: url, connectionTimeoutMillis: RELAY_PG_CONNECTION_TIMEOUT_MS };
}

/** Opens the relay's per-delivery connection (exported for the connect timeout test). */
export async function openPg(url: string): Promise<OpenedDb> {
  const client = new pg.Client(relayPgConfig(url));
  await client.connect();
  return { db: fromPg(client), close: () => client.end() };
}

/** A store that connects only when a delivery needs the database (ignored events never do). */
function lazyStore(open: () => Promise<OpenedDb>): { store: RelayStore; close: () => Promise<void> } {
  let opened: Promise<OpenedDb> | undefined;
  const get = async () => sqlRelayStore((await (opened ??= open())).db);
  return {
    store: {
      claimDelivery: async (id, source) => (await get()).claimDelivery(id, source),
      releaseDelivery: async (id) => (await get()).releaseDelivery(id),
      findTaskByPr: async (n) => (await get()).findTaskByPr(n),
      findTaskByIssue: async (n) => (await get()).findTaskByIssue(n),
      findDispatch: async (runId) => (await get()).findDispatch(runId),
      recordActionsMinutes: async (u, taskId) => (await get()).recordActionsMinutes(u, taskId),
    },
    close: async () => {
      if (!opened) return;
      try {
        await (await opened).close();
      } catch {
        // connect failed (already reported) or the connection is gone: nothing to close
      }
    },
  };
}

function result(r: RelayResponse): FunctionUrlResult {
  return { statusCode: r.status, headers: { "content-type": "application/json" }, body: JSON.stringify(r.body) };
}

export function createHandler(opts: HandlerOptions = {}): (event: FunctionUrlEvent) => Promise<FunctionUrlResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  let config: RelayConfig | undefined;
  let secrets = opts.secrets;
  let sqs = opts.sqs;

  return async (event) => {
    let cfg: RelayConfig;
    let secret: string;
    try {
      cfg = config ??= configFromEnv(opts.env ?? process.env);
      secrets ??= new SecretStore({ region: cfg.region });
      secret = await secrets.get(cfg.webhookSecretName, "secret");
      if (secret.length === 0) throw new ConfigError("the webhook secret is empty");
    } catch (err) {
      // Message of our own ConfigError only; AWS errors by name (never values).
      log(`relay: error (config) ${err instanceof ConfigError ? err.message : err instanceof Error ? err.name : "unknown"}`);
      return result({ status: 500, body: { result: "error", reason: "config" } });
    }
    sqs ??= new SQSClient({ region: cfg.region });
    const store = secrets;
    const db = lazyStore(async () => {
      let url: string;
      try {
        url = await store.get(cfg.dbSecretName, "db_url");
        // An empty URL would make node-postgres fall back to its localhost defaults.
        if (url.trim().length === 0) throw new ConfigError("db_url is empty");
      } catch (err) {
        // Re-read on the next delivery, so filling the secret takes effect without a cold start.
        // Only reached by deliveries that passed the signature check.
        store.clearCache(cfg.dbSecretName);
        throw err;
      }
      return (opts.openDb ?? openPg)(url);
    });
    const raw = event.body ?? "";
    try {
      const r = await handleDelivery(
        {
          method: event.requestContext.http.method,
          headers: event.headers ?? {},
          body: event.isBase64Encoded ? Buffer.from(raw, "base64") : Buffer.from(raw, "utf8"),
        },
        { secret, allowedSenderIds: cfg.allowedSenderIds, store: db.store, queue: sqsQueue(sqs, cfg.queueUrl), log },
      );
      return result(r);
    } finally {
      await db.close();
    }
  };
}

/** The Lambda handler (`index.handler` once bundled). */
export const handler = createHandler();
