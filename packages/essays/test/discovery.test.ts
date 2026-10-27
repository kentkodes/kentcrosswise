import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { urlHash } from "../src/crawl/canonical";
import { createDiscoveryPublisher, parseDiscoveryEvent, type DiscoveryEvent } from "../src/discovery/event";
import { parseGutenbergCatalog } from "../src/discovery/gutenberg";
import { readWikiMetadata } from "../src/discovery/wikisource";
import { discoverApprovedUrls, reemitStalledUrls, type WatcherOptions } from "../src/discovery/watcher";
import { addSource, essaysDb, type TestPg } from "./db-helpers";
import type { Db } from "../src/db";

// Hand-authored public-domain bibliographic metadata, no essay body text. Source format:
// https://www.gutenberg.org/ebooks/offline_catalogs.html (Text#,Type,Title,Authors,Language).
const CSV = 'Text#,Type,Title,Authors,Language\r\n1,Text,"Of Studies","Bacon, Francis",en\r\n2,Text,"Different, title","Bacon, Francis",en\r\n3,Text,Other,Other,fr\r\n';
const NOW = new Date("2026-10-27T20:00:00Z");
function sample(): DiscoveryEvent {
  const url = "https://www.gutenberg.org/ebooks/1";
  return { v: 1, type: "essay_url.discovered", source_id: "gutenberg", url, url_hash: urlHash(url),
    seed_item_id: randomUUID(), link_id: randomUUID(), hints: { title: "Of Studies", author: "Bacon, Francis", lang: "en" },
    discovered_at: NOW.toISOString(), run_id: randomUUID(), attempt: 1 };
}

describe("bounded discovery contracts", () => {
  it("parses quoted CSV metadata, rejects malformed rows and never treats non-English as eligible", () => {
    expect(parseGutenbergCatalog(CSV)).toHaveLength(2);
    expect(parseGutenbergCatalog(CSV)[1]!.title).toBe("Different, title");
    expect(() => parseGutenbergCatalog('Text#,Type,Title,Authors,Language\n1,Text,"oops')).toThrow("catalog_bad_csv");
    expect(() => parseGutenbergCatalog("Title\nx")).toThrow("catalog_missing_header");
  });
  it("rejects unknown fields, forged identities, and UTF-8 payloads >=1KB", () => {
    expect(parseDiscoveryEvent(sample()).v).toBe(1);
    expect(() => parseDiscoveryEvent({ ...sample(), body: "not allowed" })).toThrow();
    expect(() => parseDiscoveryEvent({ ...sample(), url_hash: "0".repeat(64) })).toThrow();
    const large = sample(); large.hints.title = "界".repeat(160); large.hints.author = "界".repeat(120);
    expect(() => parseDiscoveryEvent(large)).toThrow("event_too_large");
    expect(() => parseDiscoveryEvent({ ...sample(), hints: { ...sample().hints, content: "bad" } })).toThrow();
  });
  it("publisher serializes only valid metadata to the injected queue adapter", async () => {
    const sent: unknown[] = [];
    const publish = createDiscoveryPublisher({ send: async (input) => { sent.push(input); } }, "https://sqs.example/essay-urls");
    const event = sample(); await publish(event);
    expect(sent).toEqual([{ QueueUrl: "https://sqs.example/essay-urls", MessageBody: JSON.stringify(event) }]);
    await expect(publish({ ...event, body: "bad" } as DiscoveryEvent)).rejects.toThrow();
    expect(sent).toHaveLength(1);
  });
  it("backs off HTTP200 maxlag errors at least5s, honors Retry-After and bounds retries", async () => {
    const waits: number[] = [], requested: string[] = [];
    let calls = 0;
    const client = { get: async (url: string) => {
      requested.push(url); calls++;
      return { ok: true as const, status: 200, url, attempts: 1, headers: { "retry-after": "9" }, body: JSON.stringify(calls < 3
        ? { error: { code: "maxlag" } }
        : { query: { pages: [{ ns: 0, title: "Of Studies", fullurl: "https://en.wikisource.org/wiki/Of_Studies", revisions: [{ revid: 123 }] }] } }) };
    } };
    expect(await readWikiMetadata(client, "Of Studies", async (ms) => { waits.push(ms); })).toMatchObject({ revisionId: 123 });
    expect(waits).toEqual([9000, 10000]);
    expect(requested.every((u) => new URL(u).searchParams.get("maxlag") === "5")).toBe(true);
    expect(requested.every((u) => !new URL(u).searchParams.has("rvslots"))).toBe(true);
  });
});

