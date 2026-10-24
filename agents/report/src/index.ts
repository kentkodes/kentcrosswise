// kcw-report (P2-03): the last step of every agent workflow (DESIGN §4.1 step 6) sends
// {task_id, agent, event_type?, usage?} to the orchestrator's SQS FIFO queue. Without --event-type
// the report is usage-only (DESIGN §11 Q14(5)): the orchestrator records usage and no event.
// Everything here is injectable so tests run with a fake SQS client; cli.ts wires in the real one.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { parseAgentReport, threadIdOf, type AgentReport, type Usage } from "@kcw/core/events";

/** Package name, used by the workspace smoke test. */
export const PACKAGE_NAME = "@kcw/report";

/** Environment variable holding the orchestrator queue URL (not a secret). */
export const QUEUE_URL_ENV = "KCW_ORCHESTRATOR_QUEUE_URL";

/** The part of the AWS SDK v3 SQS client we use. Inject a fake in tests. */
export interface SqsLike {
  send(command: SendMessageCommand): Promise<unknown>;
}

export interface SendOptions {
  sqs: SqsLike;
  queueUrl: string;
  /** FIFO deduplication id; defaults to a random UUID (so two identical reports are both delivered). */
  dedupeId?: string;
}

/**
 * Sends one validated report. MessageGroupId is the task's thread id (`task-<id>`), so reports
 * are processed in order with the other inputs of that thread (D5). Returns the SQS MessageId.
 */
export async function sendReport(report: AgentReport, opts: SendOptions): Promise<string | undefined> {
  const body = parseAgentReport(report);
  const out = (await opts.sqs.send(
    new SendMessageCommand({
      QueueUrl: opts.queueUrl,
      MessageBody: JSON.stringify(body),
      MessageGroupId: threadIdOf(body.task_id),
      MessageDeduplicationId: opts.dedupeId ?? randomUUID(),
    }),
  )) as { MessageId?: string } | undefined;
  return out?.MessageId;
}

export class UsageError extends Error {
  override name = "UsageError";
}

export const HELP = `Usage: pnpm kcw-report --task-id <n> --agent <agent> [--event-type <type>] [options]

Sends {task_id, agent, event_type, usage} to the orchestrator queue (SQS FIFO). Without
--event-type the report is usage-only (no lifecycle event) and needs at least one usage line.

Options:
  --provider <p> --model <m> --input-tokens <n> --output-tokens <n>   model usage of this step
  --claude-execution-file <path>    model usage of a Claude Code Action run (its execution_file
                                    output), one usage line per model
  --minutes <x>                     GitHub Actions minutes of this job (agent workflows do not send
                                    it: the relay records Actions minutes, DESIGN §11 Q13)
  --queue-url <url>                 default: $${QUEUE_URL_ENV}
  --region <r>                      default: $AWS_REGION, then us-east-1
  --dedupe-id <id>                  FIFO deduplication id (default: random)
  --dry-run                         print the message JSON and send nothing
  --help
`;

const OPTIONS = {
  "task-id": { type: "string" },
  agent: { type: "string" },
  "event-type": { type: "string" },
  provider: { type: "string" },
  model: { type: "string" },
  "input-tokens": { type: "string" },
  "output-tokens": { type: "string" },
  minutes: { type: "string" },
  "claude-execution-file": { type: "string" },
  "queue-url": { type: "string" },
  region: { type: "string" },
  "dedupe-id": { type: "string" },
  "dry-run": { type: "boolean" },
  help: { type: "boolean" },
} as const;

function integer(flag: string, v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new UsageError(`--${flag} must be a non-negative integer`);
  return Number(v);
}

/**
 * Builds the report from parsed flags plus usage read elsewhere (the execution file). Without
 * --event-type it is usage-only and needs at least one usage line. Errors never quote a flag value.
 */
export function reportFromFlags(v: Record<string, string | boolean | undefined>, extraUsage: readonly Usage[] = []): AgentReport {
  const str = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : undefined);
  if (str("task-id") === undefined || str("agent") === undefined) {
    throw new UsageError("--task-id and --agent are required");
  }
  const usage: Usage[] = [];
  const modelFlags = ["provider", "model", "input-tokens", "output-tokens"].filter((k) => str(k) !== undefined);
  if (modelFlags.length > 0) {
    if (modelFlags.length < 4) {
      throw new UsageError("model usage needs all of --provider, --model, --input-tokens, --output-tokens");
    }
    usage.push({
      kind: "model",
      provider: str("provider")!,
      model: str("model")!,
      input_tokens: integer("input-tokens", str("input-tokens"))!,
      output_tokens: integer("output-tokens", str("output-tokens"))!,
    });
  }
  const minutes = str("minutes");
  if (minutes !== undefined) {
    if (!/^\d+(\.\d+)?$/.test(minutes)) throw new UsageError("--minutes must be a non-negative number");
    usage.push({ kind: "actions_minutes", minutes: Number(minutes) });
  }
  usage.push(...extraUsage);
  if (str("event-type") === undefined && usage.length === 0) {
    throw new UsageError("--event-type is required unless the report carries usage");
  }
  return parseAgentReport({
    task_id: integer("task-id", str("task-id")),
    agent: str("agent"),
    ...(str("event-type") !== undefined ? { event_type: str("event-type") } : {}),
    ...(usage.length > 0 ? { usage } : {}),
  });
}

