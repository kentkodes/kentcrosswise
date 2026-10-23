// Agent workflows (P2-12), before Claude runs: validates the dispatch inputs and writes the task context.
// Usage: pnpm agent-context --agent <developer|qa|scraper|docs> --out <file>
// Inputs from env (set from workflow_dispatch inputs): KCW_TASK_ID, KCW_ISSUE, KCW_PR, KCW_MODE.
// Needs GH_TOKEN (the agent App token) and GITHUB_REPOSITORY. Writes step outputs to $GITHUB_OUTPUT.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gatherContext, parseInputs } from "./lib/agent-context";
import { isWorkflowAgent } from "./lib/agents";
import { parseArgs } from "./lib/args";
import { runMain } from "./lib/main";

const args = parseArgs(process.argv.slice(2));

await runMain(async () => {
  if (!isWorkflowAgent(args.agent) || typeof args.out !== "string") {
    throw new Error("Usage: pnpm agent-context --agent <developer|qa|scraper|docs> --out <file>");
  }
  const token = process.env.GH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) throw new Error("GH_TOKEN and GITHUB_REPOSITORY must be set");
  const inputs = parseInputs(args.agent, {
    task_id: process.env.KCW_TASK_ID,
    issue: process.env.KCW_ISSUE,
    pr: process.env.KCW_PR,
    mode: process.env.KCW_MODE,
  });
  const { outputs, markdown } = await gatherContext(inputs, { repo, token });
  // INIT_CWD: the directory pnpm was started from (the repo root in the workflows).
  const out = path.resolve(process.env.INIT_CWD ?? process.cwd(), args.out);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${markdown}\n`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(""));
  }
  console.log(`agent-context: ${inputs.agent} task ${inputs.taskId}: ${Object.entries(outputs).map(([k, v]) => `${k}=${v}`).join(" ")}`);
});
