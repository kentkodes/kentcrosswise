import { describe, expect, it } from "vitest";
import { createMetadataStores, ROBOTS_MAX_BYTES } from "../lib/pipelines/metadata";
import { readMetadataBody } from "../lib/pipelines/aws";
import { RobotsCache, ROBOTS_TTL_MS } from "../../packages/essays/src/crawl/robots";

describe("private bounded pipeline metadata", () => {
  function fixture() {
    const objects = new Map<string, string>();
    const writes: string[] = [];
    return { objects, writes, stores: createMetadataStores({
      read: async (key, cap) => { const v = objects.get(key); if (v !== undefined && Buffer.byteLength(v) > cap) throw new Error("too_large"); return v ?? null; },
      write: async (key, value) => { writes.push(key); objects.set(key, value); },
    }) };
  }
  it("roundtrips catalog body+ETag under a fixed hashed prefix", async () => {
    const f = fixture();
    expect(await f.stores.catalog.get("source/../../unexpected")).toBeNull();
    const snapshot = { body: 'Text#,Type,Title,Authors,Language\n1,Text,Of Studies,Bacon,en\n', etag: '"version1"' };
    await f.stores.catalog.put("source/../../unexpected", snapshot);
    expect(await f.stores.catalog.get("source/../../unexpected")).toEqual(snapshot);
    expect(f.writes[0]).toMatch(/^pipelines\/meta\/catalog\/[a-f0-9]{64}\.json$/);
  });
  it("keeps original robots audit text and restores policy across runs only within24h", async () => {
    const f = fixture(); const now = new Date("2026-10-27T20:00:00Z");
    const original = "# original policy\nUser-agent: *\nDisallow: /private\n";
    let fetched = 0;
    const load = async () => { fetched++; return { kind: "response" as const, status: 200, body: original }; };
    await new RobotsCache(undefined, f.stores.robots).getOrLoad("https://example.org", now, load);
    const restored = await new RobotsCache(undefined, f.stores.robots).getOrLoad("https://example.org", new Date(now.getTime() + 1), load);
    expect(restored.status).toBe("ok"); expect(fetched).toBe(1);
    expect([...f.objects.entries()].find(([k]) => k.endsWith(".txt"))?.[1]).toBe(original);
    await new RobotsCache(undefined, f.stores.robots).getOrLoad("https://example.org", new Date(now.getTime() + ROBOTS_TTL_MS), load);
    expect(fetched).toBe(2);
  });
  it("refuses oversized records and destroys streams exceeding the cap", async () => {
    const f = fixture();
    await expect(f.stores.robots.put("https://example.org", { fetchedAt: new Date().toISOString(), result: { kind: "response", status: 200, body: "x".repeat(ROBOTS_MAX_BYTES + 1) } })).rejects.toThrow("robots_cache_too_large");
    let destroyed = false;
    const stream = { async *[Symbol.asyncIterator]() { yield Buffer.from("too-large"); }, destroy() { destroyed = true; } };
    await expect(readMetadataBody(stream, 3)).rejects.toThrow("metadata_object_too_large");
    expect(destroyed).toBe(true); expect(f.writes).toHaveLength(0);
  });
});
