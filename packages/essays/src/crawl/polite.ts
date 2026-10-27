import type { Db } from "../db";
import { sourceAllows, type SourceRecord } from "../registry/source";
import { createHttpClient, fetchRobotsTxt, type HttpClient, type HttpResult } from "./http";
import { noteRetryAfter, waitForFetchSlot } from "./lease";
import { RobotsCache, robotsAllows, robotsCrawlDelayMs } from "./robots";

export interface PoliteOptions {
  db: Db;
  source: SourceRecord;
  cache?: RobotsCache;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => Date;
  maxRetries?: number;
  baseDelayMs?: number;
  /** Bounded catalog metadata can exceed the small default page limit. */
  maxBodyBytes?: number;
  /** How long a request may wait for the rate lease before the guard refuses it. */
  maxLeaseWaitMs?: number;
}

/**
 * The only way pipeline code should fetch from a source: every request (redirect hops and retries
 * included) passes the source rules (paused, host, allow_paths), the cached robots.txt (fail closed)
 * and the shared rate lease, with the source's User-Agent. A Retry-After pushes the lease out.
 */
export function createPoliteClient(opts: PoliteOptions) {
  const { db, source } = opts;
  const cache = opts.cache ?? new RobotsCache();
  const now = opts.now ?? (() => new Date());
  const ua = source.crawlRules.userAgent;

  const robotsFor = (origin: string) => cache.getOrLoad(origin, now(), () => fetchRobotsTxt(client, origin));

  const client: HttpClient = createHttpClient({
    userAgent: ua,
    ...(opts.fetch && { fetch: opts.fetch }),
    ...(opts.sleep && { sleep: opts.sleep }),
    ...(opts.random && { random: opts.random }),
    ...(opts.maxRetries !== undefined && { maxRetries: opts.maxRetries }),
    ...(opts.baseDelayMs !== undefined && { baseDelayMs: opts.baseDelayMs }),
    ...(opts.maxBodyBytes !== undefined && { maxBodyBytes: opts.maxBodyBytes }),
    guard: async (url) => {
      const allowed = sourceAllows(source, url);
      if (!allowed.allowed) return { ok: false, reason: allowed.reason };
      const u = new URL(url);
      let crawlDelay = 0;
      // robots.txt itself is exempt from the robots check (it would recurse) but not from the lease.
      if (u.pathname !== "/robots.txt") {
        const policy = await robotsFor(u.origin);
        if (!robotsAllows(policy.parsed, ua, u.pathname + u.search)) {
          return { ok: false, reason: policy.status === "ok" || policy.status === "not_found" ? "robots_disallow" : `robots_${policy.status}` };
        }
        crawlDelay = robotsCrawlDelayMs(policy.parsed, ua);
      }
      const slot = await waitForFetchSlot(db, source.id, {
        robotsCrawlDelayMs: crawlDelay,
        clock: now,
        ...(opts.sleep && { sleep: opts.sleep }),
        ...(opts.maxLeaseWaitMs !== undefined && { maxWaitMs: opts.maxLeaseWaitMs }),
      });
      return slot.granted ? { ok: true } : { ok: false, reason: `lease_${slot.reason}` };
    },
  });

  async function get(url: string, conditional?: { ifNoneMatch?: string }): Promise<HttpResult> {
    const res = await client.get(url, conditional);
    if (!res.ok && res.retryAfterMs !== undefined) await noteRetryAfter(db, source.id, res.retryAfterMs, now());
    return res;
  }

  return { get, cache, userAgent: ua };
}
