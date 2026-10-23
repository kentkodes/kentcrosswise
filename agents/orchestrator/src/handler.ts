// SQS FIFO handler (D5): each message is one input for one task thread. Batch size is 1 (infra),
// but every record is handled on its own and failures are returned as partial batch failures.
import { Command } from "@langchain/langgraph";
import { ReportFormatError, parseAgentReport, threadIdOf, type AgentReport } from "@kcw/core/events";
import type { TaskGraph } from "./skeleton";

/** The fields of an SQS Lambda event we use. */
export interface SqsRecord {
  messageId: string;
  body: string;
  attributes?: { MessageGroupId?: string };
}
export interface SqsEvent {
  Records?: SqsRecord[];
}
export interface SqsBatchResponse {
  batchItemFailures: { itemIdentifier: string }[];
}

/** Message the console sends when the owner creates a task (DESIGN §4.2 step 1). */
export interface TaskCreatedMessage {
  type: "task.created";
  task_id: number;
}

export type OrchestratorInput = { kind: "start"; task_id: number } | { kind: "report"; report: AgentReport };

/** A message that can never be processed; retrying it would only block its FIFO group. */
export class InputError extends Error {
  override name = "InputError";
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Parses and validates one untrusted queue message. Agent reports (kcw-report) are checked with
 * `parseAgentReport`. The FIFO group must be the task's thread id, so a sender cannot route an
 * input into another task's ordering group. Error messages never quote the input.
 */
export function parseMessage(body: string, groupId: string | undefined): OrchestratorInput {
  let x: unknown;
  try {
    x = JSON.parse(body);
  } catch {
    throw new InputError("message body is not JSON");
  }
  if (!isObject(x)) throw new InputError("message must be a JSON object");

  let input: OrchestratorInput;
  if (x.type === "task.created") {
    if (typeof x.task_id !== "number" || !Number.isSafeInteger(x.task_id) || x.task_id < 1) {
      throw new InputError("task_id must be a positive integer");
    }
    input = { kind: "start", task_id: x.task_id };
  } else if (x.type === undefined) {
    input = { kind: "report", report: parseAgentReport(x) };
  } else {
    throw new InputError("unknown message type");
  }

  const taskId = input.kind === "start" ? input.task_id : input.report.task_id;
  if (groupId !== threadIdOf(taskId)) throw new InputError("MessageGroupId does not match the task's thread id");
  return input;
}

export type Outcome =
  | "started" // new thread, ran to its first interrupt
  | "duplicate_start" // task.created for a thread that already exists
  | "resumed" // report delivered to a waiting thread
  | "stale"; // report for a thread that is not waiting (unknown, finished, or not interrupted)

export function threadConfig(taskId: number) {
  return { configurable: { thread_id: threadIdOf(taskId) } };
}

/** Runs one input against the task's thread until the next interrupt or the end. */
export async function processInput(graph: TaskGraph, input: OrchestratorInput): Promise<Outcome> {
  const taskId = input.kind === "start" ? input.task_id : input.report.task_id;
  const config = threadConfig(taskId);
  const snapshot = await graph.getState(config);
  const exists = snapshot.config.configurable?.checkpoint_id !== undefined;

  if (input.kind === "start") {
    if (exists) return "duplicate_start";
    await graph.invoke({ task_id: taskId }, config);
    return "started";
  }

  // DESIGN §4.3: stale or unexpected events are recorded and the thread stays as it is.
  const waiting = snapshot.tasks.some((t) => t.interrupts.length > 0);
  if (!waiting) return "stale";
  await graph.invoke(new Command({ resume: input.report }), config);
  return "resumed";
}

export interface HandlerDeps {
  graph: TaskGraph;
  /** One line per message; never message bodies (they may hold private task data). */
  log?: (line: string) => void;
}

export async function handleSqsEvent(event: SqsEvent, deps: HandlerDeps): Promise<SqsBatchResponse> {
  return handleRecords(
    event,
    (record) => processInput(deps.graph, parseMessage(record.body, record.attributes?.MessageGroupId)),
    deps.log,
  );
}

/**
 * The record loop shared by the skeleton and the task graph: `process` parses and runs one record
 * and returns its outcome for the log. InputError and ReportFormatError mean the message can never
 * be processed (dropped); any other error is transient (returned to the queue).
 */
export async function handleRecords(
  event: SqsEvent,
  process: (record: SqsRecord) => Promise<string>,
  logLine?: (line: string) => void,
): Promise<SqsBatchResponse> {
  const log = logLine ?? ((line: string) => console.log(line));
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records ?? []) {
    // FIFO: after a failure, later messages must not overtake it, so they are returned unprocessed.
    if (failures.length > 0) {
      failures.push({ itemIdentifier: record.messageId });
      continue;
    }
    try {
      const outcome = await process(record);
      log(`message ${record.messageId}: ${outcome}`);
    } catch (err) {
      if (err instanceof InputError || err instanceof ReportFormatError) {
        // Not retryable: acknowledge it (dropped) instead of blocking the group for every retry.
        log(`message ${record.messageId}: dropped (${err.message})`);
        continue;
      }
      // Transient (DB, network): SQS redelivers it, then moves it to the DLQ.
      log(`message ${record.messageId}: failed (${err instanceof Error ? err.name : "error"})`);
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