let pg: TestPg, db: Db;
beforeAll(async () => { ({ pg, db } = await essaysDb()); });
beforeEach(async () => { await db.query("DELETE FROM sources"); await db.query("DELETE FROM seed_items"); });
afterAll(async () => { await pg.close(); });

async function setup(kind: "catalog_csv" | "mediawiki_api" = "catalog_csv") {
  const host = kind === "catalog_csv" ? "https://www.gutenberg.org" : "https://en.wikisource.org";
  const id = await addSource(db, `test-${randomUUID()}`, `${host}/${randomUUID()}`, { min_delay_ms: 0, user_agent: "KentcrosswiseBot/1.0 (+https://example.org/contact)" });
  const candidate = kind === "catalog_csv" ? `${host}/ebooks/1` : `${host}/wiki/Of_Studies`;
  await db.query("UPDATE sources SET discovery=$2::jsonb WHERE id=$1", [id, JSON.stringify({ kind, url: `${host}/cache/epub/feeds/pg_catalog.csv` })]);
  const seed = (await db.query<{ id: string }>("INSERT INTO seed_items (title,author,status) VALUES ('Of Studies','Bacon, Francis','approved') RETURNING id")).rows[0]!.id;
  const link = (await db.query<{ id: string }>(`INSERT INTO seed_source_links (seed_item_id,source_id,candidate_url,candidate_title,candidate_author,tier,score,status)
    VALUES ($1,$2,$3,'Of Studies','Bacon, Francis','A',1,'approved') RETURNING id`, [seed, id, candidate])).rows[0]!.id;
  const requests: string[] = [], events: DiscoveryEvent[] = [];
  const opts: WatcherOptions = { db, sourceId: id, runId: randomUUID(), now: () => NOW,
    publish: async (e) => { events.push(e); }, http: { fetch: async (input) => {
      const url = String(input); requests.push(url);
      return new Response(new URL(url).pathname === "/robots.txt" ? "User-agent: *\nDisallow:\n" : CSV, { status: 200 });
    }, sleep: async () => {}, maxRetries: 0 } };
  return { opts, id, link, candidate, requests, events };
}

