// Placeholder webhook relay (P2-06) until the real bundle from agents/webhook-relay is wired in.
// Reads no secret and enqueues nothing; GitHub records the delivery as failed and can redeliver it.
export const handler = async () => ({
  statusCode: 503,
  headers: { "content-type": "text/plain" },
  body: "relay not deployed yet",
});
