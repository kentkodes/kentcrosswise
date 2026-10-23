// The sweeper Lambda's handler, without the AWS SDK: the SQS client is injected (see entry.ts for
// the production wiring). EventBridge Scheduler invokes it asynchronously every 15 minutes with
// `{"scheduled_time": "<aws.scheduler.scheduled-time>"}` (infra/modules/scheduler).
//
// Configuration (D9: env holds names, values come from Secrets Manager):
//   KCW_ORCHESTRATOR_SECRET     kcw/prod/orchestrator: db_url (orch_rw) and the orchestrator App
//                               credentials. The sweeper acts as the orchestrator, so it reads the
//                               orchestrator's secret rather than a copy of the App key.
//   KCW_ORCHESTRATOR_QUEUE_URL  orchestrator-in.fifo
import pg from "pg";
import { createAppOctokit, readAppCredentials, type SecretGetter } from "../github/octokit";
import { DEFAULT_REPO } from "../github/types";
import { OctokitSweeperGitHub, type SweeperGitHub } from "./github";
import { scheduledTimeOf } from "./schedule";
import { sqlSweeperStore, type SqlQuery } from "./store";
import { runSweep, type QueuedMessage, type SweepQueue, type SweepReport } from "./sweep";

export const SWEEPER_SECRET_ENV = "KCW_ORCHESTRATOR_SECRET";
export const SWEEPER_QUEUE_URL_ENV = "KCW_ORCHESTRATOR_QUEUE_URL";

/** SQS SendMessage input, as the AWS SDK's SendMessageCommand takes it. */
export interface SendMessageInput {
  QueueUrl: string;
  MessageBody: string;
  MessageGroupId: string;
  MessageDeduplicationId: string;
}

export interface SweeperSecrets extends SecretGetter {
  clearCache?(): void;
}

/** A database connection for one run. */
export interface SweeperDb extends SqlQuery {
  end(): Promise<void>;
}

export interface SweeperLambdaDeps {
  env: Record<string, string | undefined>;
  secrets: SweeperSecrets;
  sendMessage: (input: SendMessageInput) => Promise<unknown>;
  connect?: (connectionString: string) => Promise<SweeperDb>;
  github?: (secretName: string) => Promise<SweeperGitHub>;
  now?: () => Date;
  log?: (line: string) => void;
}

/** Missing configuration. The message names the setting, never a value. */
export class SweeperConfigError extends Error {
  override name = "SweeperConfigError";
}

/** Thrown at the end of a run with failed parts, so the invocation counts as an error in CloudWatch. */
export class SweepFailedError extends Error {
  override name = "SweepFailedError";
}

function required(env: SweeperLambdaDeps["env"], name: string): string {
  const v = env[name];
  if (!v) throw new SweeperConfigError(`${name} is not set`);
  return v;
}

async function connectPg(connectionString: string): Promise<SweeperDb> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

async function appGitHub(secretName: string, secrets: SecretGetter): Promise<SweeperGitHub> {
  const creds = await readAppCredentials(secretName, secrets);
  return new OctokitSweeperGitHub(createAppOctokit(creds, { repo: DEFAULT_REPO }), DEFAULT_REPO);
}

export function sqsSweepQueue(sendMessage: SweeperLambdaDeps["sendMessage"], queueUrl: string): SweepQueue {
  return {
    async send(m: QueuedMessage) {
      await sendMessage({ QueueUrl: queueUrl, MessageBody: m.body, MessageGroupId: m.groupId, MessageDeduplicationId: m.dedupeId });
    },
  };
}

/**
 * One handler per process. The GitHub client is kept across warm invocations (its installation
 * token is cached); the database connection is opened per run and closed after it.
 */
export function createSweeperHandler(deps: SweeperLambdaDeps): (event: unknown) => Promise<SweepReport> {
  const log = deps.log ?? ((line: string) => console.log(line));
  let github: Promise<SweeperGitHub> | undefined;

  return async (event) => {
    const now = (deps.now ?? (() => new Date()))();
    const secretName = required(deps.env, SWEEPER_SECRET_ENV);
    const queue = sqsSweepQueue(deps.sendMessage, required(deps.env, SWEEPER_QUEUE_URL_ENV));

    let db: SweeperDb;
    try {
      const url = await deps.secrets.get(secretName, "db_url");
      if (url.trim().length === 0) throw new SweeperConfigError("db_url is empty");
      db = await (deps.connect ?? connectPg)(url);
    } catch (err) {
      deps.secrets.clearCache?.();
      log(`sweeper: database unavailable (${err instanceof Error ? err.name : "error"})`);
      throw new SweepFailedError("database unavailable");
    }

    try {
      const report = await runSweep({
        store: sqlSweeperStore(db),
        queue,
        github: () => {
          github ??= (deps.github ?? ((name) => appGitHub(name, deps.secrets)))(secretName).catch((err: unknown) => {
            github = undefined; // retry on the next run (e.g. the App key filled in meanwhile)
            deps.secrets.clearCache?.();
            throw err;
          });
          return github;
        },
        scheduledTime: scheduledTimeOf(event, now),
        now,
        log,
      });
      const failed = Object.keys(report.failed);
      if (failed.length > 0) throw new SweepFailedError(`failed parts: ${failed.join(",")}`);
      return report;
    } finally {
      await db.end().catch(() => undefined);
    }
  };
}
