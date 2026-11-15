// In-memory GitHubClient for graph tests (P2-10). It records every call, keeps issues, dispatches,
// checks and merges, and answers getDiff/getArtifact from data the test sets up. Behaviour mirrors
// OctokitGitHubClient: squash merge refused when the head moved, 409-style cancel of a finished run.
import type { MergeInput } from "@kcw/core/merge-input";
import {
  ArtifactFormatError,
  GitHubApiError,
  MERGE_RULES_CHECK,
  type ArtifactResult,
  type CancelResult,
  type CheckState,
  type CreateIssueInput,
  type CreatedIssue,
  type DispatchResult,
  type DispatchWorkflowInput,
  type FindWorkflowRunInput,
  type GetArtifactInput,
  type GitHubClient,
  type ListRecentIssuesInput,
  type MergePrInput,
  type MergeResult,
  type PostCheckInput,
  type PostedCheck,
  type PrDiff,
  type PrMergeState,
  type RecentIssue,
  type WorkflowRunInfo,
} from "./types";

export type FakeMethod = keyof GitHubClient;

export interface FakePr {
  headSha: string;
  author: string;
  files: PrDiff["files"];
  patches?: PrDiff["patches"];
  /** Defaults to true. */
  mergeable?: boolean;
  /** getDiff's `complete` (defaults to true; false = GitHub listed only part of the files). */
  complete?: boolean;
  merged?: boolean;
  /** Set by the fake's merge. */
  mergeSha?: string;
}

export interface FakeCheck {
  id: number;
  name: string;
  headSha: string;
  state: CheckState;
  title: string;
  summary: string;
}

/** The first fake's first workflow run id (realistic size, well below 2^53). */
export const FAKE_FIRST_RUN_ID = 40_000_000_001;

/** Run ids each fake may hand out before the next fake's block starts. */
const FAKE_RUN_ID_BLOCK = 1_000_000;

/** Fakes created so far in this module instance (one per test file under Vitest). */
let fakeInstances = 0;

export interface FakeGitHubOptions {
  /**
   * The first run id this fake's dispatches return (then +1 each). Defaults to a block of its own,
   * FAKE_FIRST_RUN_ID + n * 1,000,000 for the n-th fake created (from 0), so fakes that share one
   * database never hand out the same run id for different tasks.
   */
  firstRunId?: number;
}

export class FakeGitHubClient implements GitHubClient {
  readonly calls: { method: FakeMethod; args: unknown }[] = [];
  readonly issues: (CreateIssueInput & CreatedIssue & { createdAt: string })[] = [];
  readonly dispatches: (DispatchWorkflowInput & { ref: string; runId: number | null })[] = [];
  /**
   * `sequential`: every dispatch returns this fake's next run id (deterministic, see
   * FakeGitHubOptions.firstRunId); `null`: dispatches return no run id (a 204 answer).
   */
  runIdMode: "sequential" | "null" = "sequential";
  readonly checks: FakeCheck[] = [];
  readonly merges: { pr: number; sha: string }[] = [];
  readonly cancelled: number[] = [];
  /** PRs by number; set them up before calling getDiff/merge. */
  readonly prs = new Map<number, FakePr>();
  /** Merge-rules artifacts by head SHA. */
  readonly artifacts = new Map<string, MergeInput>();
  /** Heads whose trusted run is not usable: getArtifact answers `trusted_run_<state>` instead of reading `artifacts`. */
  readonly trustedRunStates = new Map<string, "pending" | "failed">();
  /** Run ids that are still running (cancelRun of any other id returns `not_running`). */
  readonly runningRuns = new Set<number>();
  /** Workflow runs findWorkflowRun searches; tests add and update them. */
  readonly workflowRuns: (WorkflowRunInfo & { workflow: string; displayTitle: string; createdAt: string })[] = [];
  /**
   * The fake's clock (issue and run creation times); tests that use a fixed clock set it to theirs.
   */
  now: () => Date = () => new Date();
  /** Dispatches also add a workflow run (display title `<role> task <task_id>`) that findWorkflowRun sees. Off by default. */
  registerRuns = false;
  /** While true, findWorkflowRun does not see registered runs (GitHub's delayed run visibility). */
  hideRuns = false;
  #failures = new Map<FakeMethod, GitHubApiError>();
  #afterFailures = new Set<FakeMethod>();
  #nextId = 1;
  #nextRunId: number;

  constructor(opts: FakeGitHubOptions = {}) {
    this.#nextRunId = opts.firstRunId ?? FAKE_FIRST_RUN_ID + fakeInstances * FAKE_RUN_ID_BLOCK;
    fakeInstances += 1;
  }

  /** The next call of `method` throws a GitHubApiError with this status. */
  failNext(method: FakeMethod, status = 500): void {
    this.#failures.set(method, new GitHubApiError(method, status));
  }

  /**
   * The next call of `method` (createIssue, dispatchWorkflow or merge) takes effect and then throws
   * a GitHubApiError without status: the response was lost (a socket error).
   */
  failAfterNext(method: "createIssue" | "dispatchWorkflow" | "merge"): void {
    this.#afterFailures.add(method);
  }

  #lostResponse(method: FakeMethod): void {
    if (this.#afterFailures.delete(method)) throw new GitHubApiError(method, undefined);
  }