describe("approved-only watcher and recovery", () => {
  it("emits only approved URLs once, including concurrent reruns; requests only catalog and robots", async () => {
    const s = await setup();
    const results = await Promise.all([discoverApprovedUrls(s.opts), discoverApprovedUrls({ ...s.opts, runId: randomUUID() })]);
    expect(results.reduce((n, r) => n + r.emitted, 0)).toBe(1);
    expect(s.events).toHaveLength(1);
    expect(s.requests.every((u) => ["/robots.txt", "/cache/epub/feeds/pg_catalog.csv"].includes(new URL(u).pathname))).toBe(true);
    expect((await discoverApprovedUrls(s.opts)).emitted).toBe(0);
  });
  it("crash after insert recovers after24h, then waits another24h; progressed rows never reemit", async () => {
    const s = await setup();
    await expect(discoverApprovedUrls({ ...s.opts, publish: async () => { throw new Error("queue_down"); } })).rejects.toThrow("queue_down");
    expect(await reemitStalledUrls(s.opts)).toBe(0);
    const later = { ...s.opts, runId: randomUUID(), now: () => new Date(NOW.getTime() + 86400_001) };
    expect(await reemitStalledUrls(later)).toBe(1);
    expect(await reemitStalledUrls(later)).toBe(0);
    await db.query("UPDATE essay_urls SET status='fetched' WHERE url=$1", [s.candidate]);
    expect(await reemitStalledUrls({ ...later, now: () => new Date(NOW.getTime() + 3 * 86400_000) })).toBe(0);
  });
  it("honors source pause, pipeline pause, rejected links and unresolved contact", async () => {
    const s = await setup();
    await db.query("UPDATE sources SET paused_by='owner' WHERE id=$1", [s.id]);
    expect((await discoverApprovedUrls(s.opts)).skipped).toBe(true);
    await db.query("UPDATE sources SET paused_by=NULL WHERE id=$1", [s.id]);
    await db.query("UPDATE system_flags SET value='true' WHERE key='pipelines_paused'");
    try { expect((await discoverApprovedUrls(s.opts)).skipped).toBe(true); }
    finally { await db.query("UPDATE system_flags SET value='false' WHERE key='pipelines_paused'"); }
    await db.query("UPDATE seed_source_links SET status='rejected' WHERE id=$1", [s.link]);
    expect((await discoverApprovedUrls(s.opts)).emitted).toBe(0);
    expect(s.requests).toHaveLength(0);
    await db.query("UPDATE sources SET crawl_rules=$2::jsonb WHERE id=$1", [s.id,
      JSON.stringify({ user_agent: "KentcrosswiseBot/1.0 (+https://kentcrosswise.invalid/bot)" })]);
    await expect(discoverApprovedUrls(s.opts)).rejects.toThrow("contact_not_configured");
  });
  it("current Wikisource wildcard /w/ disallow refuses API without making any API request", async () => {
    const s = await setup("mediawiki_api");
    s.opts.http!.fetch = async (input) => {
      const url = String(input); s.requests.push(url);
      return new Response("User-agent: *\nDisallow: /w/\nDisallow: /api/\nAllow: /w/api.php?action=mobileview&\n");
    };
    await expect(discoverApprovedUrls(s.opts)).rejects.toThrow("robots_disallow");
    expect(s.requests.map((u) => new URL(u).pathname)).toEqual(["/robots.txt"]);
    expect(s.events).toHaveLength(0);
    expect((await db.query<{ paused_by: string }>("SELECT paused_by FROM sources WHERE id=$1", [s.id])).rows[0]!.paused_by).toBe("block");
  });
  it("sends catalog ETag and reuses a validated snapshot on304 through robots and rate guards", async () => {
    const s = await setup();
    let saved: { body: string; etag: string | null } | null = null;
    const tags: (string | null)[] = [];
    s.opts.catalogCache = { get: async () => saved, put: async (_id, value) => { saved = value; } };
    s.opts.http!.fetch = async (input, init) => {
      if (new URL(String(input)).pathname === "/robots.txt") return new Response("User-agent: *\nDisallow:\n");
      const tag = new Headers(init?.headers).get("if-none-match"); tags.push(tag);
      return tag ? new Response(null, { status: 304 }) : new Response(CSV, { headers: { etag: '"catalog-v1"' } });
    };
    expect((await discoverApprovedUrls(s.opts)).emitted).toBe(1);
    expect((await discoverApprovedUrls(s.opts)).emitted).toBe(0);
    expect(tags).toEqual([null, '"catalog-v1"']);
  });
  it("uses the fixed pause accessor as pipeline_rw while direct flags remain private", async () => {
    const s = await setup();
    await db.query("SET ROLE pipeline_rw");
    try {
      expect((await discoverApprovedUrls(s.opts)).emitted).toBe(1);
      await expect(db.query("SELECT * FROM system_flags")).rejects.toThrow(/permission denied/);
    }
    finally { await db.query("RESET ROLE"); }
    expect(s.events).toHaveLength(1);
  });
});
