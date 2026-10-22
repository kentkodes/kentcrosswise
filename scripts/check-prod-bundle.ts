// Fails if a prod build of apps/web contains the preview-only login provider (DESIGN §5).
// Usage: pnpm check-prod-bundle [dir ...]
// Default dirs: apps/web/.next/server, apps/web/.next/static, apps/web/.open-next (those that exist).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultBundleDirs, scanForMarkers } from "./lib/bundle-check";
import { runMain } from "./lib/main";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cwd = process.env.INIT_CWD ?? process.cwd();
const args = process.argv.slice(2);

await runMain(async () => {
  const dirs = args.length > 0 ? args.map((d) => path.resolve(cwd, d)) : defaultBundleDirs(repoRoot);
  const { filesScanned, hits } = scanForMarkers(dirs);
  if (filesScanned === 0) throw new Error(`no build output found in ${dirs.join(", ")}`);
  if (hits.length > 0) {
    for (const h of hits) console.error(`  ${path.relative(repoRoot, h.file)}: "${h.marker}"`);
    throw new Error("the preview login provider is in the build; rebuild without KCW_ENV=preview");
  }
  console.log(`check-prod-bundle: OK (${filesScanned} files scanned, no preview login provider)`);
});
