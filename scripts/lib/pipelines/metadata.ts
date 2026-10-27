import { createHash } from "node:crypto";
import type { CatalogCache, CatalogSnapshot } from "../../../packages/essays/src/discovery/watcher";
import type { RobotsFetch, RobotsSnapshot, RobotsStore } from "../../../packages/essays/src/crawl/robots";

export const CATALOG_MAX_BYTES = 64 * 1024 * 1024;
export const ROBOTS_MAX_BYTES = 512 * 1024;
export interface MetadataIo {
  read(key: string, maxBytes: number): Promise<string | null>;
  write(key: string, body: string, contentType: string): Promise<void>;
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

/** Keys are derived locally, never from event-provided paths. The entire prefix stays private. */
export function createMetadataStores(io: MetadataIo): { catalog: CatalogCache; robots: RobotsStore } {
  return {
    catalog: {
      async get(sourceId): Promise<CatalogSnapshot | null> {
        const raw = await io.read(`pipelines/meta/catalog/${hash(sourceId)}.json`, CATALOG_MAX_BYTES * 2);
        if (raw === null) return null;
        const data: unknown = JSON.parse(raw);
        if (!object(data) || data.v !== 1 || typeof data.body !== "string" || Buffer.byteLength(data.body) > CATALOG_MAX_BYTES
          || !(data.etag === null || typeof data.etag === "string" && data.etag.length <= 512)) throw new Error("catalog_cache_invalid");
        return { body: data.body, etag: data.etag };
      },
      async put(sourceId, snapshot) {
        if (Buffer.byteLength(snapshot.body) > CATALOG_MAX_BYTES || (snapshot.etag?.length ?? 0) > 512) throw new Error("catalog_cache_too_large");
        await io.write(`pipelines/meta/catalog/${hash(sourceId)}.json`, JSON.stringify({ v: 1, ...snapshot }), "application/json");
      },
    },
    robots: {
      async get(origin): Promise<RobotsSnapshot | null> {
        const raw = await io.read(`pipelines/meta/robots/${hash(origin)}/latest.json`, ROBOTS_MAX_BYTES * 2);
        if (raw === null) return null;
        const data: unknown = JSON.parse(raw);
        if (!object(data) || data.v !== 1 || typeof data.fetchedAt !== "string" || !Number.isFinite(Date.parse(data.fetchedAt))
          || !object(data.result) || data.result.kind !== "response" || !Number.isInteger(data.result.status)
          || typeof data.result.body !== "string" || Buffer.byteLength(data.result.body) > ROBOTS_MAX_BYTES) throw new Error("robots_cache_invalid");
        return { fetchedAt: data.fetchedAt, result: data.result as unknown as RobotsFetch };
      },
      async put(origin, snapshot) {
        // Network failures are not persisted as a reusable policy; the next run must retry.
        if (snapshot.result.kind !== "response") return;
        const body = snapshot.result.body;
        if (Buffer.byteLength(body) > ROBOTS_MAX_BYTES) throw new Error("robots_cache_too_large");
        const prefix = `pipelines/meta/robots/${hash(origin)}`;
        await io.write(`${prefix}/${hash(body)}.txt`, body, "text/plain; charset=utf-8");
        await io.write(`${prefix}/latest.json`, JSON.stringify({ v: 1, ...snapshot }), "application/json");
      },
    },
  };
}