  #record(method: FakeMethod, args: unknown): void {
    this.calls.push({ method, args });
    const failure = this.#failures.get(method);
    if (failure) {
      this.#failures.delete(method);
      throw failure;
    }
  }

  /** The latest check of that name on that SHA (what the ruleset sees). */
  latestCheck(headSha: string, name = MERGE_RULES_CHECK): FakeCheck | undefined {
    return this.checks.filter((c) => c.headSha === headSha && c.name === name).at(-1);
  }

  async createIssue(input: CreateIssueInput): Promise<CreatedIssue> {
    this.#record("createIssue", input);
    const number = this.#nextId++;
    const issue = { number, url: `https://github.invalid/issues/${number}` };
    this.issues.push({ ...input, ...issue, createdAt: this.now().toISOString() });
    this.#lostResponse("createIssue");
    return issue;
  }

  async dispatchWorkflow(input: DispatchWorkflowInput): Promise<DispatchResult> {
    this.#record("dispatchWorkflow", input);
    const runId = this.runIdMode === "null" ? null : this.#nextRunId++;
    this.dispatches.push({ ...input, inputs: { ...input.inputs }, ref: input.ref ?? "main", runId });
    if (this.registerRuns) {
      const role = /^agent-([a-z]+)\.yml$/.exec(input.workflow)?.[1] ?? "agent";
      this.workflowRuns.push({
        id: runId ?? 900_000_000 + this.#nextId++,
        status: "queued",
        conclusion: null,
        workflow: input.workflow,
        displayTitle: `${role} task ${input.inputs.task_id}`,
        createdAt: this.now().toISOString(),
      });
    }
    this.#lostResponse("dispatchWorkflow");
    return { runId };
  }

  async merge(input: MergePrInput): Promise<MergeResult> {
    this.#record("merge", input);
    const pr = this.prs.get(input.pr);
    if (!pr) throw new GitHubApiError("merge", 404);
    if (pr.headSha !== input.headSha) return { merged: false, reason: "head_changed" };
    if (pr.merged || pr.mergeable === false) return { merged: false, reason: "not_mergeable" };
    pr.merged = true;
    const sha = `squash-${input.pr}-${input.headSha}`;
    pr.mergeSha = sha;
    this.merges.push({ pr: input.pr, sha });
    this.#lostResponse("merge");
    return { merged: true, sha };
  }

  async postCheck(input: PostCheckInput): Promise<PostedCheck> {
    this.#record("postCheck", input);
    const check: FakeCheck = {
      id: this.#nextId++,
      name: input.name ?? MERGE_RULES_CHECK,
      headSha: input.headSha,
      state: input.state,
      title: input.title,
      summary: input.summary,
    };
    this.checks.push(check);
    return { id: check.id };
  }

  async cancelRun(runId: number): Promise<CancelResult> {
    this.#record("cancelRun", runId);
    if (!this.runningRuns.delete(runId)) return "not_running";
    this.cancelled.push(runId);
    return "cancelled";
  }

  async getDiff(pr: number): Promise<PrDiff> {
    this.#record("getDiff", pr);
    const p = this.prs.get(pr);
    if (!p) throw new GitHubApiError("getDiff", 404);
    return {
      headSha: p.headSha,
      author: p.author,
      files: p.files.map((f) => ({ ...f })),
      patches: { ...p.patches },
      complete: p.complete ?? true,
    };
  }

  async getArtifact(input: GetArtifactInput): Promise<ArtifactResult> {
    this.#record("getArtifact", input);
    const state = this.trustedRunStates.get(input.headSha);
    if (state) return { found: false, reason: `trusted_run_${state}` };
    const found = this.artifacts.get(input.headSha);
    if (!found) return { found: false, reason: "no_artifact" };
    if (found.pr !== input.pr || found.headSha !== input.headSha) throw new ArtifactFormatError("merge-rules input belongs to another PR or head");
    return { found: true, input: structuredClone(found), runId: 1, artifactId: 1 };
  }

  async findWorkflowRun(input: FindWorkflowRunInput): Promise<WorkflowRunInfo | null> {
    this.#record("findWorkflowRun", input);
    if (this.hideRuns) return null;
    const run = this.workflowRuns
      .filter((r) => r.workflow === input.workflow && r.displayTitle === input.displayTitle && Date.parse(r.createdAt) >= Date.parse(input.createdAfter))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)[0];
    return run ? { id: run.id, status: run.status, conclusion: run.conclusion } : null;
  }

  async listRecentIssues(input: ListRecentIssuesInput): Promise<RecentIssue[]> {
    this.#record("listRecentIssues", input);
    return this.issues
      .filter((i) => Date.parse(i.createdAt) >= Date.parse(input.createdAfter))
      .map((i) => ({ number: i.number, body: i.body, createdAt: i.createdAt }))
      .reverse();
  }

  async getPrMergeState(pr: number): Promise<PrMergeState> {
    this.#record("getPrMergeState", pr);
    const p = this.prs.get(pr);
    if (!p) throw new GitHubApiError("getPrMergeState", 404);
    return { merged: p.merged === true, mergeCommitSha: p.merged === true ? (p.mergeSha ?? null) : null };
  }
}
