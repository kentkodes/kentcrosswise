// Writes the merge-rules artifact (P2-13, format 2 since AR1 slice 3): the prod plan summary, the lockfile
// diff and the PR paths the trusted plan does not cover, one JSON file named MERGE_INPUT_FILE that the trusted
// `prod-plan` job of preview-trusted.yml uploads as artifact MERGE_INPUT_ARTIFACT (@kcw/core/merge-input).
// The lockfiles are data read from the PR head and base; the file list comes from the GitHub API
// (env GITHUB_TOKEN, GITHUB_REPOSITORY).
// Usage: pnpm merge-input --pr <n> --head-sha <sha> --plan-summary <file> --base-lock <file> --head-lock <file> --out <file> [--markdown <file>]
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "./lib/args";
import { parseId, parseSha } from "./lib/candidate-artifact";
import { lockDiffMarkdown } from "./lib/lock-diff";
import { buildMergeInput } from "./lib/merge-input";
import { runMain } from "./lib/main";
import { ghRest } from "./lib/trusted-preview";

const USAGE =
  "Usage: pnpm merge-input --pr <n> --head-sha <sha> --plan-summary <file> --base-lock <file> --head-lock <file> --out <file> [--markdown <file>]";

const args = parseArgs(process.argv.slice(2));
const cwd = process.env.INIT_CWD ?? process.cwd();

function readArg(name: string): string {
  const v = args[name];
  if (typeof v !== "string") throw new Error(USAGE);
  try {
    return readFileSync(path.resolve(cwd, v), "utf8");
  } catch {
    throw new Error(`could not read --${name} ${v}`);
  }
}

await runMain(async () => {
  const out = args.out;
  if (typeof out !== "string") throw new Error(USAGE);
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");
  const pr = parseId(typeof args.pr === "string" ? args.pr : undefined, "--pr");
  const headSha = parseSha(typeof args["head-sha"] === "string" ? args["head-sha"] : undefined, "--head-sha");
  const { text, input } = await buildMergeInput(ghRest({ repo, token }), {
    repo,
    pr,
    headSha,
    planSummary: readArg("plan-summary"),
    baseLock: readArg("base-lock"),
    headLock: readArg("head-lock"),
  });
  writeFileSync(path.resolve(cwd, out), text);
  if (typeof args.markdown === "string") appendFileSync(path.resolve(cwd, args.markdown), lockDiffMarkdown(input.lockDiff));
  console.log(`merge-input: ${input.planSummary.infra.length} infrastructure change(s), ${input.lockDiff.added.length} direct dependency addition(s), ${input.uncoveredPaths.length} uncovered path(s)`);
});
