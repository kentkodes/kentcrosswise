// Sending normalized events to the orchestrator's SQS FIFO queue, the same way kcw-report does
// (P2-03): MessageGroupId = the task's thread id (D5), MessageDeduplicationId = the delivery id (§4.3).
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import type { GitHubEventPayload } from "./normalize";

/** Environment variable holding the orchestrator queue URL (same name as kcw-report's). */
export const QUEUE_URL_ENV = "KCW_ORCHESTRATOR_QUEUE_URL";

/**
 * What the relay puts on `orchestrator-in` (§4.3 `{thread_id, resume: {event, head_sha, payload}}`).
 * `source` tells it apart from kcw-report messages (`AgentReport`, which has `agent`/`event_type`).
 */
export interface GitHubEventMessage {
  source: "github";
  delivery_id: string;
  task_id: number;
  /** `task-<id>`; also the MessageGroupId. */
  thread_id: string;
  resume: {
    /** `<event>.<action>` (e.g. `pull_request.opened`, `workflow_run.completed`) or `push`. */
    event: string;
    head_sha: string | null;
    payload: GitHubEventPayload;
  };
}

/** The part of the AWS SDK v3 SQS client we use. Inject a fake in tests. */
export interface SqsLike {
  send(command: SendMessageCommand): Promise<unknown>;
}

export interface OrchestratorQueue {
  send(message: GitHubEventMessage): Promise<void>;
}

export function sqsQueue(sqs: SqsLike, queueUrl: string): OrchestratorQueue {
  return {
    async send(message) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(message),
          MessageGroupId: message.thread_id,
          MessageDeduplicationId: message.delivery_id,
        }),
      );
    },
  };
}
