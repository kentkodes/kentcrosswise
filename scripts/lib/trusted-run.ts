// Merge-time verification that a head was tested by the trusted preview path (AR1 slice 2, for PR B).
// Not wired into anything yet. CLI: scripts/verify-trusted-preview.ts.
//
// What is trusted and why: a workflow_run workflow always runs from the default branch, so a run of
// preview-trusted.yml was defined by main. Its `run-name` is `trusted-preview <triggering head sha>` and
// its `provision` job is named `provision (pr <n> @ <verified head sha>)`, both written from values the
// trusted verify job produced. Commit statuses are NOT used: a same-repo PR workflow with
// `statuses: write` could forge `kcw/trusted-preview`.
import type { GitHubRest } from "./trusted-preview";

export const TRUSTED_WORKFLOW_FILE = "preview-trusted.yml";
export const TRUSTED_WORKFLOW_PATH = `.github/workflows/${TRUSTED_WORKFLOW_FILE}`;
const REQUIRED_JOBS = ["verify", "e2e", "teardown", "result"] as const;

export interface WorkflowRun {
  id: number;
  run_number: number;
  event: string;
  status: string | null;
  conclusion: string | null;
  path: string;
  display_title: string;
}

export interface WorkflowJob {
  name: string;
  conclusion: string | null;
}

export type TrustedResult = { ok: true; runId: number } | { ok: false; reason: string };

export function runTitle(sha: string): string {
  return `trusted-preview ${sha}`;
}

export function provisionJobName(pr: number, sha: string): string {
  return `provision (pr ${pr} @ ${sha})`;
}

/** `.github/workflows/x.yml` or `.github/workflows/x.yml@refs/heads/<default>` (the API sometimes adds the ref). */
function pathIsDefaultBranch(runPath: string, defaultBranch: string): boolean {
  return runPath === TRUSTED_WORKFLOW_PATH || runPath === `${TRUSTED_WORKFLOW_PATH}@refs/heads/${defaultBranch}`;
}

export async function verifyTrustedPreview(api: GitHubRest, input: { repo: string; pr: number; sha: string }): Promise<TrustedResult> {
  const repo = await api.get<{ default_branch: string }>(`/repos/${input.repo}`, "reading the repository");
  if (!repo) return { ok: false, reason: "repository not found" };
  const listed = await api.get<{ workflow_runs: WorkflowRun[] }>(
    `/repos/${input.repo}/actions/workflows/${TRUSTED_WORKFLOW_FILE}/runs?event=workflow_run&per_page=100`,
    "listing trusted preview runs",
  );
  if (!listed) return { ok: false, reason: `workflow ${TRUSTED_WORKFLOW_FILE} not found` };
  const mine = listed.workflow_runs.filter((r) => r.display_title === runTitle(input.sha)).sort((a, b) => b.run_number - a.run_number);
  const latest = mine[0];
  if (!latest) return { ok: false, reason: `no ${TRUSTED_WORKFLOW_FILE} run for head ${input.sha}` };
  if (latest.event !== "workflow_run") return { ok: false, reason: "latest run was not triggered by workflow_run" };
  if (!pathIsDefaultBranch(latest.path, repo.default_branch)) return { ok: false, reason: `run workflow path ${latest.path} is not ${TRUSTED_WORKFLOW_PATH} on ${repo.default_branch}` };
  if (latest.status !== "completed" || latest.conclusion !== "success") {
    return { ok: false, reason: `latest run ${latest.id} is ${latest.status}/${latest.conclusion ?? "none"}` };
  }
  const jobs = await api.get<{ jobs: WorkflowJob[] }>(`/repos/${input.repo}/actions/runs/${latest.id}/jobs?per_page=100`, "listing run jobs");
  if (!jobs) return { ok: false, reason: `jobs of run ${latest.id} not found` };
  for (const name of REQUIRED_JOBS) {
    const job = jobs.jobs.find((j) => j.name === name);
    if (!job || job.conclusion !== "success") return { ok: false, reason: `job ${name} did not succeed in run ${latest.id}` };
  }
  const provision = jobs.jobs.find((j) => j.name === provisionJobName(input.pr, input.sha));
  if (!provision || provision.conclusion !== "success") {
    return { ok: false, reason: `run ${latest.id} did not provision PR #${input.pr} at ${input.sha}` };
  }
  return { ok: true, runId: latest.id };
}
