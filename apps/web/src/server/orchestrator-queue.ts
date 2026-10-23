// Messages from the boss console and inbox to the orchestrator (DESIGN §4.2 step 1, §4.3, D5).
// All orchestrator inputs go to the SQS FIFO queue orchestrator-in with MessageGroupId = the task's
// thread id (task-<id>) and an explicit MessageDeduplicationId (the queue has no content-based dedupe).
//
// KCW_ORCHESTRATOR_QUEUE_URL set (prod): messages are sent. Unset (previews have no orchestrator):
// the queue is disabled, nothing is sent, and the pages say so; the database writes still happen,
// so previews can test everything up to the queue.
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

export const QUEUE_URL_ENV = "KCW_ORCHESTRATOR_QUEUE_URL";

export type Decision = "approved" | "rejected";

/** What the orchestrator's handler parses (agents/orchestrator/src/handler.ts). */
export type OrchestratorMessage =
  | { type: "task.created"; task_id: number }
  // §4.3 "Owner decisions": the resume value for the thread waiting on the owner. The P2-08 handler
  // drops unknown types without retrying; the P2-10 graph consumes this one.
  | { type: "owner.decision"; task_id: number; thread_id: string; resume: { approval_id: string; decision: Decision } };

export interface QueuedMessage {
  body: OrchestratorMessage;
  groupId: string;
  dedupId: string;
}

export const threadIdOf = (taskId: number) => `task-${taskId}`;

export function taskCreatedMessage(taskId: number): QueuedMessage {
  return { body: { type: "task.created", task_id: taskId }, groupId: threadIdOf(taskId), dedupId: `task-created-${taskId}` };
}

export function ownerDecisionMessage(taskId: number, approvalId: string, decision: Decision): QueuedMessage {
  return {
    body: {
      type: "owner.decision",
      task_id: taskId,
      thread_id: threadIdOf(taskId),
      resume: { approval_id: approvalId, decision },
    },
    groupId: threadIdOf(taskId),
    // One decision per approval: a resend within SQS's 5-minute window is deduplicated.
    dedupId: `approval-${approvalId}`,
  };
}

export type SendResult = "sent" | "disabled";

export interface OrchestratorQueue {
  readonly enabled: boolean;
  send(message: QueuedMessage): Promise<SendResult>;
}

/** Minimal SQS client surface (tests pass a fake). */
export interface SqsLike {
  send(command: SendMessageCommand): Promise<unknown>;
}

export class SqsOrchestratorQueue implements OrchestratorQueue {
  readonly enabled = true;
  constructor(
    private readonly queueUrl: string,
    private readonly client: SqsLike = new SQSClient({}),
  ) {}

  async send(message: QueuedMessage): Promise<SendResult> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.body),
        MessageGroupId: message.groupId,
        MessageDeduplicationId: message.dedupId,
      }),
    );
    return "sent";
  }
}

export const disabledQueue: OrchestratorQueue = {
  enabled: false,
  send: async () => "disabled",
};

export function queueFromEnv(env: Readonly<Record<string, string | undefined>>, client?: SqsLike): OrchestratorQueue {
  const url = env[QUEUE_URL_ENV];
  return url ? new SqsOrchestratorQueue(url, client) : disabledQueue;
}

export type EnqueueOutcome = SendResult | "failed";

/** Sends, logging a failure as one line (error class only) instead of throwing. */
export async function trySend(queue: OrchestratorQueue, message: QueuedMessage): Promise<EnqueueOutcome> {
  try {
    return await queue.send(message);
  } catch (err) {
    console.error(`[orchestrator-queue] send failed (${err instanceof Error ? err.name : "error"})`);
    return "failed";
  }
}

let processQueue: OrchestratorQueue | undefined;

/** The process-wide queue (one SQS client per Lambda instance). */
export function orchestratorQueue(): OrchestratorQueue {
  processQueue ??= queueFromEnv(process.env);
  return processQueue;
}
