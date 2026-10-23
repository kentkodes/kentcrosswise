// Bundles the orchestrator, webhook relay and sweeper Lambdas (scripts/lib/lambda-bundle.ts) into
// each target's outDir/index.mjs, then imports each bundle in a clean Node process to check that it
// loads and exports `handler`. Run before any terraform plan/apply of infra/prod.
// Usage: pnpm build-lambdas
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LAMBDA_TARGETS, bundleLambda, formatSize, smokeImport } from "./lib/lambda-bundle";
import { runMain } from "./lib/main";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await runMain(async () => {
  for (const target of LAMBDA_TARGETS) {
    const r = await bundleLambda(repoRoot, target);
    const smoke = smokeImport(r.file);
    if (!smoke.ok) throw new Error(`${target.name}: the bundle does not load (${smoke.reason})`);
    console.log(
      `build-lambdas: ${target.name} -> ${path.relative(repoRoot, r.file).replaceAll("\\", "/")} ` +
        `${formatSize(r.bytes)} (zipped ~${formatSize(r.zipBytes)}), ${target.arch}, loads, exports handler`,
    );
  }
});
