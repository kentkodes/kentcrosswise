import { DEFAULT_USER_AGENT } from "../crawl/http";
import type { Db } from "../db";

export type Health = "ok" | "degraded" | "broken";
/** Why a source is paused; null = running. `failures` clears on a good nightly check, the others need the owner. */
export type PausedBy = "owner" | "failures" | "block";

export const DEFAULT_MIN_DELAY_MS = 3000;
export const DEFAULT_DAILY_REQUEST_CAP = 500;

export interface CrawlRules {
  minDelayMs: number;
  /** Fixed at 1: one request at a time per source. */
  maxConcurrency: 1;
  dailyRequestCap: number;
  /** Path prefixes a URL must start with; empty = any path on an allowed host. */
  allowPaths: string[];
  /** Hosts requests may go to; always includes the host of `baseUrl`. */
  allowHosts: string[];
  userAgent: string;
  respectCrawlDelay: boolean;
}

export interface SourceRecord {
  id: string;
  slug: string | null;
  name: string;
  baseUrl: string;
  discoveryMode: "seed_targeted" | "open_feed";
  discovery: Record<string, unknown>;
  extractorId: string | null;
  extractorVersion: string | null;
  crawlRules: CrawlRules;
  licensePolicy: "pd_only";
  health: Health;
  healthReason: string | null;
  consecutiveFailures: number;
  pausedBy: PausedBy | null;
  /** Derived: `pausedBy !== null`. The watcher exits at once when true. */
  paused: boolean;
  lastCheckedAt: Date | null;
  lastOkAt: Date | null;
  lastDiscoveryAt: Date | null;
  openIssue: number | null;
  nextFetchAt: Date | null;
  requestDay: string | null;
  requestCount: number;
}

export class SourceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceConfigError";
  }
}

interface SourceRow {
  id: string;
  slug: string | null;
  name: string;
  base_url: string;
  discovery_mode: "seed_targeted" | "open_feed";
  discovery: Record<string, unknown> | null;
  extractor_id: string | null;
  extractor_version: string | null;
  crawl_rules: Record<string, unknown> | null;
  license_policy: "pd_only";
  health: Health;
  health_reason: string | null;
  consecutive_failures: number;
  paused_by: PausedBy | null;
  last_checked_at: Date | string | null;
  last_ok_at: Date | string | null;
  last_discovery_at: Date | string | null;
  open_issue: number | null;
  next_fetch_at: Date | string | null;
  request_day: Date | string | null;
  request_count: number;
}

const toDate = (v: Date | string | null): Date | null => (v === null ? null : v instanceof Date ? v : new Date(v));

function dayString(v: Date | string | null): string | null {
  if (v === null) return null;
  return (v instanceof Date ? v.toISOString() : v).slice(0, 10);
}

function num(rules: Record<string, unknown>, key: string, fallback: number, min: number): number {
  const v = rules[key];
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) throw new SourceConfigError(`crawl_rules.${key} must be an integer >= ${min}`);
  return v;
}

