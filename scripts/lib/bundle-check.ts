// Scans build output for strings that only the preview login provider contains (DESIGN §5).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Strings that exist only in apps/web/src/auth/preview-login.ts (a web test keeps them in sync). */
export const PREVIEW_MARKERS = ["kcw-preview-login", "owner@preview.kentcrosswise.invalid"] as const;

/** Build-cache directories that are never deployed. */
const SKIP_DIRS = new Set([".next/cache", "node_modules/.cache"]);

export interface ScanResult {
  filesScanned: number;
  hits: { file: string; marker: string }[];
}

export function scanForMarkers(dirs: readonly string[], markers: readonly string[] = PREVIEW_MARKERS): ScanResult {
  const result: ScanResult = { filesScanned: 0, hits: [] };
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const lastTwo = full.split(path.sep).slice(-2).join("/");
        if (!SKIP_DIRS.has(lastTwo)) walk(full);
      } else if (entry.isFile()) {
        result.filesScanned += 1;
        const text = readFileSync(full).toString("latin1");
        for (const marker of markers) {
          if (text.includes(marker)) result.hits.push({ file: full, marker });
        }
      }
    }
  };
  for (const dir of dirs) {
    if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir);
  }
  return result;
}

/** What gets deployed: Next's server and static output, and the OpenNext bundle if it was built. */
export function defaultBundleDirs(repoRoot: string): string[] {
  const web = path.join(repoRoot, "apps", "web");
  return [path.join(web, ".next", "server"), path.join(web, ".next", "static"), path.join(web, ".open-next")];
}
