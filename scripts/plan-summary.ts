// Turns `terraform show -json <planfile>` output into the prod plan summary for merge-rules.
// Usage: pnpm plan-summary --plan-json <file> --out <summary.json> [--markdown <file>]
// Prints counts only. The input JSON can contain sensitive values: never upload or print it.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "./lib/args";
import { runMain } from "./lib/main";
import { summarizePlan, summaryMarkdown, type TerraformPlanJson } from "./lib/plan-summary";

const args = parseArgs(process.argv.slice(2));
const cwd = process.env.INIT_CWD ?? process.cwd();

await runMain(async () => {
  const input = args["plan-json"];
  const out = args.out;
  if (typeof input !== "string" || typeof out !== "string") {
    throw new Error("Usage: pnpm plan-summary --plan-json <file> --out <summary.json> [--markdown <file>]");
  }
  let plan: TerraformPlanJson;
  try {
    plan = JSON.parse(readFileSync(path.resolve(cwd, input), "utf8")) as TerraformPlanJson;
  } catch {
    // Do not include the parse error: it quotes part of the input.
    throw new Error(`could not read a JSON plan from ${input}`);
  }
  const summary = summarizePlan(plan);
  writeFileSync(path.resolve(cwd, out), `${JSON.stringify(summary, null, 2)}\n`);
  const md = summaryMarkdown(summary);
  if (typeof args.markdown === "string") appendFileSync(path.resolve(cwd, args.markdown), md);
  console.log(`plan-summary: ${summary.infra.length} infrastructure change(s), ${summary.artifact.count} build artifact change(s)`);
});
