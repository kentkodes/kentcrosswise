// Preview garbage collection helpers for preview-gc.yml and ci.yml (P1-16).
// Usage:
//   pnpm preview-gc find [--pr <n>] [--force] [--max-age-hours <h>]
//       Lists per-PR preview leftovers and decides which to clean: closed PRs always, open PRs (or
//       PRs that do not exist, like the manual pr-0) when the newest leftover is older than
//       --max-age-hours (default 24). --force: everything found is eligible (ci.yml cleaning its
//       own PR before a new preview). Writes step outputs prs, destroy_prs, count, has_state,
//       has_branch to $GITHUB_OUTPUT and a table to $GITHUB_STEP_SUMMARY when set.
//   pnpm preview-gc delete-neon --pr <n>
//       Deletes the Neon branch preview/pr-<n> if it exists.
// Env: AWS credentials (kcw-gh-ci); TF_STATE_BUCKET; NEON_CI_PROJECT_ID; KCW_CI_NEON_API_KEY or
//      NEON_API_KEY; GITHUB_REPOSITORY; GITHUB_TOKEN (pull request state).
import { appendFileSync } from "node:fs";
import { parseArgs } from "./lib/args";
import { runMain } from "./lib/main";
import { awsGcSources, deleteNeonPreviewBranch, findCandidates, gcOutputs, gcReport, type NeonOptions } from "./lib/preview-gc";

const args = parseArgs(process.argv.slice(2));
const command = process.argv[2];

function str(name: string): string | undefined {
  const v = args[name];
  return typeof v === "string" && v !== "" ? v : undefined;
}

function prArg(required: boolean): number | undefined {
  const raw = str("pr");
  if (raw === undefined) {
    if (required) throw new Error("--pr <n> is required");
    return undefined;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error("--pr must be a non-negative integer");
  return Number(raw);
}

function neon(): NeonOptions {
  const projectId = process.env.NEON_CI_PROJECT_ID;
  const apiKey = process.env.KCW_CI_NEON_API_KEY ?? process.env.NEON_API_KEY;
  if (!projectId || !apiKey) throw new Error("NEON_CI_PROJECT_ID and KCW_CI_NEON_API_KEY (or NEON_API_KEY) are required");
  return { projectId, apiKey };
}

await runMain(async () => {
  if (command === "delete-neon") {
    const pr = prArg(true)!;
    const deleted = await deleteNeonPreviewBranch(neon(), pr);
    console.log(`preview-gc: Neon branch preview/pr-${pr} ${deleted ? "deleted" : "not found (nothing to delete)"}`);
    return;
  }
  if (command !== "find") {
    console.log("Usage: pnpm preview-gc find [--pr <n>] [--force] [--max-age-hours <h>] | delete-neon --pr <n>");
    if (command !== "--help") process.exitCode = 1;
    return;
  }
  const stateBucket = process.env.TF_STATE_BUCKET;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!stateBucket || !repo) throw new Error("TF_STATE_BUCKET and GITHUB_REPOSITORY are required");
  const maxAgeRaw = str("max-age-hours") ?? "24";
  if (!/^[0-9]+$/.test(maxAgeRaw)) throw new Error("--max-age-hours must be a non-negative integer");
  const pr = prArg(false);

  const sources = awsGcSources({
    region: process.env.AWS_REGION ?? "us-east-1",
    stateBucket,
    neon: neon(),
    repo,
    githubToken: process.env.GITHUB_TOKEN,
  });
  const cands = await findCandidates(sources, {
    now: new Date(),
    maxAgeHours: Number(maxAgeRaw),
    ...(pr !== undefined && { pr }),
    force: args.force === true,
  });
  const report = gcReport(cands);
  console.log(report);
  const outputs = gcOutputs(cands);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(""));
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Preview leftovers\n\n${report}`);
  console.log(`preview-gc: ${outputs.count} preview(s) to clean ${outputs.prs}; terraform destroy for ${outputs.destroy_prs}`);
});
