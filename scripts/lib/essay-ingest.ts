// Essay ingest from the Project Gutenberg rsync mirror (docs/essays/GUTENBERG-SLICE-PLAN.md section 12).
//   fetch phase: rsync one book directory at a time into a local directory, then extract and validate
//                in memory and report a verdict. No database, no AWS.
//   store phase: per approved book, extract, validate, put the text in S3 (content-addressed key), then
//                one transaction (essays row + essay_urls status), or a quarantine row.
// rsync runs through an injected runner (never a shell); S3 and the database are injected too.
// Essay text never reaches a log line, an error or stdout: output is ids, counts and fixed codes.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "../../packages/essays/src/db";
import { canonicalizeUrl, urlHash } from "../../packages/essays/src/crawl/canonical";
import { gutenbergId } from "../../packages/essays/src/discovery/gutenberg";
import { EXTRACTOR_VERSION, extractGutenbergText, type Extraction } from "../../packages/essays/src/extract/gutenberg-text";
import { NO_USABLE_TEXT, bookDir, decodeUtf8, parseBookId, pickTextFile } from "../../packages/essays/src/fetch/gutenberg-path";
import { gutenbergEbookUrl } from "../../packages/essays/src/match/gutenberg-records";
import { recordOutcome } from "../../packages/essays/src/registry/health";
import { GUTENBERG_SLUG } from "../../packages/essays/src/registry/bootstrap";
import { validateExtraction, type ReasonCode } from "../../packages/essays/src/validate/basic";

export const ESSAY_TEXT_PREFIX = "essays/text/";
/** Tried in order; the second only after a connection-class failure of the first. */
export const MIRRORS = ["rsync.ibiblio.org", "gutenberg.pglaf.org"] as const;
export const RSYNC_TIMEOUT_SECONDS = 300;
export const PAUSE_BETWEEN_BOOKS_MS = 10_000;

export type FetchCode = "mirror_unreachable" | "mirror_refused" | "timeout" | "no_files" | "rsync_failed";
export type StoreCode =
  | "stored" | "duplicate" | "quarantined" | "not_approved" | "already_processed" | "no_files" | typeof NO_USABLE_TEXT;

/** A fixed-code failure (never carries book content or connection details). */
export class IngestError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "IngestError";
  }
}

// ------------------------------------------------------------------ ids

