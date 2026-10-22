import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { defaultBundleDirs, PREVIEW_MARKERS, scanForMarkers } from "../lib/bundle-check";

const root = mkdtempSync(path.join(tmpdir(), "kcw-bundle-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function tree(name: string, files: Record<string, string>): string {
  const dir = path.join(root, name);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

describe("scanForMarkers", () => {
  it("passes a clean prod-like tree", () => {
    const dir = tree("clean", { "server/app/page.js": "export default 1", "static/chunk.js": "google" });
    expect(scanForMarkers([dir])).toEqual({ filesScanned: 2, hits: [] });
  });

  it("finds every marker in nested files", () => {
    const dir = tree("dirty", {
      "server/chunks/a.js": `id:"${PREVIEW_MARKERS[0]}"`,
      "server/chunks/deep/b.js.map": `"${PREVIEW_MARKERS[1]}"`,
    });
    const res = scanForMarkers([dir]);
    expect(res.hits.map((h) => h.marker).sort()).toEqual([...PREVIEW_MARKERS].sort());
  });

  it("skips the .next/cache build cache and missing dirs", () => {
    const dir = tree("cached", { ".next/cache/x.js": PREVIEW_MARKERS[0], ".next/server/y.js": "ok" });
    const res = scanForMarkers([dir, path.join(root, "does-not-exist")]);
    expect(res).toEqual({ filesScanned: 1, hits: [] });
  });

  it("defaults to the deployed web output", () => {
    const dirs = defaultBundleDirs("/repo").map((d) => d.split(path.sep).join("/"));
    expect(dirs.some((d) => d.endsWith("apps/web/.next/server"))).toBe(true);
    expect(dirs.some((d) => d.endsWith("apps/web/.open-next"))).toBe(true);
  });
});
