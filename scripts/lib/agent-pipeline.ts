// Trusted workflow controller. Candidate artifacts are data, never executable source.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { ghGet, type GhOptions, type GhPull, type GhCheckRun } from "./agent-github";
import { isWorkflowAgent, branchOf, type WorkflowAgent } from "./agents";

export interface TrustedContext {
  version: 1;
  agent: WorkflowAgent;
  repo: string;
  taskId: number;
  issue: number | null;
  pr: number | null;
  branch: string;
  baseSha: string;
  remoteSha: string | null;
  workflowSha: string;
}
const sha = /^[a-f0-9]{40}$/;
export function parseTrustedContext(text: string): TrustedContext {
  if (Buffer.byteLength(text) > 4096) throw new Error("context too large");
  const c = JSON.parse(text) as TrustedContext;
  if (!c || Object.keys(c).sort().join(",") !== "agent,baseSha,branch,issue,pr,remoteSha,repo,taskId,version,workflowSha" ||
      c.version !== 1 || !isWorkflowAgent(c.agent) || !/^[\w-]+\/[\w.-]+$/.test(c.repo) ||
      !Number.isSafeInteger(c.taskId) || c.taskId < 1 || c.branch !== branchOf(c.taskId) ||
      !sha.test(c.baseSha) || !sha.test(c.workflowSha) || (c.remoteSha !== null && !sha.test(c.remoteSha)) ||
      [c.issue, c.pr].some((n) => n !== null && (!Number.isSafeInteger(n) || n < 1))) throw new Error("invalid trusted context");
  return c;
}

/** Fixed single-file bundle; no work-produced baseline, role or authority metadata. */
export function candidateBundle(dir: string): string {
  if (lstatSync(dir).isSymbolicLink()) throw new Error("artifact directory is a link");
  const files = readdirSync(dir);
  if (files.sort().join(",") !== "candidate.bundle,usage.json") throw new Error("unexpected candidate artifact entries");
  const file = path.join(dir, "candidate.bundle");
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 16 || stat.size > 16 * 1024 * 1024) throw new Error("invalid candidate bundle");
  const usage = lstatSync(path.join(dir, "usage.json"));
  if (!usage.isFile() || usage.isSymbolicLink() || usage.size > 8192) throw new Error("invalid usage artifact");
  return file;
}

/** Remove instruction discovery paths at every depth before model access to payload. */
export function stripInstructions(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const target = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error("payload contains a symlink");
    if (/^(AGENTS(?:\.override)?|CLAUDE(?:\.local)?|GEMINI)\.md$/i.test(entry.name) ||
        /^\.(claude|codex|gemini|agents|mcp)(\..*)?$/i.test(entry.name) ||
        (entry.name === "agents" && path.basename(dir) === "docs")) rmSync(target, { recursive: true, force: true });
    else if (entry.isDirectory()) stripInstructions(target);
  }
}

