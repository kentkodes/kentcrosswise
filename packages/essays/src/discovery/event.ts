import { canonicalizeUrl, urlHash } from "../crawl/canonical";

export interface DiscoveryEvent {
  v: 1;
  type: "essay_url.discovered";
  source_id: string;
  url: string;
  url_hash: string;
  seed_item_id: string | null;
  link_id: string | null;
  hints: { title: string; author: string; lang: string };
  discovered_at: string;
  run_id: string;
  attempt: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEYS = ["v", "type", "source_id", "url", "url_hash", "seed_item_id", "link_id", "hints", "discovered_at", "run_id", "attempt"];
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
}

/** Exact allowlist and UTF-8 byte cap: no arbitrary payload fields can reach SQS. */
export function parseDiscoveryEvent(value: unknown): DiscoveryEvent {
  if (!object(value) || Object.keys(value).length !== KEYS.length || KEYS.some((k) => !(k in value))) throw new Error("invalid_event_fields");
  if (value.v !== 1 || value.type !== "essay_url.discovered" || !text(value.source_id, 64) || !text(value.url, 400)
    || canonicalizeUrl(value.url) !== value.url || value.url_hash !== urlHash(value.url)
    || !text(value.run_id, 36) || !UUID.test(value.run_id)
    || !Number.isSafeInteger(value.attempt) || Number(value.attempt) < 1 || Number(value.attempt) > 5
    || !text(value.discovered_at, 30) || !Number.isFinite(Date.parse(value.discovered_at))) throw new Error("invalid_event_value");
  for (const id of [value.seed_item_id, value.link_id]) if (id !== null && (typeof id !== "string" || !UUID.test(id))) throw new Error("invalid_event_id");
  const hints = value.hints;
  if (!object(hints) || Object.keys(hints).length !== 3 || !text(hints.title, 160) || !text(hints.author, 120)
    || !text(hints.lang, 12) || !/^[a-z]{2,3}(?:-[a-z0-9]+)?$/i.test(hints.lang)) throw new Error("invalid_event_hints");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") >= 1024) throw new Error("event_too_large");
  return value as unknown as DiscoveryEvent;
}

/** The adapter owns the SDK and queue URL; the essays package adds no AWS dependency. */
export interface QueueTransport { send(input: { QueueUrl: string; MessageBody: string }): Promise<unknown> }
export function createDiscoveryPublisher(transport: QueueTransport, queueUrl: string) {
  if (!queueUrl.startsWith("https://")) throw new Error("invalid_queue_url");
  return async (event: DiscoveryEvent): Promise<void> => {
    await transport.send({ QueueUrl: queueUrl, MessageBody: JSON.stringify(parseDiscoveryEvent(event)) });
  };
}
