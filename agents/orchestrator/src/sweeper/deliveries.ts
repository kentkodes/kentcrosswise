// Which failed webhook deliveries of the orchestrator App to redeliver (DESIGN §11 Q8 item 3).
//
// GitHub does not redeliver failed deliveries itself. "List deliveries for an app webhook"
// (GET /app/hook/deliveries, JWT) returns every attempt, newest first; a redelivery keeps the
// delivery's `guid` (the X-GitHub-Delivery header, which the relay uses as delivery id and
// inbound_events key) and gets a new `id`. This follows GitHub's "Automatically redelivering failed
// deliveries for a GitHub App webhook" guide: group attempts by guid and skip any guid that has
// succeeded once; plus the relay's own record and bounds so a delivery that keeps failing stops.

/** The fields of GitHub's "simple webhook delivery" used here. */
export interface WebhookDelivery {
  /** Attempt id (the redeliver endpoint's `delivery_id`). */
  id: number;
  /** Constant across redeliveries; equals X-GitHub-Delivery. */
  guid: string;
  delivered_at: string;
  redelivery: boolean;
  /** HTTP status the relay answered; 0 or absent-like values when GitHub got no answer (assumed). */
  status_code: number;
  event: string;
}

export interface RedeliveryOptions {
  now: Date;
  /** Only attempts delivered within this many minutes are considered. */
  lookbackMinutes: number;
  /** A guid with this many attempts in the lookback is given up on. */
  maxAttempts: number;
  /** At most this many redeliveries per run. */
  maxPerRun: number;
}

export const REDELIVERY_DEFAULTS = { lookbackMinutes: 180, maxAttempts: 4, maxPages: 5, maxPerRun: 20 } as const;

export type SkipReason = "succeeded" | "rejected" | "recorded" | "attempts" | "limit";

export interface RedeliveryPlan {
  /** Attempt ids to redeliver (the newest attempt of each guid). */
  redeliver: { id: number; guid: string }[];
  skipped: Record<SkipReason, number>;
}

const succeeded = (code: number) => code >= 200 && code < 400;
/**
 * 4xx: the relay refused the request itself (bad signature, headers or JSON, wrong method); the
 * same request would be refused again. 5xx (db or queue failure) and no answer (timeout,
 * connection error) are transient and worth another attempt.
 */
const rejected = (code: number) => code >= 400 && code < 500;

/**
 * Pure: picks the deliveries to redeliver. `recorded` holds guids found in inbound_events: the
 * relay enqueued them (it removes its record again when the queue send fails), so another attempt
 * would only be answered as a duplicate.
 */
export function selectRedeliveries(
  deliveries: readonly WebhookDelivery[],
  recorded: ReadonlySet<string>,
  opts: RedeliveryOptions,
): RedeliveryPlan {
  const since = opts.now.getTime() - opts.lookbackMinutes * 60_000;
  const byGuid = new Map<string, WebhookDelivery[]>();
  for (const d of deliveries) {
    const t = Date.parse(d.delivered_at);
    if (Number.isNaN(t) || t < since) continue;
    const list = byGuid.get(d.guid);
    if (list) list.push(d);
    else byGuid.set(d.guid, [d]);
  }

  const skipped: Record<SkipReason, number> = { succeeded: 0, rejected: 0, recorded: 0, attempts: 0, limit: 0 };
  const candidates: { id: number; guid: string; at: number }[] = [];
  for (const [guid, attempts] of byGuid) {
    if (attempts.some((a) => succeeded(a.status_code))) {
      skipped.succeeded += 1;
      continue;
    }
    const newest = attempts.reduce((a, b) => (Date.parse(b.delivered_at) > Date.parse(a.delivered_at) || (b.delivered_at === a.delivered_at && b.id > a.id) ? b : a));
    if (rejected(newest.status_code)) {
      skipped.rejected += 1;
      continue;
    }
    if (recorded.has(guid)) {
      skipped.recorded += 1;
      continue;
    }
    if (attempts.length >= opts.maxAttempts) {
      skipped.attempts += 1;
      continue;
    }
    candidates.push({ id: newest.id, guid, at: Date.parse(newest.delivered_at) });
  }

  // Oldest first: GitHub events for one task should reach the queue in roughly their order.
  candidates.sort((a, b) => a.at - b.at || a.id - b.id);
  const redeliver = candidates.slice(0, opts.maxPerRun).map(({ id, guid }) => ({ id, guid }));
  skipped.limit = candidates.length - redeliver.length;
  return { redeliver, skipped };
}
