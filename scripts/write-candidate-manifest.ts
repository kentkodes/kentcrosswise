// Writes candidate-manifest.json next to preview-db.sql and preview-web.tar (ci.yml candidate-build), or
// next to prod-build.tar with --kind prod (ci.yml candidate-prod-build).
// Usage: pnpm candidate-manifest --dir <d> [--kind prod]     env REPOSITORY_ID, PR_NUMBER, HEAD_SHA, RUN_ID, RUN_ATTEMPT
// Runs in the credential-free job; the trusted side re-checks every value and hash.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "./lib/args";
import { buildManifest, KINDS, MANIFEST_FILE, parseId, parseKind, parseSha } from "./lib/candidate-artifact";
import { runMain } from "./lib/main";

const args = parseArgs(process.argv.slice(2));

await runMain(async () => {
  if (typeof args.dir !== "string") throw new Error("Usage: pnpm candidate-manifest --dir <d> [--kind prod]");
  const kind = parseKind(args.kind);
  const dir = path.resolve(process.env.INIT_CWD ?? process.cwd(), args.dir);
  const manifest = buildManifest(
    {
      repository_id: parseId(process.env.REPOSITORY_ID, "REPOSITORY_ID"),
      pr_number: parseId(process.env.PR_NUMBER, "PR_NUMBER"),
      head_sha: parseSha(process.env.HEAD_SHA, "HEAD_SHA"),
      run_id: parseId(process.env.RUN_ID, "RUN_ID"),
      run_attempt: parseId(process.env.RUN_ATTEMPT, "RUN_ATTEMPT"),
    },
    Object.fromEntries(KINDS[kind].files.map((n) => [n, readFileSync(path.join(dir, n))])),
    kind,
  );
  writeFileSync(path.join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`candidate-manifest: wrote ${MANIFEST_FILE}`);
});
