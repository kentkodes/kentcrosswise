// Writes the merge-rules CI artifact (P2-13): the prod plan summary plus the lockfile diff, one JSON
// file named MERGE_INPUT_FILE that ci.yml uploads as artifact MERGE_INPUT_ARTIFACT (@kcw/core/merge-input).
// Usage: pnpm merge-input --plan-summary <file> --base-lock <file> --head-lock <file> --out <file> [--markdown <file>]
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseMergeInput, serializeMergeInput } from "@kcw/core/merge-input";
import { parseArgs } from "./lib/args";
import { computeLockDiff, lockDiffMarkdown } from "./lib/lock-diff";
import { runMain } from "./lib/main";

const USAGE =
  "Usage: pnpm merge-input --plan-summary <file> --base-lock <file> --head-lock <file> --out <file> [--markdown <file>]";

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
  const planText = readArg("plan-summary");
  const lockDiff = computeLockDiff(readArg("base-lock"), readArg("head-lock"));
  // Round-trip through the consumer's parser so CI never uploads a file the orchestrator rejects.
  const { planSummary } = parseMergeInput(JSON.stringify({ format: 1, planSummary: JSON.parse(planText) as unknown, lockDiff }));
  writeFileSync(path.resolve(cwd, out), serializeMergeInput({ planSummary, lockDiff }));
  if (typeof args.markdown === "string") appendFileSync(path.resolve(cwd, args.markdown), lockDiffMarkdown(lockDiff));
  console.log(`merge-input: ${planSummary.infra.length} infrastructure change(s), ${lockDiff.added.length} direct dependency addition(s)`);
});
