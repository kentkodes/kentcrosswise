// In-memory GitHubClient for graph tests (P2-10). It records every call, keeps issues, dispatches,
// checks and merges, and answers getDiff/getArtifact from data the test sets up. Behaviour mirrors
// OctokitGitHubClient: squash merge refused when the head moved, 409-style cancel of a finished run.
import type { MergeInput } from "@kcw/core/merge-input";
import {
  GitHubApiError,
  MERGE_RULES_CHECK,
  type ArtifactResult,
  type CancelResult,
  type CheckState,
  type CreateIssueInput,
  type CreatedIssue,
  type DispatchWorkflowInput,
  type GetArtifactInput,
  type GitHubClient,
  type MergePrInput,
  type MergeResult,
  type PostCheckInput,
  type PostedCheck,
  type PrDiff,
} from "./types";

export type FakeMethod = keyof GitHubClient;

export interface FakePr {
  headSha: string;
  author: string;
  files: PrDiff["files"];
  patches?: PrDiff["patches"];
  /** Defaults to true. */
  mergeable?: boolean;
  merged?: boolean;
}

export interface FakeCheck {
  id: number;
  name: string;
  headSha: string;
  state: CheckState;
  title: string;
  summary: string;
}

export class FakeGitHubClient implements GitHubClient {
  readonly calls: { method: FakeMethod; args: unknown }[] = [];
  readonly issues: (CreateIssueInput & CreatedIssue)[] = [];
  readonly dispatches: (DispatchWorkflowInput & { ref: string })[] = [];
  readonly checks: FakeCheck[] = [];
  readonly merges: { pr: number; sha: string }[] = [];
  readonly cancelled: number[] = [];
  /** PRs by number; set them up before calling getDiff/merge. */
  readonly prs = new Map<number, FakePr>();
  /** Merge-rules artifacts by head SHA. */
  readonly artifacts = new Map<string, MergeInput>();
  /** Run ids that are still running (cancelRun of any other id returns `not_running`). */
  readonly runningRuns = new Set<number>();
  #failures = new Map<FakeMethod, GitHubApiError>();
  #nextId = 1;

  /** The next call of `method` throws a GitHubApiError with this status. */
  failNext(method: FakeMethod, status = 500): void {
    this.#failures.set(method, new GitHubApiError(method, status));
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
    this.issues.push({ ...input, ...issue });
    return issue;
  }

  async dispatchWorkflow(input: DispatchWorkflowInput): Promise<void> {
    this.#record("dispatchWorkflow", input);
    this.dispatches.push({ ...input, inputs: { ...input.inputs }, ref: input.ref ?? "main" });
  }

  async merge(input: MergePrInput): Promise<MergeResult> {
    this.#record("merge", input);
    const pr = this.prs.get(input.pr);
    if (!pr) throw new GitHubApiError("merge", 404);
    if (pr.headSha !== input.headSha) return { merged: false, reason: "head_changed" };
    if (pr.merged || pr.mergeable === false) return { merged: false, reason: "not_mergeable" };
    pr.merged = true;
    const sha = `squash-${input.pr}-${input.headSha}`;
    this.merges.push({ pr: input.pr, sha });
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
      complete: true,
    };
  }

  async getArtifact(input: GetArtifactInput): Promise<ArtifactResult> {
    this.#record("getArtifact", input);
    const found = this.artifacts.get(input.headSha);
    if (!found) return { found: false, reason: "no_artifact" };
    return { found: true, input: structuredClone(found), runId: 1, artifactId: 1 };
  }
}
