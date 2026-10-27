import { randomUUID } from "node:crypto";
import type { Db } from "../../../packages/essays/src/db";
import { discoverApprovedUrls, reemitStalledUrls, type WatcherOptions } from "../../../packages/essays/src/discovery/watcher";
import { RobotsCache } from "../../../packages/essays/src/crawl/robots";
import { loadSource } from "../../../packages/essays/src/registry/source";
import type { createAwsAdapters } from "./aws";

export interface PipelineConnection extends Db { close(): Promise<void> }
export interface HandlerDeps {
  env: NodeJS.ProcessEnv;
  secret(name: string, key?: string): Promise<string>;
  connect(url: string): Promise<PipelineConnection>;
  adapters(bucket: string, queueUrl: string, region: string): ReturnType<typeof createAwsAdapters>;
  log(entry: { status: string; discovered?: number; emitted?: number; recovered?: number; reason?: string }): void;
  discover?: typeof discoverApprovedUrls;
  recover?: typeof reemitStalledUrls;
}

export const PIPELINE_ROLE = "pipeline_rw";

/** Fixed failure codes; the only failure detail that is ever logged. */
type FailureCode = "database_url_empty" | "pipeline_role_mismatch";
class PipelineFailure extends Error {
  constructor(readonly code: FailureCode) { super(code); }
}

/**
 * Runs every statement in its own transaction that starts with `SET LOCAL ROLE pipeline_rw`, as
 * apps/web/src/server/db.ts does. A session-level SET ROLE is unsafe on a pooled Neon URL: with
 * transaction pooling, consecutive statements can reach different server sessions, so the role
 * would be missing on one and leak to another client on the next. The discovery code issues only
 * single statements (reads, inserts and the rate lease's one conditional UPDATE); it opens no
 * explicit transaction and takes no advisory lock, so one transaction per statement keeps its
 * semantics and holds no row lock between statements.
 */
export function asPipelineRole(conn: PipelineConnection): PipelineConnection {
  return {
    async query<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      await conn.query("BEGIN");
      try {
        // PIPELINE_ROLE is a constant identifier, never input.
        await conn.query(`SET LOCAL ROLE ${PIPELINE_ROLE}`);
        const result = await conn.query<R>(sql, params);
        await conn.query("COMMIT");
        return result;
      } catch (error) {
        await conn.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    },
    close: () => conn.close(),
  };
}

/** Fails closed unless statements really run as pipeline_rw. */
export async function assertPipelineRole(db: Db): Promise<void> {
  const { rows } = await db.query<{ role: unknown }>("SELECT current_user AS role");
  if (rows[0]?.role !== PIPELINE_ROLE) throw new PipelineFailure("pipeline_role_mismatch");
}

/** Never throws: a close failure must neither replace a result nor mask the original error. */
async function closeResources(db?: PipelineConnection, adapters?: ReturnType<typeof createAwsAdapters>): Promise<boolean> {
  let failed = false;
  try { adapters?.close(); } catch { failed = true; }
  try { await db?.close(); } catch { failed = true; }
  return !failed;
}

/** All failures use a fixed code. Never serialize arbitrary exceptions, URLs, or database credentials. */
export function createPipelineHandler(deps: HandlerDeps) {
  return async (input: unknown) => {
    if (deps.env.KCW_PIPELINES_ENABLED !== "true") return { status: "disabled" };
    if (typeof input !== "object" || input === null || Array.isArray(input)) return { status: "invalid_input" };
    const event = input as Record<string, unknown>;
    if (Object.keys(event).length !== 2 || event.mode !== "discover" || !["gutenberg", "wikisource-en"].includes(String(event.source_slug))) return { status: "invalid_input" };
    const bucket = deps.env.KCW_PIPELINES_METADATA_BUCKET;
    const queue = deps.env.KCW_ESSAY_URLS_QUEUE_URL;
    // No default: the module always sets it, and a guessed name could read the wrong credential.
    const secretName = deps.env.KCW_PIPELINE_SECRET;
    if (!bucket || !queue || !queue.startsWith("https://") || !secretName) return { status: "configuration_error" };
    let db: PipelineConnection | undefined;
    let adapters: ReturnType<typeof createAwsAdapters> | undefined;
    try {
      const url = await deps.secret(secretName, secretName.startsWith("/") ? undefined : "db_url");
      if (!url.trim()) throw new PipelineFailure("database_url_empty");
      db = asPipelineRole(await deps.connect(url));
      await assertPipelineRole(db);
      const pause = await db.query<{ paused: unknown }>("SELECT public.pipeline_is_paused() AS paused");
      if (pause.rows[0]?.paused !== false) return { status: "paused" };
      const source = await loadSource(db, String(event.source_slug));
      if (!source || source.paused) return { status: source ? "source_paused" : "source_missing" };
      adapters = deps.adapters(bucket, queue, deps.env.AWS_REGION ?? "us-east-1");
      const opts: WatcherOptions = { db, sourceId: source.id, runId: randomUUID(), publish: adapters.publish,
        catalogCache: adapters.catalog, http: { cache: new RobotsCache(undefined, adapters.robots) } };
      const discovered = await (deps.discover ?? discoverApprovedUrls)(opts);
      const recovered = await (deps.recover ?? reemitStalledUrls)(opts);
      const result = { status: "ok", discovered: discovered.discovered, emitted: discovered.emitted, recovered };
      deps.log(result);
      return result;
    } catch (error) {
      deps.log({ status: "error", reason: error instanceof PipelineFailure ? error.code : "pipeline_failed" });
      // A fixed exception marks the async invocation failed (the Errors metric and its alarm) without
      // disclosing third-party or secret strings. Nothing retries it: Lambda async retries are 0 and
      // Scheduler retries only failed deliveries, so the next scheduled run is the retry.
      throw new Error("pipeline_failed");
    } finally {
      if (!await closeResources(db, adapters)) deps.log({ status: "warning", reason: "pipeline_close_failed" });
    }
  };
}
