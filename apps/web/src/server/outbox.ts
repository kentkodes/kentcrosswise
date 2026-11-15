// The web side of the orchestrator outbox (AR2 slice 1, migration 0011, DESIGN §4.3). A console task
// or an owner decision commits its outbox row in the SAME transaction as the change (insertOutbox,
// called by createTask and decideApproval). After the commit the action sends the message and marks
// the row sent in a separate call (deliverQueued). A crash or failure in between leaves the row
// unsent, and the sweeper's outbox part delivers it within 15 minutes; the consumer applies a
// message key once (receipts), so a send that was only not marked cannot act twice.
import { withDb, type Queryable } from "./db";
import { trySend, type OrchestratorQueue, type QueuedMessage } from "./orchestrator-queue";

/** Adds the message to the outbox in the caller's transaction (as web_rw). */
export async function insertOutbox(db: Queryable, message: QueuedMessage): Promise<void> {
  await db.query("INSERT INTO orchestrator_outbox (message_key, group_id, body) VALUES ($1, $2, $3)", [
    message.dedupId,
    message.groupId,
    JSON.stringify(message.body),
  ]);
}

export async function markOutboxSent(db: Queryable, messageKey: string): Promise<void> {
  await db.query("UPDATE orchestrator_outbox SET sent_at = now() WHERE message_key = $1 AND sent_at IS NULL", [messageKey]);
}

/**
 * `sent`: the queue accepted it and the row is marked. `queued`: the send or the mark failed; the
 * row stays unsent for the sweeper. `disabled`: no queue here (previews); the row stays.
 */
export type DeliveryOutcome = "sent" | "queued" | "disabled";

/** Sends an already committed outbox message and marks it sent. Never throws. */
export async function deliverQueued(queue: OrchestratorQueue, message: QueuedMessage): Promise<DeliveryOutcome> {
  const sent = await trySend(queue, message);
  if (sent === "disabled") return "disabled";
  if (sent === "failed") return "queued";
  try {
    await withDb("web_rw", (db) => markOutboxSent(db, message.dedupId));
  } catch (err) {
    console.error(`[orchestrator-queue] mark sent failed (${err instanceof Error ? err.name : "error"})`);
    return "queued";
  }
  return "sent";
}
