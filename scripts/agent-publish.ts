// Agent workflows (P2-12), after Claude runs: pushes the agent's commits and opens the PR
// (Developer, Scraper-builder, Docs-keeper) or submits the review (QA), as the agent App.
// Usage: pnpm agent-publish --agent <a> --task-id <n> --source <dir> --base-sha <sha> [--issue <n>] [--pr <n>]
// Needs GH_TOKEN (the agent App token) and GITHUB_REPOSITORY; QA also KCW_REVIEW (Claude's structured output).
import { appendFileSync } from "node:fs";
import path from "node:path";
import { ghGet, type GhIssue } from "./lib/agent-github";
import { ensurePull, parseReviewDecision, pullText, pushCommits, submitReview } from "./lib/agent-publish";
import { AGENT_CONFIGS, branchOf, isWorkflowAgent } from "./lib/agents";
import { parseArgs } from "./lib/args";
import { runMain } from "./lib/main";

const args = parseArgs(process.argv.slice(2));

function num(name: string): number | undefined {
  const v = args[name];
  if (v === undefined || v === "") return undefined;
  if (typeof v !== "string" || !/^[1-9][0-9]{0,9}$/.test(v)) throw new Error(`--${name} must be a positive integer`);
  return Number(v);
}

await runMain(async () => {
  const agent = args.agent;
  const taskId = num("task-id");
  if (!isWorkflowAgent(agent) || taskId === undefined || typeof args.source !== "string" || typeof args["base-sha"] !== "string") {
    throw new Error("Usage: pnpm agent-publish --agent <a> --task-id <n> --source <dir> --base-sha <sha> [--issue <n>] [--pr <n>]");
  }
  const token = process.env.GH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) throw new Error("GH_TOKEN and GITHUB_REPOSITORY must be set");
  const gh = { repo, token };
  const branch = branchOf(taskId);
  const issue = num("issue");
  const pr = num("pr");
  const outputs: Record<string, string> = {};

  // QA: refuse a missing or malformed decision before pushing anything.
  const review = agent === "qa" ? parseReviewDecision(process.env.KCW_REVIEW) : undefined;

  const pushed = pushCommits({
    source: path.resolve(process.env.INIT_CWD ?? process.cwd(), args.source),
    baseSha: args["base-sha"],
    branch,
    rule: AGENT_CONFIGS[agent].pushRule,
    remoteUrl: `https://github.com/${repo}.git`,
    token,
  });
  console.log(
    pushed.pushed
      ? `agent-publish: pushed ${pushed.subjects.length} commit(s), ${pushed.files.length} file(s) to ${branch}`
      : "agent-publish: no new commits",
  );
  outputs.head_sha = pushed.headSha;
  outputs.pushed = String(pushed.pushed);

  if (agent === "qa") {
    if (pr === undefined) throw new Error("--pr is required for qa");
    await submitReview(gh, pr, pushed.headSha, review!);
    console.log(`agent-publish: review ${review!.decision} on PR #${pr}`);
    outputs.pr = String(pr);
  } else if (agent === "docs" && !pushed.pushed) {
    console.log("agent-publish: the docs needed no change; no PR");
  } else {
    if (agent !== "docs" && issue === undefined) throw new Error("--issue is required");
    const issueTitle =
      agent === "docs" ? undefined : (await ghGet<GhIssue>(gh, `/repos/${repo}/issues/${issue}`, `reading issue #${issue}`))?.title;
    const text = pullText({ agent, taskId, issue, issueTitle, mergedPr: pr, subjects: pushed.subjects });
    if (!pushed.pushed) {
      // Nothing new: fine in fix mode only if the PR already exists (ensurePull finds it).
      const open = await ghGet<unknown[]>(gh, `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${repo.split("/")[0]}:${branch}`)}`, "listing PRs");
      if (!open || open.length === 0) throw new Error("the agent made no commits and no PR exists");
    }
    const res = await ensurePull(gh, { branch, base: "main", ...text });
    console.log(`agent-publish: PR #${res.number} ${res.created ? "opened" : "already open"}`);
    outputs.pr = String(res.number);
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(""));
  }
});