/** Space- or comma-separated book ids, validated, de-duplicated, order kept. The bad value is not echoed. */
export function parseIds(input: string): number[] {
  const tokens = input.split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0) throw new IngestError("no_book_ids");
  const ids: number[] = [];
  for (const t of tokens) {
    const id = parseBookId(t);
    if (id === null) throw new IngestError("invalid_book_id");
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

// ------------------------------------------------------------------ rsync

export interface RsyncCommand {
  command: string;
  args: string[];
}
/** exitCode null = the process could not be started. */
export type RunRsync = (cmd: RsyncCommand) => Promise<{ exitCode: number | null }>;

/** `timeout 300 rsync ...` for one book directory; spawned without a shell, so no quoting. */
export function rsyncCommand(mirror: string, id: number, destDir: string): RsyncCommand {
  return {
    command: "timeout",
    args: [
      String(RSYNC_TIMEOUT_SECONDS), "rsync", "-rt", "--no-motd", "--contimeout=30", "--timeout=60", "--bwlimit=500",
      "--max-size=25m", "--include=*.txt", "--exclude=*",
      `rsync://${mirror}/gutenberg/${bookDir(id)}`,
      `${destDir.replace(/[\\/]+$/, "")}/`,
    ],
  };
}

/**
 * Exit code to fixed code (null = success). 124 is GNU timeout; rsync: 10 socket I/O (cannot connect),
 * 5 and 12 protocol start-up and stream errors (includes "@ERROR: max connections", access denied),
 * 30 and 35 data and daemon-connection timeouts, 23 no such source (book not on the mirror),
 * 24 vanished files (fine).
 */
export function mapRsyncExit(exitCode: number | null): FetchCode | null {
  switch (exitCode) {
    case 0:
    case 24:
      return null;
    case 10:
      return "mirror_unreachable";
    case 5:
    case 12:
      return "mirror_refused";
    case 30:
    case 35:
    case 124:
      return "timeout";
    case 23:
      return "no_files";
    default:
      return "rsync_failed";
  }
}

const TRY_NEXT_MIRROR: ReadonlySet<FetchCode> = new Set(["mirror_unreachable", "mirror_refused", "timeout"]);

/** The real runner: no shell, output discarded (it could name paths, never book text, but needs no log). */
export const spawnRunner: RunRsync = (cmd) =>
  new Promise((resolve) => {
    const child = spawn(cmd.command, cmd.args, { stdio: "ignore", shell: false });
    child.on("error", () => resolve({ exitCode: null }));
    child.on("close", (code) => resolve({ exitCode: code }));
  });

export interface FetchDeps {
  runRsync: RunRsync;
  /** Parent directory; book N lands in `<dir>/<N>/`. */
  dir: string;
  sleep?: (ms: number) => Promise<void>;
  mirrors?: readonly string[];
  log: (line: string) => void;
}

/** rsync one book, trying the mirrors in order. Returns null on success, else the fixed code of the last attempt. */
export async function rsyncBook(id: number, deps: FetchDeps): Promise<FetchCode | null> {
  const dest = join(deps.dir, String(id));
  await mkdir(dest, { recursive: true });
  let code: FetchCode | null = null;
  for (const mirror of deps.mirrors ?? MIRRORS) {
    const { exitCode } = await deps.runRsync(rsyncCommand(mirror, id, dest));
    code = mapRsyncExit(exitCode);
    deps.log(`essay-ingest: id=${id} mirror=${mirror} rsync_exit=${exitCode ?? "none"}${code ? ` code=${code}` : ""}`);
    if (code === null || !TRY_NEXT_MIRROR.has(code)) return code;
  }
  return code;
}

// ------------------------------------------------------------------ local book analysis

export type Analysis =
  | { code: "no_files" | typeof NO_USABLE_TEXT }
  | { code: null; file: string; bytes: number; files: Array<{ name: string; bytes: number }>; extraction: Extraction; reasons: ReasonCode[] };

/** Reads `<dir>/<id>/`, picks the UTF-8 text file, extracts and validates. Pure of any network or database. */
export async function analyzeBook(dir: string, id: number): Promise<Analysis> {
  const bookPath = join(dir, String(id));
  let names: string[];
  try {
    names = (await readdir(bookPath)).filter((n) => n.endsWith(".txt"));
  } catch {
    return { code: "no_files" };
  }
  if (names.length === 0) return { code: "no_files" };
  const file = pickTextFile(names, id);
  if (!file) return { code: NO_USABLE_TEXT };
  const bytes = await readFile(join(bookPath, file));
  const raw = decodeUtf8(bytes);
  if (raw === null) return { code: NO_USABLE_TEXT };
  const extraction = extractGutenbergText(raw);
  const verdict = validateExtraction(extraction);
  const files = await Promise.all(names.map(async (name) => ({ name, bytes: (await stat(join(bookPath, name))).size })));
  return { code: null, file, bytes: bytes.byteLength, files, extraction, reasons: verdict.ok ? [] : verdict.reasons };
}

// ------------------------------------------------------------------ fetch phase

export interface FetchResult {
  id: number;
  code: FetchCode | typeof NO_USABLE_TEXT | null;
  /** The validator verdict: "ok", "invalid", or null when no text was analysed. */
  verdict: "ok" | "invalid" | null;
}

/**
 * rsync, then extract and validate in memory, one book at a time with a pause between books. Prints codes
 * and counts only. Never prints mirror listing names (a hostile name could inject a workflow command);
 * `picked` is exactly `<id>-0.txt` or `<id>.txt`.
 */
export async function fetchPhase(ids: readonly number[], deps: FetchDeps): Promise<FetchResult[]> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const results: FetchResult[] = [];
  for (const [i, id] of ids.entries()) {
    if (i > 0) await sleep(PAUSE_BETWEEN_BOOKS_MS);
    const failed = await rsyncBook(id, deps);
    if (failed) {
      results.push({ id, code: failed, verdict: null });
      deps.log(`essay-ingest: id=${id} code=${failed}`);
      continue;
    }
    const a = await analyzeBook(deps.dir, id);
    if (a.code !== null) {
      results.push({ id, code: a.code, verdict: null });
      deps.log(`essay-ingest: id=${id} code=${a.code}`);
      continue;
    }
    const verdict = a.reasons.length ? "invalid" : "ok";
    results.push({ id, code: null, verdict });
    deps.log(`essay-ingest: id=${id} files=${a.files.length} picked=${a.file} bytes=${a.bytes} words=${a.extraction.wordCount} verdict=${verdict}${a.reasons.length ? ` reasons=${a.reasons.join(",")}` : ""}`);
  }
  return results;
}

// ------------------------------------------------------------------ store phase

/** Writes one object; resolves when the key exists afterwards (an existing identical key is success). */
export type PutObject = (key: string, body: Uint8Array) => Promise<void>;

export interface StoreDeps {
  db: Db;
  putObject: PutObject;
  dir: string;
  log: (line: string) => void;
}

export interface StoreResult {
  id: number;
  code: StoreCode;
}

