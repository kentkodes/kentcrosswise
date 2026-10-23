import { appendFileSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, lstatSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gatherContext, linkedIssue, parseInputs } from "./lib/agent-context";
import { ghGet, type GhPull } from "./lib/agent-github";
import { AGENT_CONFIGS, isWorkflowAgent } from "./lib/agents";
import { candidateBundle, parseTrustedContext, readAdvisoryUsage, readContext, requireArtifact, requireCodeProgress, requireLivePull, requirePublisherEnvironment, restoreTrustedInstructions, stripInstructions } from "./lib/agent-pipeline";
import { ensurePull, parseReviewDecision, pullText, pushCommits, runGit, submitReview } from "./lib/agent-publish";
import { parseArgs } from "./lib/args";
import { runMain } from "./lib/main";
import { runCli, usageFromExecution } from "../agents/report/src/index";

const args = parseArgs(process.argv.slice(2));
function executionUsage(): unknown[] {
  try {
    const execution = process.env.KCW_EXECUTION_FILE;
    if (!execution) return [];
    const stat = lstatSync(execution);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) return [];
    return usageFromExecution(JSON.parse(readFileSync(execution, "utf8"))).slice(0, 16);
  } catch { return []; }
}
function output(values: Record<string, string>) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([k,v]) => `${k}=${v}\n`).join(""));
}
await runMain(async () => {
  const command = args.command;
  if (command === "usage") {
    if (args.kind !== "candidate" && args.kind !== "decision") throw new Error("usage purpose required");
    mkdirSync(args.kind, { recursive: true });
    writeFileSync(`${args.kind}/usage.json`, JSON.stringify(executionUsage())); return;
  }
  if (command === "sanitize") {
    const files = runGit(["ls-files", "-z"], { cwd: "payload" }).split("\0").filter(Boolean);
    for (const file of files.filter((f) => /(^|\/)(AGENTS(?:\.override)?|CLAUDE(?:\.local)?|GEMINI)\.md$|(^|\/)\.(claude|codex|gemini|agents|mcp)([./]|$)|(^|\/)docs\/agents\//i.test(f))) {
      runGit(["update-index", "--skip-worktree", "--", file], { cwd: "payload" });
    }
    stripInstructions(path.resolve("payload"));
    const tracked = new Set(files);
    const restored = restoreTrustedInstructions(path.resolve("payload"), process.cwd());
    for (const file of restored.filter((file) => tracked.has(file))) {
      runGit(["update-index", "--skip-worktree", "--", file], { cwd: "payload" });
    }
    // A PR may remove a guidance path from its index. Restoring trusted guidance must not
    // manufacture a staged addition or let a broad git add commit the local-only copy.
    const untracked = restored.filter((file) => !tracked.has(file));
    if (untracked.length) {
      const exclude = path.resolve("payload", runGit(["rev-parse", "--git-path", "info/exclude"], { cwd: "payload" }));
      mkdirSync(path.dirname(exclude), { recursive: true });
      appendFileSync(exclude, `\n${untracked.map((file) => `/${file}`).join("\n")}\n`);
    }
    return;
  }
  if (command === "export") {
    mkdirSync("candidate", { recursive: true });
    if (runGit(["rev-parse", "HEAD"], { cwd: "payload" }) === process.env.KCW_BASE_SHA) writeFileSync("candidate/candidate.bundle", "KCW_UNCHANGED_V1\n");
    else runGit(["bundle", "create", path.resolve("candidate/candidate.bundle"), "HEAD", `^${process.env.KCW_BASE_SHA}`], { cwd: "payload" });
    writeFileSync("candidate/usage.json", JSON.stringify(executionUsage()));
    return;
  }
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!repo || !token) throw new Error("repository and read token are required");
  const gh = { repo, token };
  if (command === "artifact") {
    if (!isWorkflowAgent(args.agent) || typeof args.kind !== "string" || !["context", "candidate", "decision"].includes(args.kind)) throw new Error("artifact purpose required");
    const name = `${args.kind}-${args.kind === "decision" ? "" : `${args.agent}-`}${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
    await requireArtifact(gh, process.env.KCW_ARTIFACT_ID, name, process.env.GITHUB_RUN_ID!); return;
  }
  if (command === "guard") {
    if (!isWorkflowAgent(args.agent)) throw new Error("agent required");
    await requirePublisherEnvironment(gh, args.agent); return;
  }
  if (command === "prepare") {
    if (!isWorkflowAgent(args.agent)) throw new Error("agent required");
    const inputs = parseInputs(args.agent, { task_id: process.env.KCW_TASK_ID, issue: process.env.KCW_ISSUE, pr: process.env.KCW_PR, mode: process.env.KCW_MODE });
    const gathered = await gatherContext(inputs, gh);
    const branch = gathered.outputs.branch!;
    const existing = await ghGet<{ object: { sha: string } }>(gh, `/repos/${repo}/git/ref/heads/${branch}`, "reading task ref");
    let prNumber = inputs.pr ?? null;
    if (existing && (inputs.agent === "developer" || inputs.agent === "scraper") && prNumber === null) {
      const pulls = await ghGet<GhPull[]>(gh, `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${repo.split("/")[0]}:${branch}`)}`, "binding retry task PR");
      if ((pulls?.length ?? 0) > 1) throw new Error("ambiguous task PR");
      if (pulls?.[0]) {
        if (linkedIssue(pulls[0].body) !== inputs.issue) throw new Error("retry task PR does not close the dispatched issue");
        prNumber = pulls[0].number;
      }
    }
    const workflowSha = process.env.GITHUB_SHA!;
    const c = parseTrustedContext(JSON.stringify({ version: 1, agent: inputs.agent, repo, taskId: inputs.taskId, issue: inputs.issue ?? null, pr: prNumber,
      branch, workflowSha, baseSha: gathered.outputs.head_sha ?? existing?.object.sha ?? workflowSha, remoteSha: existing?.object.sha ?? null }));
    if (c.pr && c.agent !== "docs") await requireLivePull(gh, c, c.baseSha, c.agent === "qa");
    mkdirSync("context", { recursive: true });
    writeFileSync("context/context.json", JSON.stringify(c));
    writeFileSync("context/task.md", gathered.markdown);
    output({ base_sha: c.baseSha, skip: gathered.outputs.skip! }); return;
  }
  const c = readContext("context/context.json");
  if (c.repo !== repo || c.workflowSha !== process.env.GITHUB_SHA || c.agent !== args.agent) throw new Error("trusted context binding mismatch");
  if (command === "review-input") { await requireLivePull(gh, c, c.baseSha, true); return; }
  if (command === "review-output") {
    const review = parseReviewDecision(process.env.KCW_REVIEW);
    mkdirSync("decision", { recursive: true });
    writeFileSync("decision/decision.json", JSON.stringify({ sha: c.baseSha, review }));
    writeFileSync("decision/usage.json", JSON.stringify(executionUsage())); return;
  }
  if (command === "report") {
    const usage = args.phase === "start" ? [] : [...readAdvisoryUsage("candidate"), ...readAdvisoryUsage("decision", "decision")];
    const event = args.phase === "start" || process.env.KCW_PUBLISH_RESULT === "success" ? (c.agent === "qa" ? "qa_reviewing" : "coding") : "failed";
    for (const [i,u] of (usage.length ? usage : [undefined]).entries()) await runCli([
      "--task-id", String(c.taskId), "--agent", c.agent, "--event-type", event,
      "--dedupe-id", `run-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-${args.phase === "start" ? "start" : "end"}-${i}`,
      ...(u ? ["--provider", u.provider, "--model", u.model, "--input-tokens", String(u.input_tokens), "--output-tokens", String(u.output_tokens)] : []),
    ], { env: process.env, stdout: console.log });
    return;
  }
  if (command !== "publish") throw new Error("unknown pipeline command");
  const dir = mkdtempSync(path.join(tmpdir(), "kcw-candidate-"));
  try {
    runGit(["init", "--bare", "-q", dir]);
    runGit(["fetch", "-q", "--no-tags", `https://github.com/${repo}.git`, c.baseSha], { cwd: dir });
    const bundle = candidateBundle("candidate");
    if (readFileSync(bundle, "utf8") !== "KCW_UNCHANGED_V1\n") {
      runGit(["bundle", "verify", path.resolve(bundle)], { cwd: dir });
      const refs = runGit(["bundle", "list-heads", path.resolve(bundle)], { cwd: dir });
      if (!/^[a-f0-9]{40} HEAD$/.test(refs)) throw new Error("bundle must contain exactly HEAD");
      runGit(["fetch", "-q", path.resolve(bundle), "HEAD"], { cwd: dir });
    }
    runGit(["update-ref", "refs/heads/candidate", "FETCH_HEAD"], { cwd: dir });
    runGit(["symbolic-ref", "HEAD", "refs/heads/candidate"], { cwd: dir });
    if (runGit(["fsck", "--strict", "--no-reflogs", "--unreachable"], { cwd: dir })) throw new Error("candidate contains extra unreachable history");
    if (c.pr && c.agent !== "docs") await requireLivePull(gh, c, c.baseSha, false);
    const pushed = pushCommits({ source: dir, baseSha: c.baseSha, branch: c.branch, rule: AGENT_CONFIGS[c.agent].pushRule,
      remoteUrl: `https://github.com/${repo}.git`, token, expectedRemoteSha: c.remoteSha });
    requireCodeProgress(c, pushed.pushed);
    if (c.agent === "qa") {
      // A new test commit needs new CI and a new independent review; this run cannot approve it.
      if (pushed.pushed) { output({ pushed: "true", review_deferred: "true" }); return; }
      const stat = lstatSync("decision/decision.json");
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64_256 || readdirSync("decision").sort().join(",") !== "decision.json,usage.json") throw new Error("invalid decision artifact");
      const decision = JSON.parse(readFileSync("decision/decision.json", "utf8")) as { sha?: unknown; review?: unknown };
      if (Object.keys(decision).sort().join(",") !== "review,sha" || decision.sha !== c.baseSha) throw new Error("review SHA mismatch");
      const review = parseReviewDecision(JSON.stringify(decision.review));
      await requireLivePull(gh, c, c.baseSha, true);
      await submitReview(gh, c.pr!, c.baseSha, review);
    } else if (pushed.pushed) {
      const text = pullText({ agent: c.agent, taskId: c.taskId, issue: c.issue ?? undefined, mergedPr: c.pr ?? undefined, subjects: pushed.subjects });
      await ensurePull(gh, { branch: c.branch, base: "main", ...text });
    }
    output({ pushed: String(pushed.pushed) });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
