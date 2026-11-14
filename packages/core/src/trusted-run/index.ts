// Was this PR head tested by the trusted path? (AR1 slice 2, extended in slice 3.) Shared by the owner merge
// script (scripts/verify-trusted-preview.ts) and the orchestrator, which also reads the trusted run's
// `merge-rules-input` artifact only from the run this check accepts.
//
// What is trusted and why: a workflow_run workflow always runs from the default branch, so a run of
// preview-trusted.yml was defined by main. Its `run-name` is `trusted-preview <triggering head sha>` and
// its `provision` job is named `provision (pr <n> @ <verified head sha>)`, both written from values the
// trusted verify job produced. Commit statuses are NOT used: a same-repo PR workflow with
// `statuses: write` could forge `kcw/trusted-preview`.

/** The only GitHub access the check needs: a JSON GET that answers undefined on 404. Tests inject fakes. */
export interface GitHubRead {
  get<T>(path: string, what: string): Promise<T | undefined>;
}

export const TRUSTED_WORKFLOW_FILE = "preview-trusted.yml";
export const TRUSTED_WORKFLOW_PATH = `.github/workflows/${TRUSTED_WORKFLOW_FILE}`;
/** Every one of these jobs must have succeeded; `prod-plan` produces the merge-rules input. */
export const REQUIRED_JOBS = ["verify", "prod-plan", "e2e", "teardown", "result"] as const;

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

/**
 * `pending`: no run for the head yet, or the latest one has not finished (waiting can help).
 * `failed`: the latest run finished unsuccessfully or is not the trusted definition.
 */
export type TrustedResult = { ok: true; runId: number } | { ok: false; reason: string; state: "pending" | "failed" };

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

export async function verifyTrustedPreview(api: GitHubRead, input: { repo: string; pr: number; sha: string }): Promise<TrustedResult> {
  const failed = (reason: string): TrustedResult => ({ ok: false, reason, state: "failed" });
  const repo = await api.get<{ default_branch: string }>(`/repos/${input.repo}`, "reading the repository");
  if (!repo) return failed("repository not found");
  const listed = await api.get<{ workflow_runs: WorkflowRun[] }>(
    `/repos/${input.repo}/actions/workflows/${TRUSTED_WORKFLOW_FILE}/runs?event=workflow_run&per_page=100`,
    "listing trusted preview runs",
  );
  if (!listed) return failed(`workflow ${TRUSTED_WORKFLOW_FILE} not found`);
  const mine = listed.workflow_runs.filter((r) => r.display_title === runTitle(input.sha)).sort((a, b) => b.run_number - a.run_number);
  const latest = mine[0];
  if (!latest) return { ok: false, reason: `no ${TRUSTED_WORKFLOW_FILE} run for head ${input.sha}`, state: "pending" };
  if (latest.event !== "workflow_run") return failed("latest run was not triggered by workflow_run");
  if (!pathIsDefaultBranch(latest.path, repo.default_branch)) return failed(`run workflow path ${latest.path} is not ${TRUSTED_WORKFLOW_PATH} on ${repo.default_branch}`);
  if (latest.status !== "completed") return { ok: false, reason: `latest run ${latest.id} is ${latest.status}`, state: "pending" };
  if (latest.conclusion !== "success") return failed(`latest run ${latest.id} is ${latest.status}/${latest.conclusion ?? "none"}`);
  const jobs = await api.get<{ jobs: WorkflowJob[] }>(`/repos/${input.repo}/actions/runs/${latest.id}/jobs?per_page=100`, "listing run jobs");
  if (!jobs) return failed(`jobs of run ${latest.id} not found`);
  for (const name of REQUIRED_JOBS) {
    const job = jobs.jobs.find((j) => j.name === name);
    if (!job || job.conclusion !== "success") return failed(`job ${name} did not succeed in run ${latest.id}`);
  }
  const provision = jobs.jobs.find((j) => j.name === provisionJobName(input.pr, input.sha));
  if (!provision || provision.conclusion !== "success") return failed(`run ${latest.id} did not provision PR #${input.pr} at ${input.sha}`);
  return { ok: true, runId: latest.id };
}
