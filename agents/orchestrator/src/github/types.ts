// The orchestrator's view of GitHub (P2-09, DESIGN §4.1-§4.2). The task graph (P2-10) depends on
// this interface only; `OctokitGitHubClient` talks to the REST API as the orchestrator App and
// `FakeGitHubClient` keeps everything in memory for graph tests.
import type { MergeInput } from "@kcw/core/merge-input";

/** The repo the orchestrator App is installed on (D23). */
export const DEFAULT_REPO = "kentkodes/kentcrosswise";

/** The check the `main` ruleset requires from the orchestrator App (DESIGN §4.1). */
export const MERGE_RULES_CHECK = "kcw/merge-rules";

/** The PR workflow whose `prod-plan` job uploads the merge-rules artifact (P2-13). */
export const CI_WORKFLOW = "ci.yml";

export interface CreateIssueInput {
  /** Sanitized public text only (DESIGN §4.5): the repo and its issues are public. */
  title: string;
  body: string;
  labels?: string[];
}

export interface CreatedIssue {
  number: number;
  /** html_url */
  url: string;
}

export interface DispatchWorkflowInput {
  /** Workflow file name, e.g. `agent-developer.yml`. */
  workflow: string;
  /** Defaults to `main`: agent workflows always run main's trusted config (DESIGN §4.1). */
  ref?: string;
  /** workflow_dispatch inputs are strings. */
  inputs: Record<string, string>;
}

/**
 * What a dispatch returns (RUN-ID-MAPPING-SPEC §1). `runId` is the created run's id when GitHub
 * returned valid run details (a positive safe integer), else null: a 204 answer or a missing or
 * invalid id. The run was created either way; null only means the title fallback maps it.
 */
export interface DispatchResult {
  runId: number | null;
}

export interface MergePrInput {
  pr: number;
  /** The head SHA merge-rules evaluated. GitHub refuses the merge (409) if the head moved since. */
  headSha: string;
  /** Squash commit title; GitHub's default when omitted. */
  title?: string;
}

export type MergeResult =
  | { merged: true; sha: string }
  /** `head_changed`: 409, the PR head is not `headSha`; `not_mergeable`: 405 (ruleset, conflicts, pending checks). */
  | { merged: false; reason: "head_changed" | "not_mergeable" };

/** `pending` = in progress (blocks the ruleset); `success` / `failure` complete the check. */
export type CheckState = "pending" | "success" | "failure";

export interface PostCheckInput {
  headSha: string;
  /** Defaults to MERGE_RULES_CHECK. */
  name?: string;
  state: CheckState;
  title: string;
  /** Markdown; public (paths and package names only). */
  summary: string;
}

export interface PostedCheck {
  id: number;
}

export type CancelResult = "cancelled" | "not_running";

/** One changed file of a PR (structurally the same as `ChangedFile` in agents/merge-rules). */
export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
  previousPath?: string;
}

/** What merge-rules needs from the PR besides the CI artifact (`files`, `patches`, `author`). */
export interface PrDiff {
  headSha: string;
  /** PR author login. */
  author: string;
  files: ChangedFile[];
  /** Unified diff per path; GitHub omits it for binary or very large files. */
  patches: Record<string, string | undefined>;
  /**
   * False when GitHub listed fewer files than the PR changes (the files API stops at 3000).
   * Callers must fail closed (treat as critical).
   */
  complete: boolean;
}

export interface GetArtifactInput {
  pr: number;
  /** The PR head SHA merge-rules evaluates. */
  headSha: string;
}

export type ArtifactResult =
  | { found: true; input: MergeInput; runId: number; artifactId: number }
  /**
   * `no_run`: no ci.yml run for this head yet; `no_artifact`: the runs have no (unexpired) artifact,
   * e.g. prod-plan has not finished or failed. Callers treat merge-rules input as missing (fail closed).
   */
  | { found: false; reason: "no_run" | "no_artifact" };

export interface FindWorkflowRunInput {
  /** Workflow file name, e.g. `agent-docs.yml`. */
  workflow: string;
  /** The run's exact `display_title` (its `run-name`). */
  displayTitle: string;
  /** ISO time; only workflow_dispatch runs created at or after it count. */
  createdAfter: string;
}

export interface WorkflowRunInfo {
  id: number;
  /** `queued`, `in_progress`, `completed`, ... */
  status: string;
  /** Set once completed: `success`, `failure`, `cancelled`, `skipped`, `timed_out`, ... */
  conclusion: string | null;
}

export interface GitHubClient {
  createIssue(input: CreateIssueInput): Promise<CreatedIssue>;
  /** Never fails because run details are missing (`runId` null); fails only when GitHub refuses the dispatch. */
  dispatchWorkflow(input: DispatchWorkflowInput): Promise<DispatchResult>;
  /** Squash merge (the ruleset allows squash only). */
  merge(input: MergePrInput): Promise<MergeResult>;
  postCheck(input: PostCheckInput): Promise<PostedCheck>;
  cancelRun(runId: number): Promise<CancelResult>;
  getDiff(pr: number): Promise<PrDiff>;
  /** The P2-13 merge-rules input (`@kcw/core/merge-input`) of the PR head's ci.yml run. */
  getArtifact(input: GetArtifactInput): Promise<ArtifactResult>;
  /** The newest workflow_dispatch run of `workflow` with that display title created since `createdAfter`, or null. */
  findWorkflowRun(input: FindWorkflowRunInput): Promise<WorkflowRunInfo | null>;
}

/**
 * A GitHub API call failed. The message names the operation and the HTTP status only (never a
 * token, request body or response body); the Octokit error is kept as `cause`.
 */
export class GitHubApiError extends Error {
  override name = "GitHubApiError";
  constructor(
    readonly operation: string,
    readonly status: number | undefined,
    options?: { cause?: unknown },
  ) {
    super(`${operation} failed${status === undefined ? "" : `: GitHub returned ${status}`}`, options);
  }
}

/** Missing or malformed App configuration. The message names the setting, never its value. */
export class GitHubConfigError extends Error {
  override name = "GitHubConfigError";
}

/** The downloaded artifact is not what P2-13 uploads (bad zip, missing file, too large). */
export class ArtifactFormatError extends Error {
  override name = "ArtifactFormatError";
}
