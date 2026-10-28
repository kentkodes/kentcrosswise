import type { Db } from "../db";
import { loadSource } from "../registry/source";

export type SlotDenied = "paused" | "daily_cap" | "wait" | "unknown_source";

export type SlotResult =
  | { granted: true; sourceId: string; nextFetchAt: Date }
  | { granted: false; reason: SlotDenied; waitMs: number };

export interface ClaimOptions {
  now?: Date;
  /** Crawl-delay from the source's robots.txt (ms); honored when the rules say `respectCrawlDelay`. */
  robotsCrawlDelayMs?: number;
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Takes the per-source request lease (design section 4). A request may start only after this returns
 * `granted`; the lease then blocks the next one for `max(min_delay_ms, robots Crawl-delay)`. The UPDATE
 * is the transactional claim: of several concurrent callers, one row update succeeds. Also enforces the
 * daily cap (the counter resets with the UTC day). Retry-After waits come through `noteRetryAfter`.
 * The E6 runner uses this same function.
 */
export async function claimFetchSlot(db: Db, sourceId: string, opts: ClaimOptions = {}): Promise<SlotResult> {
  const now = opts.now ?? new Date();
  const source = await loadSource(db, sourceId);
  if (!source) return { granted: false, reason: "unknown_source", waitMs: 0 };
  if (source.paused) return { granted: false, reason: "paused", waitMs: 0 };

  const day = utcDay(now);
  const used = source.requestDay === day ? source.requestCount : 0;
  if (used >= source.crawlRules.dailyRequestCap) return { granted: false, reason: "daily_cap", waitMs: 0 };

  if (source.nextFetchAt && source.nextFetchAt.getTime() > now.getTime()) {
    return { granted: false, reason: "wait", waitMs: source.nextFetchAt.getTime() - now.getTime() };
  }

  const delayMs = Math.max(source.crawlRules.minDelayMs, opts.robotsCrawlDelayMs ?? 0);
  const next = new Date(now.getTime() + delayMs);
  const { rows } = await db.query<{ id: string }>(
    `UPDATE sources
        SET next_fetch_at = $2::timestamptz,
            request_count = CASE WHEN request_day = $3::date THEN request_count + 1 ELSE 1 END,
            request_day = $3::date
      WHERE id = $1 AND paused_by IS NULL
        AND (next_fetch_at IS NULL OR next_fetch_at <= $4::timestamptz)
        AND (request_day IS DISTINCT FROM $3::date OR request_count < $5)
      RETURNING id`,
    [source.id, next.toISOString(), day, now.toISOString(), source.crawlRules.dailyRequestCap],
  );
  // No row: someone else claimed it between our read and the update. Wait a full delay.
  if (!rows[0]) return { granted: false, reason: "wait", waitMs: delayMs };
  return { granted: true, sourceId: source.id, nextFetchAt: next };
}

/** Pushes the lease out to honor a Retry-After (never earlier than it already is). */
export async function noteRetryAfter(db: Db, sourceId: string, retryAfterMs: number, now: Date = new Date()): Promise<void> {
  await db.query(
    `UPDATE sources
        SET next_fetch_at = GREATEST(COALESCE(next_fetch_at, $2::timestamptz), $2::timestamptz + make_interval(secs => $3::double precision))
      WHERE id = $1`,
    [sourceId, now.toISOString(), retryAfterMs / 1000],
  );
}

export interface WaitOptions extends ClaimOptions {
  sleep?: (ms: number) => Promise<void>;
  /** Give up (denied "wait") if the lease is further away than this. Default 60 s. */
  maxWaitMs?: number;
  /** Clock used after each sleep; tests inject a fake one. */
  clock?: () => Date;
}

/** Claims a slot, sleeping until the lease is free. Paused, capped or unknown sources return at once. */
export async function waitForFetchSlot(db: Db, sourceId: string, opts: WaitOptions = {}): Promise<SlotResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clock = opts.clock ?? (() => opts.now ?? new Date());
  const maxWaitMs = opts.maxWaitMs ?? 60_000;
  let waited = 0;
  for (;;) {
    const res = await claimFetchSlot(db, sourceId, { ...opts, now: clock() });
    if (res.granted || res.reason !== "wait") return res;
    if (waited + res.waitMs > maxWaitMs) return res;
    waited += res.waitMs;
    await sleep(res.waitMs);
  }
}
