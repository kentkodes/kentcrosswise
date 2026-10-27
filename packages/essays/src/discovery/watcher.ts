import type { Db } from "../db";
import { canonicalizeUrl, urlHash } from "../crawl/canonical";
import { createPoliteClient, type PoliteOptions } from "../crawl/polite";
import { loadSource, sourceAllows, type SourceRecord } from "../registry/source";
import { recordSourceEvent } from "../registry/health";
import { parseDiscoveryEvent, type DiscoveryEvent } from "./event";
import { gutenbergId, parseGutenbergCatalog } from "./gutenberg";
import { readWikiMetadata, wikisourceTitle } from "./wikisource";

interface ApprovedLink {
  id: string; seed_item_id: string; source_id: string; candidate_url: string; candidate_title: string; candidate_author: string;
}
export interface WatcherOptions {
  db: Db;
  sourceId: string;
  runId: string;
  publish: (event: DiscoveryEvent) => Promise<void>;
  now?: () => Date;
  /** Test fetch still traverses the actual robots and lease guards. */
  http?: Omit<PoliteOptions, "db" | "source" | "now" | "maxBodyBytes">;
  /** Private S3 adapter in deployment; tests use memory. ETags are metadata, never essay text. */
  catalogCache?: CatalogCache;
}
export interface CatalogSnapshot { body: string; etag: string | null }
export interface CatalogCache {
  get(sourceId: string): Promise<CatalogSnapshot | null>;
  put(sourceId: string, snapshot: CatalogSnapshot): Promise<void>;
}
export interface DiscoveryResult { discovered: number; emitted: number; skipped: boolean }
const CATALOG_URL = "https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv";

async function runnable(db: Db, sourceId: string): Promise<SourceRecord | null> {
  const flags = await db.query<{ paused: unknown }>("SELECT public.pipeline_is_paused() AS paused");
  // A missing or malformed flag is a fail-closed configuration error.
  if (flags.rows[0]?.paused !== false) return null;
  const source = await loadSource(db, sourceId);
  return source && !source.paused && source.discoveryMode === "seed_targeted" ? source : null;
}

async function approvedLinks(db: Db, sourceId: string): Promise<ApprovedLink[]> {
  const { rows } = await db.query<ApprovedLink>(
    `SELECT l.id, l.seed_item_id, l.source_id, l.candidate_url, l.candidate_title, l.candidate_author
       FROM seed_source_links l JOIN seed_items s ON s.id = l.seed_item_id
      WHERE l.source_id = $1 AND l.status = 'approved' AND s.status = 'approved'
      ORDER BY l.id`, [sourceId]);
  return rows;
}

function eventFor(source: SourceRecord, link: ApprovedLink, runId: string, now: Date): DiscoveryEvent {
  const url = canonicalizeUrl(link.candidate_url);
  if (!url) throw new Error("invalid_approved_url");
  return parseDiscoveryEvent({ v: 1, type: "essay_url.discovered", source_id: source.slug ?? source.id,
    url, url_hash: urlHash(url), seed_item_id: link.seed_item_id, link_id: link.id,
    hints: { title: link.candidate_title, author: link.candidate_author, lang: "en" },
    discovered_at: now.toISOString(), run_id: runId, attempt: 1 });
}

/** Insert then send: the 24-hour recovery sweep repairs crashes between these operations. */
async function recordDiscovery(opts: WatcherOptions, source: SourceRecord, link: ApprovedLink): Promise<boolean> {
  if (!await runnable(opts.db, source.id)) return false;
  const now = (opts.now ?? (() => new Date()))();
  const event = eventFor(source, link, opts.runId, now);
  const { rows } = await opts.db.query(
    `INSERT INTO essay_urls (url, source_id, url_hash, seed_item_id, link_id, discovery_run_id, first_seen_at)
     SELECT $1, $2, $3, $4, $5, $6, $7::timestamptz
      WHERE EXISTS (SELECT 1 FROM seed_source_links WHERE id=$5 AND status='approved')
     ON CONFLICT DO NOTHING RETURNING url`,
    [event.url, source.id, event.url_hash, link.seed_item_id, link.id, opts.runId, now.toISOString()]);
  if (!rows.length) return false;
  if (!await runnable(opts.db, source.id)) return true;
  await opts.publish(event);
  await opts.db.query("UPDATE essay_urls SET last_event_at=$2::timestamptz WHERE url=$1 AND status='new'", [event.url, now.toISOString()]);
  return true;
}

