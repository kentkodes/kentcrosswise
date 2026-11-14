// Merge-time check that a PR head was previewed by the trusted path (AR1 slice 2; used by PR B, not wired yet).
// Usage: pnpm verify-trusted-preview --pr <n> --sha <sha>     env GITHUB_TOKEN, GITHUB_REPOSITORY
// Exit 0 when the latest preview-trusted.yml run for that head (workflow from the default branch) succeeded and
// provisioned that PR at that head; exit 1 with the reason otherwise. Logic: lib/trusted-run.ts.
import { parseArgs } from "./lib/args";
import { parseId, parseSha } from "./lib/candidate-artifact";
import { runMain } from "./lib/main";
import { ghRest } from "./lib/trusted-preview";
import { verifyTrustedPreview } from "./lib/trusted-run";

const args = parseArgs(process.argv.slice(2));

await runMain(async () => {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");
  const pr = parseId(typeof args.pr === "string" ? args.pr : undefined, "--pr");
  const sha = parseSha(typeof args.sha === "string" ? args.sha : undefined, "--sha");
  const result = await verifyTrustedPreview(ghRest({ repo, token }), { repo, pr, sha });
  if (!result.ok) throw new Error(`no trusted preview for PR #${pr} at ${sha}: ${result.reason}`);
  console.log(`verify-trusted-preview: run ${result.runId} verified PR #${pr} at ${sha}`);
});