function strings(rules: Record<string, unknown>, key: string): string[] {
  const v = rules[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new SourceConfigError(`crawl_rules.${key} must be a list of strings`);
  return v as string[];
}

/** Reads `sources.crawl_rules` (snake_case jsonb, design section 2) with the design defaults. */
export function parseCrawlRules(raw: Record<string, unknown> | null, baseUrl: string): CrawlRules {
  const r = raw ?? {};
  let baseHost: string;
  try {
    baseHost = new URL(baseUrl).host.toLowerCase();
  } catch {
    throw new SourceConfigError("base_url is not a URL");
  }
  const allowPaths = strings(r, "allow_paths");
  if (allowPaths.some((p) => !p.startsWith("/"))) throw new SourceConfigError("crawl_rules.allow_paths entries must start with /");
  const userAgent = r.user_agent === undefined ? DEFAULT_USER_AGENT : r.user_agent;
  if (typeof userAgent !== "string" || !userAgent.trim()) throw new SourceConfigError("crawl_rules.user_agent must be a non-empty string");
  if (r.max_concurrency !== undefined && r.max_concurrency !== 1) throw new SourceConfigError("crawl_rules.max_concurrency is fixed at 1");
  if (r.respect_crawl_delay !== undefined && r.respect_crawl_delay !== true) throw new SourceConfigError("crawl_rules.respect_crawl_delay must stay true");
  return {
    minDelayMs: num(r, "min_delay_ms", DEFAULT_MIN_DELAY_MS, 0),
    maxConcurrency: 1,
    dailyRequestCap: num(r, "daily_request_cap", DEFAULT_DAILY_REQUEST_CAP, 1),
    allowPaths,
    allowHosts: [...new Set([baseHost, ...strings(r, "allow_hosts").map((h) => h.toLowerCase())])],
    userAgent,
    respectCrawlDelay: true,
  };
}

export function toSourceRecord(row: SourceRow): SourceRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    baseUrl: row.base_url,
    discoveryMode: row.discovery_mode,
    discovery: row.discovery ?? {},
    extractorId: row.extractor_id,
    extractorVersion: row.extractor_version,
    crawlRules: parseCrawlRules(row.crawl_rules, row.base_url),
    licensePolicy: row.license_policy,
    health: row.health,
    healthReason: row.health_reason,
    consecutiveFailures: row.consecutive_failures,
    pausedBy: row.paused_by,
    paused: row.paused_by !== null,
    lastCheckedAt: toDate(row.last_checked_at),
    lastOkAt: toDate(row.last_ok_at),
    lastDiscoveryAt: toDate(row.last_discovery_at),
    openIssue: row.open_issue,
    nextFetchAt: toDate(row.next_fetch_at),
    requestDay: dayString(row.request_day),
    requestCount: row.request_count,
  };
}

const COLUMNS = `id, slug, name, base_url, discovery_mode, discovery, extractor_id, extractor_version, crawl_rules,
  license_policy, health, health_reason, consecutive_failures, paused_by, last_checked_at, last_ok_at,
  last_discovery_at, open_issue, next_fetch_at, request_day::text AS request_day, request_count`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Loads one source by uuid or slug (`gutenberg`); null if there is none. */
export async function loadSource(db: Db, idOrSlug: string): Promise<SourceRecord | null> {
  const where = UUID.test(idOrSlug) ? "id = $1" : "slug = $1";
  const { rows } = await db.query<SourceRow>(`SELECT ${COLUMNS} FROM sources WHERE ${where}`, [idOrSlug]);
  return rows[0] ? toSourceRecord(rows[0]) : null;
}

/** Every source, by slug then name. Includes paused ones: callers check `paused`. */
export async function loadSources(db: Db): Promise<SourceRecord[]> {
  const { rows } = await db.query<SourceRow>(`SELECT ${COLUMNS} FROM sources ORDER BY slug NULLS LAST, name`);
  return rows.map(toSourceRecord);
}

/** Sources a scheduled run may touch: those not paused. */
export async function loadRunnableSources(db: Db): Promise<SourceRecord[]> {
  return (await loadSources(db)).filter((s) => !s.paused);
}

export type AllowDecision =
  | { allowed: true }
  | { allowed: false; reason: "source_paused" | "invalid_url" | "host_not_allowed" | "path_not_allowed" };

/**
 * The source-level part of `isAllowed(sourceId, url)`: paused flag, host, and `allow_paths`. The
 * robots check (`policyAllows` in crawl/robots) is the other half and `politeGuard` runs both.
 */
export function sourceAllows(source: SourceRecord, url: string): AllowDecision {
  if (source.paused) return { allowed: false, reason: "source_paused" };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { allowed: false, reason: "invalid_url" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { allowed: false, reason: "invalid_url" };
  if (!source.crawlRules.allowHosts.includes(u.host.toLowerCase())) return { allowed: false, reason: "host_not_allowed" };
  const { allowPaths } = source.crawlRules;
  if (allowPaths.length && u.pathname !== "/robots.txt" && !allowPaths.some((p) => u.pathname.startsWith(p))) {
    return { allowed: false, reason: "path_not_allowed" };
  }
  return { allowed: true };
}
