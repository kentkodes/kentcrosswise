// SQS FIFO plumbing (D5): each message is one input for one task thread. Batch size is 1 (infra),
// but every record is handled on its own and failures are returned as partial batch failures.
// The task graph's handler (`handleTaskSqsEvent`, src/graph) parses and runs the records.
import { ReportFormatError, threadIdOf } from "@kcw/core/events";

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

/** A message that can never be processed; retrying it would only block its FIFO group. */
export class InputError extends Error {
  override name = "InputError";
}

export function threadConfig(taskId: number) {
  return { configurable: { thread_id: threadIdOf(taskId) } };
}

/**
 * The record loop: `process` parses and runs one record and returns its outcome for the log.
 * InputError and ReportFormatError mean the message can never be processed (dropped); any other
 * error is transient (returned to the queue).
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