/** Metadata discovery only. No request is ever made to the approved essay's body URL. */
export async function discoverApprovedUrls(opts: WatcherOptions): Promise<DiscoveryResult> {
  const source = await runnable(opts.db, opts.sourceId);
  if (!source) return { discovered: 0, emitted: 0, skipped: true };
  if (source.crawlRules.userAgent.includes(".invalid")) throw new Error("contact_not_configured");
  const links = await approvedLinks(opts.db, source.id);
  if (!links.length) return { discovered: 0, emitted: 0, skipped: false };
  const now = opts.now ?? (() => new Date());
  const client = createPoliteClient({ ...opts.http, db: opts.db, source, now, maxBodyBytes: 64 * 1024 * 1024 });
  const sleep = opts.http?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const found: ApprovedLink[] = [];
  try {
    if (source.discovery.kind === "catalog_csv") {
      // The official published metadata endpoint is the sole allowed Gutenberg fetch here.
      if (source.discovery.url !== CATALOG_URL) throw new Error("catalog_endpoint_not_allowed");
      const cached = await opts.catalogCache?.get(source.id);
      const result = await client.get(CATALOG_URL, cached?.etag ? { ifNoneMatch: cached.etag } : undefined);
      if (!result.ok) throw new Error(result.reason === "guard_refused" ? result.detail ?? result.reason : result.reason);
      if (result.status === 304 && !cached) throw new Error("catalog_cache_missing");
      const body = result.status === 304 ? cached!.body : result.body;
      const ids = new Set(parseGutenbergCatalog(body).map((e) => e.id));
      if (result.status !== 304) await opts.catalogCache?.put(source.id, { body, etag: result.headers.etag ?? null });
      for (const link of links) {
        const canonical = canonicalizeUrl(link.candidate_url);
        if (canonical && sourceAllows(source, canonical).allowed && ids.has(gutenbergId(canonical) ?? -1)) found.push(link);
      }
    } else if (source.discovery.kind === "mediawiki_api") {
      for (const link of links) {
        if (!await runnable(opts.db, source.id)) break;
        const canonical = canonicalizeUrl(link.candidate_url);
        if (!canonical || !sourceAllows(source, canonical).allowed) continue;
        const title = wikisourceTitle(canonical);
        if (!title) continue;
        const metadata = await readWikiMetadata(client, title, sleep);
        // Redirects/normalizations to a different work require a fresh review; never silently retarget.
        if (metadata && canonicalizeUrl(metadata.url) === canonical) found.push(link);
      }
    } else throw new Error("discovery_kind_not_supported");
  } catch (error) {
    const reason = error instanceof Error ? error.message : "discovery_failure";
    const block = reason === "robots_disallow" || reason === "blocked_401" || reason === "blocked_403";
    await recordSourceEvent(opts.db, source.id, block ? { kind: "block", reason } : { kind: "failure", reason }, now());
    throw error;
  }
  let discovered = 0, emitted = 0;
  // A publishing error deliberately escapes without inventing a source/network health failure.
  for (const link of found) {
    let sent = false;
    const publish = async (event: DiscoveryEvent) => { await opts.publish(event); sent = true; };
    if (await recordDiscovery({ ...opts, publish }, source, link)) discovered++;
    if (sent) emitted++;
  }
  await recordSourceEvent(opts.db, source.id, { kind: "success", mode: "discover" }, now());
  return { discovered, emitted, skipped: false };
}

/** At-least-once re-emission of stalled `new` URLs; no schema change or extra queue is needed. */
export async function reemitStalledUrls(opts: WatcherOptions): Promise<number> {
  const source = await runnable(opts.db, opts.sourceId);
  if (!source) return 0;
  const now = (opts.now ?? (() => new Date()))();
  const { rows } = await opts.db.query<ApprovedLink & { url: string; first_seen_at: Date | string; attempts: number }>(
    `SELECT l.id, l.seed_item_id, l.source_id, l.candidate_url, l.candidate_title, l.candidate_author, u.url, u.first_seen_at, u.attempts
       FROM essay_urls u JOIN seed_source_links l ON l.id=u.link_id JOIN seed_items s ON s.id=l.seed_item_id
      WHERE u.source_id=$1 AND l.source_id=u.source_id AND u.seed_item_id=l.seed_item_id
        AND u.status='new' AND u.attempts < 5 AND l.status='approved' AND s.status='approved'
        AND COALESCE(u.last_event_at, u.first_seen_at) <= $2::timestamptz - interval '24 hours'
      ORDER BY u.url LIMIT 500`, [source.id, now.toISOString()]);
  let emitted = 0;
  for (const row of rows) {
    if (!await runnable(opts.db, source.id)) break;
    if (canonicalizeUrl(row.candidate_url) !== row.url || !sourceAllows(source, row.url).allowed) continue;
    const event = eventFor(source, row, opts.runId, new Date(row.first_seen_at));
    // Fetch-attempt number, not an SQS delivery counter; duplicates retain the same value.
    event.attempt = row.attempts + 1;
    await opts.publish(event);
    await opts.db.query("UPDATE essay_urls SET last_event_at=$2::timestamptz, discovery_run_id=$3 WHERE url=$1 AND status='new'", [row.url, now.toISOString(), opts.runId]);
    emitted++;
  }
  return emitted;
}