/**
 * Model usage of a Claude Code Action run, from its execution file (the JSON array of Agent SDK
 * messages; the last `result` message carries `modelUsage` per model). Input tokens include cache
 * reads and cache writes, because usage_events has one input count (the computed cost is then an
 * upper bound). No result message (the run died early): no usage. Never echoes file content.
 */
export function usageFromExecution(messages: unknown): Usage[] {
  if (!Array.isArray(messages)) throw new UsageError("the execution file is not a JSON array");
  const result = [...(messages as unknown[])]
    .reverse()
    .find((m) => typeof m === "object" && m !== null && (m as { type?: unknown }).type === "result") as
    | { modelUsage?: unknown }
    | undefined;
  if (!result || typeof result.modelUsage !== "object" || result.modelUsage === null) return [];
  const count = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);
  const usage: Usage[] = [];
  for (const [model, raw] of Object.entries(result.modelUsage as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null || !/^[\w.:/-]{1,100}$/.test(model)) continue;
    const u = raw as Record<string, unknown>;
    const input = count(u.inputTokens) + count(u.cacheReadInputTokens) + count(u.cacheCreationInputTokens);
    const output = count(u.outputTokens);
    if (input === 0 && output === 0) continue;
    usage.push({ kind: "model", provider: "anthropic", model, input_tokens: input, output_tokens: output });
  }
  return usage;
}

async function readExecutionUsage(file: string, read: (p: string) => Promise<string>): Promise<Usage[]> {
  let text: string;
  try {
    text = await read(file);
  } catch {
    // A run that failed before Claude started has no file: the event is sent without usage.
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError("the execution file is not valid JSON");
  }
  return usageFromExecution(parsed);
}

export interface CliDeps {
  env: Readonly<Record<string, string | undefined>>;
  /** Defaults to a real SQSClient in the chosen region. */
  sqs?: SqsLike;
  stdout: (line: string) => void;
  /** Reads --claude-execution-file; defaults to fs.readFile. */
  readFile?: (path: string) => Promise<string>;
}

/** Runs the CLI. Throws on bad input or a failed send; cli.ts turns that into exit code 1. */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<void> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({ args: [...argv], options: OPTIONS, strict: true, allowPositionals: false }));
  } catch {
    throw new UsageError(`unknown or malformed option (see --help)`);
  }
  if (values.help === true) {
    deps.stdout(HELP);
    return;
  }
  const execFile = values["claude-execution-file"];
  const extra =
    typeof execFile === "string" && execFile !== ""
      ? await readExecutionUsage(execFile, deps.readFile ?? ((p) => readFile(p, "utf8")))
      : [];
  const report = reportFromFlags(values, extra);
  if (values["dry-run"] === true) {
    deps.stdout(JSON.stringify(report, null, 2));
    return;
  }
  const queueUrl = (values["queue-url"] as string | undefined) ?? deps.env[QUEUE_URL_ENV];
  if (!queueUrl) throw new UsageError(`no queue URL: pass --queue-url or set ${QUEUE_URL_ENV}`);
  const region = (values.region as string | undefined) ?? deps.env.AWS_REGION ?? "us-east-1";
  const sqs = deps.sqs ?? new SQSClient({ region });
  const dedupeId = values["dedupe-id"] as string | undefined;
  let messageId: string | undefined;
  try {
    messageId = await sendReport(report, { sqs, queueUrl, ...(dedupeId ? { dedupeId } : {}) });
  } catch (err) {
    // Only the AWS error name: SDK messages can be long and are not needed in CI logs.
    const name = err instanceof Error ? err.name : "unknown error";
    throw new Error(`could not send the report to SQS (${name})`, { cause: err });
  }
  deps.stdout(
    `kcw-report: sent ${report.event_type ?? "usage"} from ${report.agent} for ${threadIdOf(report.task_id)}` +
      (messageId ? ` (message ${messageId})` : ""),
  );
}
