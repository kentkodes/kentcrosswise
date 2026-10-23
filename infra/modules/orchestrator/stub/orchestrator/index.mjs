// Placeholder orchestrator (P2-06) until the real bundle from agents/orchestrator is wired in.
// It processes nothing: every message is reported as failed, so SQS retries it and finally moves it
// to the DLQ instead of the message being consumed and lost. Logs counts only, never bodies.
export const handler = async (event) => {
  const records = Array.isArray(event?.Records) ? event.Records : [];
  console.log(`orchestrator stub: ${records.length} message(s) left unprocessed`);
  return { batchItemFailures: records.map((r) => ({ itemIdentifier: r.messageId })) };
};