interface ApprovedLink {
  link_id: string;
  seed_item_id: string;
  source_id: string;
  title: string;
  author: string;
  year: number | null;
}

export async function inTransaction(db: Db, body: () => Promise<void>): Promise<void> {
  await db.query("BEGIN");
  try {
    await body();
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}

/** The canonical Gutenberg URL of a book id (the key of essay_urls and essays.source_url). */
export function bookUrl(id: number): string {
  const url = canonicalizeUrl(gutenbergEbookUrl(id));
  if (!url || gutenbergId(url) !== id) throw new IngestError("invalid_book_id");
  return url;
}

/** One book; see section 12.4. Writes nothing for an unapproved id. */
async function storeBook(id: number, deps: StoreDeps): Promise<StoreCode> {
  const { db } = deps;
  const url = bookUrl(id);

  const link = (
    await db.query<ApprovedLink>(
      `SELECT l.id AS link_id, l.seed_item_id, l.source_id, s.title, s.author, s.year
         FROM seed_source_links l
         JOIN seed_items s ON s.id = l.seed_item_id
         JOIN sources src ON src.id = l.source_id AND src.slug = $2
        WHERE l.status = 'approved' AND l.candidate_url = $1
        ORDER BY l.id LIMIT 1`,
      [url, GUTENBERG_SLUG],
    )
  ).rows[0];
  if (!link) return "not_approved";

  // Nothing else creates this row now that no watcher runs (same columns as discovery/watcher.ts).
  await db.query(
    `INSERT INTO essay_urls (url, source_id, url_hash, seed_item_id, link_id)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
    [url, link.source_id, urlHash(url), link.seed_item_id, link.link_id],
  );
  const state = (await db.query<{ status: string }>("SELECT status FROM essay_urls WHERE url = $1", [url])).rows[0];
  if (!state || (state.status !== "new" && state.status !== "failed")) return "already_processed";

  const a = await analyzeBook(deps.dir, id);
  if (a.code !== null) {
    await recordOutcome(db, url, { kind: "fetch_failed" });
    return a.code;
  }

  if (a.reasons.length) {
    await inTransaction(db, async () => {
      await db.query("INSERT INTO quarantine (essay_url, reasons) VALUES ($1, $2::jsonb)", [url, JSON.stringify(a.reasons)]);
      await db.query("UPDATE essay_urls SET status = 'quarantined' WHERE url = $1", [url]);
    });
    return "quarantined";
  }

  // S3 first: the key is the content hash, so a crash before the commit leaves an object the next run
  // reuses, and the unique text_hash makes the row itself idempotent.
  const body = Buffer.from(a.extraction.text, "utf8");
  const hash = createHash("sha256").update(body).digest("hex");
  const key = `${ESSAY_TEXT_PREFIX}${hash}.txt`;
  await deps.putObject(key, body);

  let inserted = false;
  await inTransaction(db, async () => {
    const { rows } = await db.query(
      `INSERT INTO essays (kind, title, author, year, source_id, source_url, word_count, language, status, text_hash, text_s3_key, seed_item_id)
       VALUES ('full', $1, $2, $3, $4, $5, $6, 'en', 'pending_category', $7, $8, $9)
       ON CONFLICT (text_hash) DO NOTHING RETURNING id`,
      [link.title, link.author, link.year, link.source_id, url, a.extraction.wordCount, hash, key, link.seed_item_id],
    );
    inserted = rows.length > 0;
    await db.query("UPDATE essay_urls SET status = 'fetched' WHERE url = $1", [url]);
  });
  // No row means the same text is already stored for another URL: the URL is fetched, the text a duplicate.
  return inserted ? "stored" : "duplicate";
}

/** Throws `pipelines_paused` unless the pause flag is readable and false (fail closed). */
export async function assertNotPaused(db: Db): Promise<void> {
  const paused = (await db.query<{ paused: boolean }>("SELECT public.pipeline_is_paused() AS paused")).rows[0]?.paused;
  if (paused !== false) throw new IngestError("pipelines_paused");
}

/** Per id, sequentially. Stops with `pipelines_paused` (nothing done) when the pause flag is set. */
export async function storePhase(ids: readonly number[], deps: StoreDeps): Promise<StoreResult[]> {
  await assertNotPaused(deps.db);
  const results: StoreResult[] = [];
  for (const id of ids) {
    const code = await storeBook(id, deps);
    results.push({ id, code });
    deps.log(`essay-ingest: id=${id} code=${code}`);
  }
  return results;
}

export const STORE_OK: ReadonlySet<StoreCode> = new Set(["stored", "duplicate", "already_processed"]);

// ------------------------------------------------------------------ re-extract phase

export type ReextractCode =
  | "reextracted" | "unchanged" | "not_stored" | "invalid" | "duplicate" | "changed_concurrently" | "no_files" | typeof NO_USABLE_TEXT;

export const REEXTRACT_OK: ReadonlySet<ReextractCode> = new Set(["reextracted", "unchanged"]);

export interface ReextractResult {
  id: number;
  code: ReextractCode;
  words?: { from: number | null; to: number };
}

interface StoredEssay {
  id: string;
  text_hash: string;
  word_count: number | null;
}

/**
 * One stored book, re-analysed with the current extractor. Changes the essays row only (text_hash,
 * text_s3_key, word_count), never its status, categories, ratings, progress or the essay_urls row.
 */
async function reextractBook(id: number, deps: StoreDeps): Promise<ReextractResult> {
  const { db } = deps;
  const url = bookUrl(id);

  const urlRow = (await db.query<{ status: string }>("SELECT status FROM essay_urls WHERE url = $1", [url])).rows[0];
  const essays = (
    await db.query<StoredEssay>(
      `SELECT e.id, e.text_hash, e.word_count
         FROM essays e JOIN sources s ON s.id = e.source_id AND s.slug = $2
        WHERE e.kind = 'full' AND e.source_url = $1`,
      [url, GUTENBERG_SLUG],
    )
  ).rows;
  const [stored] = essays;
  if (urlRow?.status !== "fetched" || essays.length !== 1 || !stored) return { id, code: "not_stored" };

  const a = await analyzeBook(deps.dir, id);
  if (a.code !== null) return { id, code: a.code };
  if (a.reasons.length) return { id, code: "invalid" };

  const body = Buffer.from(a.extraction.text, "utf8");
  const hash = createHash("sha256").update(body).digest("hex");
  if (hash === stored.text_hash) return { id, code: "unchanged" };

  const other = await db.query("SELECT 1 FROM essays WHERE text_hash = $1 AND id <> $2", [hash, stored.id]);
  if (other.rows.length > 0) return { id, code: "duplicate" };

  // S3 first, as in store: the object exists before the row points at it.
  const key = `${ESSAY_TEXT_PREFIX}${hash}.txt`;
  await deps.putObject(key, body);
  const updated = await db.query(
    `UPDATE essays SET text_hash = $1, text_s3_key = $2, word_count = $3
      WHERE id = $4 AND text_hash = $5 RETURNING id`,
    [hash, key, a.extraction.wordCount, stored.id, stored.text_hash],
  );
  if (updated.rows.length === 0) return { id, code: "changed_concurrently" };
  return { id, code: "reextracted", words: { from: stored.word_count, to: a.extraction.wordCount } };
}

/**
 * Per id, sequentially, with the store phase's pause check. When every id is OK (reextracted or unchanged),
 * the Gutenberg source's extractor_version is set to the current EXTRACTOR_VERSION (only if it differs).
 */
export async function reextractPhase(ids: readonly number[], deps: StoreDeps): Promise<ReextractResult[]> {
  await assertNotPaused(deps.db);
  const results: ReextractResult[] = [];
  for (const id of ids) {
    const r = await reextractBook(id, deps);
    results.push(r);
    deps.log(
      `essay-ingest: id=${id} code=${r.code}` + (r.words ? ` words=${r.words.from ?? "none"}->${r.words.to}` : ""),
    );
  }
  // The source only reads as the current version once every stored full essay of it holds current text: all
  // ids OK, and the batch covers every stored essay (a one-book trial run leaves the source alone).
  const okUrls = new Set(results.filter((r) => REEXTRACT_OK.has(r.code)).map((r) => bookUrl(r.id)));
  const stored = await deps.db.query<{ source_url: string | null }>(
    `SELECT e.source_url FROM essays e JOIN sources s ON s.id = e.source_id AND s.slug = $1 WHERE e.kind = 'full'`,
    [GUTENBERG_SLUG],
  );
  const coversAll = stored.rows.every((row) => row.source_url !== null && okUrls.has(row.source_url));
  if (results.every((r) => REEXTRACT_OK.has(r.code)) && coversAll) {
    const updated = await deps.db.query(
      `UPDATE sources SET extractor_version = $1
        WHERE slug = $2 AND extractor_version IS DISTINCT FROM $1 RETURNING id`,
      [EXTRACTOR_VERSION, GUTENBERG_SLUG],
    );
    if (updated.rows.length > 0) deps.log(`essay-ingest: source extractor_version=${EXTRACTOR_VERSION}`);
  }
  return results;
}

/** Counts line for the summary. */
export function summarize(codes: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const c of codes) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts].map(([c, n]) => `${c}=${n}`).join(" ");
}