/** Restore only required, pinned trusted guidance after all payload discovery is removed. */
export function restoreTrustedInstructions(dir: string, trustedRoot: string): string[] {
  const files = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "apps/web/AGENTS.md",
    ...readdirSync(path.join(trustedRoot, "docs/agents")).filter((file) => /^[\w.-]+\.md$/.test(file)).map((file) => `docs/agents/${file}`)];
  // Older task heads predate these bounded link targets. Fill only missing targets;
  // existing factual handoff/runbook content remains task data for review and tests.
  for (const file of ["docs/HANDOFF.md", "docs/runbooks/agent-security-cutover.md"]) {
    if (!existsSync(path.join(dir, file)) && existsSync(path.join(trustedRoot, file))) files.push(file);
  }
  for (const file of files) {
    const source = path.join(trustedRoot, file);
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("trusted guidance must be a regular file");
    const destination = path.join(dir, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  return files;
}

/** A missing permission, missing environment, or custom/all-branch policy fails closed. */
export async function requirePublisherEnvironment(gh: GhOptions, agent: WorkflowAgent): Promise<void> {
  const env = `agent-publish-${agent}`;
  const policy = await ghGet<{ deployment_branch_policy?: { protected_branches: boolean; custom_branch_policies: boolean } | null }>(gh,
    `/repos/${gh.repo}/environments/${env}`, "checking publisher environment");
  if (!policy?.deployment_branch_policy?.custom_branch_policies || policy.deployment_branch_policy.protected_branches) throw new Error("publisher environment must restrict deployment to main only");
  const rules = await ghGet<{ total_count: number; branch_policies: { name: string; type?: string }[] }>(gh,
    `/repos/${gh.repo}/environments/${env}/deployment-branch-policies?per_page=100`, "checking environment branches");
  if (rules?.total_count !== 1 || rules.branch_policies.length !== 1 || rules.branch_policies[0]?.name !== "main" || rules.branch_policies[0]?.type !== "branch") throw new Error("publisher environment must allow only the main branch");
}

export async function requireLivePull(gh: GhOptions, c: TrustedContext, head: string, ci: boolean): Promise<GhPull> {
  const pr = await ghGet<GhPull>(gh, `/repos/${gh.repo}/pulls/${c.pr}`, "binding task PR");
  if (!pr || pr.state !== "open" || pr.head.repo?.full_name !== c.repo || pr.head.ref !== c.branch || pr.base.ref !== "main" || pr.head.sha !== head) throw new Error("task PR changed or does not match trusted context");
  if (ci) {
    const checks = await ghGet<{ total_count: number; check_runs: (GhCheckRun & { app?: { slug: string }; head_sha?: string })[] }>(gh,
      `/repos/${gh.repo}/commits/${head}/check-runs?filter=latest&per_page=100`, "binding CI to review SHA");
    const required = checks?.check_runs.filter((r) => r.name === "ci/required" && r.app?.slug === "github-actions" && r.head_sha === head);
    if (!checks || checks.total_count > 100 || required?.length !== 1 || required[0]?.status !== "completed" || required[0]?.conclusion !== "success") throw new Error("review needs successful ci/required at its exact SHA");
  }
  return pr;
}

export function readContext(file: string): TrustedContext { return parseTrustedContext(readFileSync(file, "utf8")); }

export function requireCodeProgress(c: TrustedContext, pushed: boolean): void {
  if (!pushed && (c.agent === "developer" || c.agent === "scraper") && c.pr === null) throw new Error("the agent made no commits and no task PR exists");
}

export interface AdvisoryUsage { kind: "model"; provider: "anthropic"; model: string; input_tokens: number; output_tokens: number }
export function readAdvisoryUsage(dir: string, kind: "candidate" | "decision" = "candidate"): AdvisoryUsage[] {
  try {
    const files = readdirSync(dir).sort().join(",");
    if (lstatSync(dir).isSymbolicLink() || (files !== "usage.json" && files !== (kind === "candidate" ? "candidate.bundle,usage.json" : "decision.json,usage.json"))) return [];
    if (kind === "candidate" && files !== "usage.json") candidateBundle(dir);
    const stat = lstatSync(path.join(dir, "usage.json"));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) return [];
    const text = readFileSync(path.join(dir, "usage.json"), "utf8");
    const usage = JSON.parse(text) as AdvisoryUsage[];
    if (!Array.isArray(usage) || usage.length > 16 || usage.some((u) => !u || Object.keys(u).sort().join(",") !== "input_tokens,kind,model,output_tokens,provider" ||
      u.kind !== "model" || u.provider !== "anthropic" || !/^[\w.:/-]{1,100}$/.test(u.model) ||
      [u.input_tokens, u.output_tokens].some((n) => !Number.isSafeInteger(n) || n < 0 || n > 100_000_000))) return [];
    return usage;
  } catch { return []; } // Advisory data cannot suppress a trusted lifecycle failure event.
}

export interface ReportMessage { event?: "coding" | "qa_reviewing" | "failed"; usage?: AdvisoryUsage }
/**
 * The kcw-report messages of a start or final report (one usage line each). Start sends the
 * lifecycle event; a successful end sends usage only and nothing without usage (DESIGN §11 Q14(5));
 * any other end sends `failed` once, with or without usage.
 */
export function reportMessages(agent: WorkflowAgent, phase: "start" | "end", publishResult: string | undefined, usage: readonly AdvisoryUsage[]): ReportMessage[] {
  if (phase === "start") return [{ event: agent === "qa" ? "qa_reviewing" : "coding" }];
  if (publishResult === "success") return usage.map((u) => ({ usage: u }));
  if (usage.length === 0) return [{ event: "failed" }];
  return usage.map((u, i) => (i === 0 ? { event: "failed", usage: u } : { usage: u }));
}

export async function requireArtifact(gh: GhOptions, id: string | undefined, name: string, runId: string): Promise<void> {
  if (!id || !/^[1-9][0-9]{0,15}$/.test(id)) throw new Error("missing immutable artifact id");
  const artifact = await ghGet<{ id: number; name: string; expired: boolean; size_in_bytes: number; workflow_run?: { id: number; head_sha: string } }>(gh,
    `/repos/${gh.repo}/actions/artifacts/${id}`, "binding immutable artifact");
  if (!artifact || String(artifact.id) !== id || artifact.name !== name || artifact.expired ||
      String(artifact.workflow_run?.id) !== runId || artifact.workflow_run?.head_sha !== process.env.GITHUB_SHA ||
      artifact.size_in_bytes > 20 * 1024 * 1024) throw new Error("artifact does not belong to this run and purpose");
}
