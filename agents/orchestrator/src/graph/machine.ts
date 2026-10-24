// The PR loop of one task (DESIGN §4.2-§4.3) as a state machine over TaskData. `runStep` applies
// one input: it calls GitHub, writes tasks / agent_events / approvals, and returns the new data.
// The LangGraph graph (index.ts) checkpoints the data and interrupts between inputs.
//
// Effects come before the data is checkpointed, so a step that fails half-way (GitHub or DB error)
// is re-run as a whole with the same input when the message is redelivered. Issue creation is
// guarded by tasks.github_issue; a repeated dispatch or event row is the accepted cost.
import type { AgentName, AgentReport, EventType } from "@kcw/core/events";
import { MergeInputFormatError } from "@kcw/core/merge-input";
import { PRIVATE_TITLE, createSanitizer } from "@kcw/core/sanitize";
import { evaluate } from "@kcw/merge-rules";
import { ArtifactFormatError, CI_WORKFLOW, type GitHubClient } from "../github";
import { publicText } from "../nodes/public-title";
import type { TaskRecord, TaskStatus, TaskStore } from "./store";
import {
  DEV_WORKFLOW,
  DOCS_NO_RUN_MINUTES,
  DOCS_WAIT_LIMIT_MINUTES,
  DOCS_WORKFLOW,
  INCOMPLETE_INPUT_TIMEOUT_MINUTES,
  IN_FLIGHT_LIMIT,
  MAX_ATTEMPTS,
  QA_WORKFLOW,
  PlannerOutputError,
  WAIT_LIMIT_MINUTES,
  branchOf,
  docsRunName,
  waitingOnOf,
  type DevMode,
  type GitHubInput,
  type IncompleteReason,
  type Phase,
  type Plan,
  type Planner,
  type RetryTarget,
  type StepOutcome,
  type TaskData,
  type TaskInput,
} from "./types";

export interface TaskGraphDeps {
  github: GitHubClient;
  store: TaskStore;
  planner: Planner;
  /** Extra sanitizer blocklist terms (§4.5). */
  blocklist?: readonly string[];
  now?: () => Date;
  /** One line per notable step; never task text or message content. */
  log?: (line: string) => void;
}

/** CI conclusions that count as a failed run. Others (cancelled, skipped, neutral, stale) are not a verdict. */
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure", "action_required"]);

/** Task statuses that end a task (a parent in phase `children` waits for all of its children to reach one). */
const FINAL_STATUSES = new Set<TaskStatus>(["merged", "done", "failed", "cancelled"]);

const INCOMPLETE_TEXT: Record<IncompleteReason, string> = {
  ci_not_finished: "CI has not finished on the PR head",
  head_moved: "the PR head changed while merge-rules was reading it",
  diff_incomplete: "GitHub listed only part of the changed files",
  no_run: "no ci.yml run was found for the PR head",
  no_artifact: "the ci.yml run has no merge-rules-input artifact",
};

/** Allowance for clock skew between the orchestrator and GitHub when looking up a docs run. */
const DOCS_RUN_CLOCK_SLACK_MS = 2 * 60_000;

const isCiRun = (i: Extract<GitHubInput, { event: "workflow_run" }>) =>
  i.action === "completed" &&
  i.trigger === "pull_request" &&
  i.workflow_path !== null &&
  (i.workflow_path === CI_WORKFLOW || i.workflow_path.endsWith(`/${CI_WORKFLOW}`));

/** Applies one input to the task's data. Returns the new data (the input is not mutated). */
export async function runStep(taskId: number, data: TaskData, input: TaskInput, deps: TaskGraphDeps): Promise<TaskData> {
  const m = new Machine(taskId, structuredClone(data), deps);
  await m.run(input);
  return m.d;
}

class Machine {
  constructor(
    readonly id: number,
    readonly d: TaskData,
    readonly deps: TaskGraphDeps,
  ) {}

  get store(): TaskStore {
    return this.deps.store;
  }
  get github(): GitHubClient {
    return this.deps.github;
  }
  now(): Date {
    return this.deps.now?.() ?? new Date();
  }
  log(line: string): void {
    this.deps.log?.(`task-${this.id}: ${line}`);
  }
  minutesSince(iso: string | null): number {
    return iso === null ? 0 : (this.now().getTime() - Date.parse(iso)) / 60_000;
  }
  /** A docs task (§4.2 step 8): Docs-keeper instead of the planner and the Developer. */
  get isDocs(): boolean {
    return this.d.kind === "docs";
  }
  /** What approving a failed Developer step restarts: a docs task has no Developer. */
  get devRetry(): RetryTarget {
    return this.isDocs ? "docs" : "dev";
  }

  // ------------------------------------------------------------------ entry

  async run(input: TaskInput): Promise<void> {
    const d = this.d;
    d.last_message_id = input.message_id;

    // The docs kind comes only from the orchestrator's own start input (index.ts startDocsTask),
    // captured before the pause check so a start deferred while paused still takes the docs path.
    if (input.kind === "start" && input.docs && d.kind === undefined && d.phase === "queued") {
      d.kind = "docs";
      d.docs_pr = input.docs.pr;
    }

    // Reports only add office events and usage; they never drive the PR loop (GitHub does).
    if (input.kind === "report") {
      d.last_outcome = await this.report(input.report);
      return;
    }

    // §4.3 pause-all: no new dispatches; inputs queue up and are processed on unpause.
    if (await this.store.isPaused()) {
      if (input.kind === "sweep") {
        d.last_outcome = "paused";
      } else {
        d.deferred.push(input);
        d.last_outcome = "deferred";
        this.log(`deferred ${input.kind} (agents paused)`);
      }
      return;
    }

    const queue = [...d.deferred, input];
    d.deferred = [];
    let outcome: StepOutcome = "unchanged";
    for (const next of queue) outcome = await this.apply(next);
    d.last_outcome = outcome;
  }

  async apply(input: TaskInput): Promise<StepOutcome> {
    const d = this.d;
    if (input.kind === "report") return this.report(input.report);
    let out: StepOutcome | undefined;
    switch (d.phase) {
      case "queued":
        if (input.kind === "start" || input.kind === "sweep") out = await this.start();
        break;
      case "dev":
        if (input.kind === "sweep") out = await this.timeout();
        else if (input.kind === "github" && input.event === "pull_request") out = await this.onPrWhileDev(input);
        break;
      case "ci":
        if (input.kind === "sweep") out = await this.timeout();
        else if (input.kind === "github" && input.event === "workflow_run") out = await this.onCiResult(input);
        else if (input.kind === "github" && input.event === "pull_request") out = await this.onPush(input);
        break;
      case "qa":
        if (input.kind === "sweep") out = await this.timeout();
        else if (input.kind === "github" && input.event === "pull_request_review") out = await this.onReview(input);
        else if (input.kind === "github" && input.event === "pull_request") out = await this.onPush(input);
        // §4.2 step 6: CI results while QA works are recorded, not acted on.
        else if (input.kind === "github" && input.event === "workflow_run") out = this.recordCi(input) ? "applied" : undefined;
        break;
      case "merge":
        if (input.kind === "sweep") {
          await this.mergeStep();
          out = "applied";
        } else if (input.kind === "github" && input.event === "workflow_run") {
          if (this.recordCi(input)) {
            await this.mergeStep();
            out = "applied";
          }
        } else if (input.kind === "github" && input.event === "pull_request") out = await this.onPush(input);
        break;
      case "owner":
        if (input.kind === "decision") out = await this.onDecision(input.approval_id, input.decision);
        else if (input.kind === "github" && input.event === "pull_request" && d.owner_wait === "critical") out = await this.onPush(input);
        else if (input.kind === "sweep") out = "unchanged"; // the owner never times out
        break;
      case "children":
        if (input.kind === "sweep") out = await this.childrenDone();
        break;
      case "done":
        break;
    }
    if (out === undefined) {
      // §4.3: stale or unexpected input. Recorded (count + log line); the thread waits on unchanged.
      d.stale += 1;
      this.log(`stale ${input.kind}${input.kind === "github" ? ` ${input.event}.${input.action}` : ""} in phase ${d.phase}`);
      return "stale";
    }
    return out;
  }

  // ------------------------------------------------------------------ bookkeeping

  async event(type: EventType, agent: AgentName, detail: Record<string, unknown> = {}): Promise<void> {
    await this.store.addEvent(this.id, agent, type, detail);
  }

  /** Moves to a phase: writes tasks.status / waiting_on and restarts the wait clock. */
  async enter(phase: Phase, finalStatus?: TaskStatus): Promise<void> {
    const d = this.d;
    d.phase = phase;
    d.waiting_since = this.now().toISOString();
    d.redispatched = false;
    if (phase !== "merge") d.incomplete = null;
    if (phase !== "owner") {
      d.owner_wait = null;
      d.approval_id = null;
      d.retry = null;
    }
    const status: TaskStatus = phase === "done" ? (finalStatus ?? "done") : phase === "queued" ? "queued" : "waiting";
    const agent: AgentName | null =
      phase === "dev" ? (this.isDocs ? "docs" : "developer") : phase === "qa" ? "qa" : phase === "done" ? null : "orchestrator";
    await this.store.updateTask(this.id, { status, waiting_on: waitingOnOf(phase), agent });
  }

  async report(r: AgentReport): Promise<StepOutcome> {
    if (r.usage && r.usage.length > 0) await this.store.addUsage(this.id, r.agent, r.usage);
    // A usage-only report (DESIGN §11 Q14(5)) has no lifecycle meaning: no event, no status change.
    if (r.event_type === undefined) return "unchanged";
    const expected: AgentName | null =
      this.d.phase === "dev" ? (this.isDocs ? "docs" : "developer") : this.d.phase === "qa" ? "qa" : null;
    if (r.agent !== expected) {
      this.d.stale += 1;
      this.log(`stale report from ${r.agent} in phase ${this.d.phase}`);
      return "stale";
    }
    // Bookkeeping only (the docs sweep tells a no-change run from one that never ran); reports
    // still never drive the loop.
    if (this.isDocs && r.event_type === "coding") this.d.docs_started = true;
    await this.event(r.event_type, r.agent, { source: "report" });
    return "applied";
  }

  // ------------------------------------------------------------------ start (§4.2 step 2)

  async start(): Promise<StepOutcome> {
    const task = await this.store.getTask(this.id);
    if (!task || !["queued", "planning"].includes(task.status)) {
      // Unknown, or already finished/cancelled outside the graph: nothing to run.
      this.log(task ? `not started: status ${task.status}` : "not started: no such task");
      this.d.phase = "done";
      return "stale";
    }
    if (!(await this.store.claimSlot(this.id, IN_FLIGHT_LIMIT))) {
      this.log(`queued: ${IN_FLIGHT_LIMIT} tasks in flight`);
      return "queued";
    }

    return this.isDocs ? this.startDocs() : this.plan(task);
  }

  /** §4.2 step 8: a docs task skips the planner, the public-title node and the issue. */
  async startDocs(): Promise<StepOutcome> {
    const pr = this.d.docs_pr;
    if (typeof pr !== "number") return this.finish("failed", "the docs task has no merged PR");
    // Matches the docs PR title (agent-publish pullText); also the squash commit title.
    this.d.issue_title = `docs: update after #${pr}`;
    await this.store.updateTask(this.id, { branch: branchOf(this.id) });
    await this.dispatchDocs();
    return "applied";
  }

  /**
   * §4.2 step 2 after the slot is claimed: the planner node splits a top-level task into subtasks
   * (more than one: child rows, each with its own thread; this task waits for them); the
   * public-title node writes the title and issue of a single (sub)task, which then goes to the
   * Developer. Invalid model output (after the node's one retry) goes to the owner.
   */
  async plan(task: TaskRecord): Promise<StepOutcome> {
    const req = { task_id: this.id, owner_text: task.owner_text, is_private: task.is_private };
    let plan: Plan;
    try {
      // A subtask was planned by its parent: it is never split again.
      const subtasks = task.parent_id === null ? await this.deps.planner.split(req) : [task.owner_text];
      if (subtasks.length > 1) return await this.split(subtasks);
      plan = await this.deps.planner.plan({ ...req, owner_text: subtasks[0] ?? task.owner_text });
    } catch (err) {
      if (!(err instanceof PlannerOutputError)) throw err;
      this.log(`planning failed: ${err.message}`);
      await this.toOwnerFailure(`The ${err.node === "planner" ? "planner" : "public-title"} model returned invalid output twice (${err.reason}).`, "plan");
      return "applied";
    }

    const sanitizer = createSanitizer({
      contacts: await this.store.loadContacts(),
      ...(this.deps.blocklist && { blocklist: this.deps.blocklist }),
    });
    // §4.5: a title that fails is never published; the feed and GitHub show `Private task`.
    const text = publicText(plan, sanitizer);
    await this.store.updateTask(this.id, { public_title: text.publicTitle, branch: branchOf(this.id) });

    if (!text.body.ok) {
      // §4.2 step 2: GitHub issue text that fails the sanitizer goes to the owner first.
      this.d.pending_issue = text.issue;
      await this.toOwner("issue_text", "issue_text", [
        `The issue body fails the sanitizer (${text.body.violations.join(", ")}). Approve to publish it as written; reject to cancel the task.`,
        `Proposed title: ${text.issue.title}`,
        `Proposed body: ${plan.body}`,
      ], `Task ${this.id}: issue text needs review`);
      return "applied";
    }
    await this.publishIssue(text.issue);
    await this.dispatchDev("implement");
    return "applied";
  }

  /** Child rows for the subtasks; the handler starts their threads (index.ts `startSubtasks`). */
  async split(subtasks: string[]): Promise<StepOutcome> {
    this.d.children = await this.store.createSubtasks(this.id, subtasks);
    this.log(`split into ${this.d.children.length} subtasks: ${this.d.children.map((c) => `task-${c}`).join(", ")}`);
    await this.enter("children");
    return "applied";
  }

  /** Phase `children`, on a sweep: the parent ends once every child has (§11 Q12). */
  async childrenDone(): Promise<StepOutcome> {
    const children = await this.store.getChildren(this.id);
    if (children.some((c) => !FINAL_STATUSES.has(c.status))) return "unchanged";
    if (children.every((c) => c.status === "merged" || c.status === "done")) {
      await this.enter("done", "done");
      return "applied";
    }
    return this.finish("failed", "a subtask failed or was cancelled");
  }

  async publishIssue(issue: { title: string; body: string }): Promise<void> {
    // A retried step must not open a second issue: the number is stored as soon as it exists.
    let number = (await this.store.getTask(this.id))?.github_issue ?? null;
    if (number === null) {
      const footer = `\n\n---\nTask ${this.id}. Branch: \`${branchOf(this.id)}\`.`;
      number = (await this.github.createIssue({ title: issue.title, body: issue.body + footer })).number;
      await this.store.updateTask(this.id, { github_issue: number });
    }
    this.d.issue_number = number;
    this.d.issue_title = issue.title;
    this.d.pending_issue = null;
  }

  // ------------------------------------------------------------------ dispatches

  async dispatchDev(mode: DevMode, reason?: string): Promise<void> {
    const d = this.d;
    await this.github.dispatchWorkflow({
      workflow: DEV_WORKFLOW,
      inputs: {
        task_id: String(this.id),
        issue: d.issue_number === null ? "" : String(d.issue_number),
        mode,
        pr: d.pr_number === null ? "" : String(d.pr_number),
      },
    });
    d.dev_mode = mode;
    await this.event("task_assigned", "developer", { mode, attempts: d.attempts, ...(reason && { reason }) });
    await this.enter("dev");
  }

  async dispatchDocs(reason?: string): Promise<void> {
    const d = this.d;
    await this.github.dispatchWorkflow({
      workflow: DOCS_WORKFLOW,
      inputs: { task_id: String(this.id), pr: String(d.docs_pr) },
    });
    d.docs_started = false; // this run's start report sets it
    await this.event("task_assigned", "docs", { pr: d.docs_pr, attempts: d.attempts, ...(reason && { reason }) });
    await this.enter("dev");
  }

  async dispatchQa(reason?: string): Promise<void> {
    await this.github.dispatchWorkflow({
      workflow: QA_WORKFLOW,
      inputs: { task_id: String(this.id), pr: String(this.d.pr_number) },
    });
    await this.event("qa_reviewing", "qa", { pr: this.d.pr_number, ...(reason && { reason }) });
    await this.enter("qa");
  }

  // ------------------------------------------------------------------ Developer and CI (steps 3-5)

  async onPrWhileDev(i: Extract<GitHubInput, { event: "pull_request" }>): Promise<StepOutcome | undefined> {
    const d = this.d;
    if (!["opened", "reopened", "synchronize", "ready_for_review"].includes(i.action) || i.head_sha === null) return undefined;
    if (d.pr_number === null) {
      // The Developer's first PR: it must come from the task's branch.
      if (i.head_ref !== branchOf(this.id) || !["opened", "reopened"].includes(i.action)) return undefined;
      d.pr_number = i.pr_number;
      d.head_sha = i.head_sha;
      d.ci = null;
      await this.store.updateTask(this.id, { pr_number: i.pr_number, head_sha: i.head_sha });
      await this.event("pr_opened", this.isDocs ? "docs" : "developer", { pr: i.pr_number });
    } else {
      // A fix: new commits on the same PR.
      if (i.pr_number !== d.pr_number || i.head_sha === d.head_sha) return undefined;
      d.head_sha = i.head_sha;
      d.ci = null;
      await this.store.updateTask(this.id, { head_sha: i.head_sha });
    }
    await this.event("ci_running", "orchestrator", { pr: d.pr_number, head_sha: d.head_sha });
    await this.enter("ci");
    return "applied";
  }

  /** New commits on the PR while CI, QA, the merge step or a critical approval waits. */
  async onPush(i: Extract<GitHubInput, { event: "pull_request" }>): Promise<StepOutcome | undefined> {
    const d = this.d;
    if (i.action !== "synchronize" || i.pr_number !== d.pr_number || i.head_sha === null || i.head_sha === d.head_sha) {
      return undefined;
    }
    d.head_sha = i.head_sha;
    d.ci = null;
    await this.store.updateTask(this.id, { head_sha: i.head_sha });
    await this.event("ci_running", "orchestrator", { pr: d.pr_number, head_sha: d.head_sha });
    if (d.phase === "owner" && d.approval_id !== null) {
      // The owner was asked about another head: that approval no longer applies.
      await this.store.supersedeApproval(d.approval_id, "Superseded: the PR head changed; merge-rules runs again.");
    }
    // Every new head needs CI and independent QA again, including tests published by QA.
    // The publishing QA run defers its review when it adds commits; CI green dispatches a
    // fresh QA run. New code also supersedes an earlier approval (the ruleset dismisses it).
    await this.enter("ci");
    return "applied";
  }

  /** Records a ci.yml result for the current head. False if the run is not one. */
  recordCi(i: Extract<GitHubInput, { event: "workflow_run" }>): boolean {
    if (!isCiRun(i) || i.head_sha !== this.d.head_sha || i.head_sha === null) return false;
    if (i.conclusion === "success") this.d.ci = { sha: i.head_sha, result: "success" };
    else if (i.conclusion !== null && FAILED_CONCLUSIONS.has(i.conclusion)) this.d.ci = { sha: i.head_sha, result: "failure" };
    else return false;
    return true;
  }

  async onCiResult(i: Extract<GitHubInput, { event: "workflow_run" }>): Promise<StepOutcome | undefined> {
    if (!this.recordCi(i)) return undefined;
    if (this.d.ci?.result === "success") {
      await this.event("ci_passed", "orchestrator", { pr: this.d.pr_number, head_sha: this.d.head_sha });
      await this.dispatchQa();
    } else {
      await this.event("tests_failed", "orchestrator", { pr: this.d.pr_number, head_sha: this.d.head_sha });
      await this.failedAttempt("CI failed");
    }
    return "applied";
  }

  /** A CI failure or a QA change request: back to the Developer, or to the owner after MAX_ATTEMPTS. */
  async failedAttempt(what: string): Promise<void> {
    const d = this.d;
    d.attempts += 1;
    await this.store.updateTask(this.id, { attempts: d.attempts });
    if (this.isDocs) {
      // No Developer fixes a docs PR: the owner decides (approve re-dispatches Docs-keeper).
      await this.toOwnerFailure(`${what} on the docs PR.`, "docs");
      return;
    }
    if (d.attempts < MAX_ATTEMPTS) {
      await this.dispatchDev("fix");
      return;
    }
    await this.toOwnerFailure(`${what}; ${d.attempts} failed attempts.`, "dev");
  }

  // ------------------------------------------------------------------ QA (step 6)

  async onReview(i: Extract<GitHubInput, { event: "pull_request_review" }>): Promise<StepOutcome | undefined> {
    const d = this.d;
    if (i.action !== "submitted" || i.pr_number !== d.pr_number || i.commit_id === null || i.commit_id !== d.head_sha) {
      return undefined;
    }
    if (i.review_state === "approved") {
      await this.event("approved", "qa", { pr: d.pr_number, head_sha: d.head_sha });
      await this.mergeStep();
      return "applied";
    }
    if (i.review_state === "changes_requested") {
      await this.event("changes_requested", "qa", { pr: d.pr_number, head_sha: d.head_sha });
      await this.failedAttempt("QA requested changes");
      return "applied";
    }
    return undefined; // a comment-only review
  }

  // ------------------------------------------------------------------ merge-rules and merge (step 7)

  /** Evaluates merge-rules on the current head once every input is complete (Q11), then merges or asks the owner. */
  async mergeStep(): Promise<void> {
    const d = this.d;
    const sha = d.head_sha!;
    const pr = d.pr_number!;
    if (d.ci?.sha !== sha) return this.incomplete("ci_not_finished");
    if (d.ci.result === "failure") {
      await this.event("tests_failed", "orchestrator", { pr, head_sha: sha });
      return this.failedAttempt("CI failed");
    }
    const diff = await this.github.getDiff(pr);
    if (diff.headSha !== sha) return this.incomplete("head_moved");
    if (!diff.complete) return this.incomplete("diff_incomplete");

    let artifact;
    try {
      artifact = await this.github.getArtifact({ pr, headSha: sha });
    } catch (err) {
      // A malformed artifact is not "still coming": it fails closed at once.
      if (err instanceof ArtifactFormatError || err instanceof MergeInputFormatError) {
        return this.critical([`The merge-rules input artifact is malformed (${err.name}); merge-rules could not run.`]);
      }
      throw err;
    }
    if (!artifact.found) return this.incomplete(artifact.reason);

    const result = evaluate({
      files: diff.files,
      patches: diff.patches,
      planSummary: artifact.input.planSummary,
      lockDiff: artifact.input.lockDiff,
      author: diff.author,
    });
    if (result.critical) return this.critical(result.reasons);
    await this.merge("No critical changes", "merge-rules found no critical change.");
  }

  /** Q11: wait for the missing input (next CI event or sweep); after the timeout, the PR is critical. */
  async incomplete(reason: IncompleteReason): Promise<void> {
    const d = this.d;
    if (d.phase !== "merge" || d.incomplete === null) {
      await this.event("ci_running", "orchestrator", { pr: d.pr_number, head_sha: d.head_sha, waiting_for: reason });
      await this.enter("merge");
      d.incomplete = { since: this.now().toISOString(), reason };
    } else {
      d.incomplete.reason = reason;
    }
    if (this.minutesSince(d.incomplete.since) >= INCOMPLETE_INPUT_TIMEOUT_MINUTES) {
      await this.critical([
        `merge-rules input still incomplete after ${INCOMPLETE_INPUT_TIMEOUT_MINUTES} minutes: ${INCOMPLETE_TEXT[reason]}. Missing data is never treated as non-critical.`,
      ]);
    } else {
      this.log(`merge step waiting: ${reason}`);
    }
  }

  async critical(reasons: string[]): Promise<void> {
    const d = this.d;
    // The check stays pending, so the ruleset blocks the merge until the owner decides (§4.2 step 7).
    await this.github.postCheck({
      headSha: d.head_sha!,
      state: "pending",
      title: "Owner approval required",
      summary: reasons.map((r) => `- ${r}`).join("\n"),
    });
    await this.toOwner("critical", "critical_pr", reasons, `PR #${d.pr_number} needs approval: critical change`);
  }

  async merge(checkTitle: string, checkSummary: string): Promise<void> {
    const d = this.d;
    const pr = d.pr_number!;
    const headSha = d.head_sha!;
    await this.github.postCheck({ headSha, state: "success", title: checkTitle, summary: checkSummary });
    const res = await this.github.merge({ pr, headSha, title: `${d.issue_title ?? PRIVATE_TITLE} (#${pr})` });
    if (res.merged) {
      await this.event("merged", "orchestrator", { pr, sha: res.sha });
      // §4.2 step 8: Docs-keeper follows every merged work PR, never a docs PR (no loop).
      if (!this.isDocs) await this.createDocsTask(pr);
      await this.enter("done", "merged");
      return;
    }
    if (res.reason === "head_changed") return this.incomplete("head_moved"); // the push event moves it back to CI
    await this.toOwnerFailure("GitHub refused the merge (conflicts or a required check).", this.devRetry);
  }

  /** The docs child of this merged task (idempotent); the handler starts its thread (index.ts `startDocsTask`). */
  async createDocsTask(pr: number): Promise<void> {
    const sanitizer = createSanitizer({
      contacts: await this.store.loadContacts(),
      ...(this.deps.blocklist && { blocklist: this.deps.blocklist }),
    });
    const title = `Docs update after #${pr}`;
    this.d.docs_task = await this.store.createDocsTask(this.id, pr, sanitizer.check(title).ok ? title : null);
    this.log(`docs task task-${this.d.docs_task}`);
  }

  // ------------------------------------------------------------------ owner (§4.3 owner decisions)

  async toOwner(
    wait: "issue_text" | "critical" | "failure",
    kind: "issue_text" | "critical_pr",
    reasons: string[],
    inboxTitle: string,
  ): Promise<void> {
    const id = await this.store.createApproval({ taskId: this.id, kind, reasons, inboxTitle });
    await this.event("waiting_on_owner", "orchestrator", { approval_id: id, kind, pr: this.d.pr_number });
    await this.enter("owner");
    this.d.owner_wait = wait;
    this.d.approval_id = id;
  }

  /**
   * Attempts exhausted, a timeout after one redispatch, or a refused merge. The schema has no
   * "failed" approval kind, so this is a `critical_pr` approval whose reasons say what approving does.
   */
  async toOwnerFailure(what: string, retry: RetryTarget): Promise<void> {
    const again =
      retry === "qa"
        ? "dispatch QA again"
        : retry === "plan"
          ? "plan the task again"
          : retry === "docs"
            ? "dispatch Docs-keeper again"
            : `give the Developer ${MAX_ATTEMPTS} more attempts`;
    await this.toOwner("failure", "critical_pr", [`Task failed: ${what}`, `Approve to ${again}; reject to mark the task failed.`], `Task ${this.id} failed: needs a decision`);
    this.d.retry = retry;
  }

  async onDecision(approvalId: string, decision: "approved" | "rejected"): Promise<StepOutcome | undefined> {
    const d = this.d;
    if (approvalId !== d.approval_id) return undefined;
    // The message must agree with the recorded decision (the console writes it before sending).
    const a = await this.store.getApproval(approvalId);
    if (!a || a.task_id !== this.id || a.status !== decision) return undefined;
    const wait = d.owner_wait;
    const pr = d.pr_number;

    if (wait === "issue_text") {
      if (decision === "rejected") return this.finish("cancelled", "issue text rejected by the owner");
      await this.publishIssue(d.pending_issue!);
      await this.dispatchDev("implement");
      return "applied";
    }
    if (wait === "critical") {
      if (decision === "rejected") {
        await this.github.postCheck({
          headSha: d.head_sha!,
          state: "failure",
          title: "Rejected by the owner",
          summary: "The owner rejected this change.",
        });
        return this.finish("cancelled", "critical PR rejected by the owner");
      }
      await this.event("approved", "orchestrator", { pr, approval_id: approvalId, by: "owner" });
      await this.merge("Approved by the owner", "The owner approved this change.");
      return "applied";
    }
    // failure
    if (decision === "rejected") return this.finish("failed", "the owner gave up after the failure");
    if (d.retry === "plan") {
      const task = await this.store.getTask(this.id);
      if (!task) return this.finish("failed", "the task row is gone");
      return this.plan(task);
    }
    if (d.retry === "qa") {
      await this.dispatchQa("owner retry");
    } else if (d.retry === "docs") {
      d.attempts = 0;
      await this.store.updateTask(this.id, { attempts: 0 });
      await this.dispatchDocs("owner retry");
    } else {
      d.attempts = 0;
      await this.store.updateTask(this.id, { attempts: 0 });
      await this.dispatchDev(pr === null ? "implement" : "fix", "owner retry");
    }
    return "applied";
  }

  async finish(status: "failed" | "cancelled", reason: string): Promise<StepOutcome> {
    await this.event("failed", "orchestrator", { reason, pr: this.d.pr_number });
    await this.enter("done", status);
    return "applied";
  }

  // ------------------------------------------------------------------ timeouts (§4.3 sweeper)

  async timeout(): Promise<StepOutcome> {
    const d = this.d;
    const phase = d.phase as "dev" | "ci" | "qa";
    if (phase === "dev" && this.isDocs) return this.docsSweep();
    const limit = WAIT_LIMIT_MINUTES[phase];
    if (this.minutesSince(d.waiting_since) < limit) return "unchanged";
    const reason = `timeout after ${limit} min`;
    if (phase === "ci") {
      // CI is not an agent workflow: there is nothing to redispatch.
      await this.toOwnerFailure(`CI did not finish within ${limit} minutes.`, this.devRetry);
    } else if (!d.redispatched) {
      // Redispatch once (§4.3).
      if (phase === "dev") await this.dispatchDev(d.dev_mode, reason);
      else await this.dispatchQa(reason);
      d.redispatched = true;
    } else {
      await this.toOwnerFailure(
        `${phase === "dev" ? "The Developer" : "QA"} did not finish within ${limit} minutes, twice.`,
        phase === "dev" ? "dev" : "qa",
      );
    }
    return "applied";
  }

  /**
   * A docs task waiting on Docs-keeper (phase `dev`). A run that changes nothing opens no PR, so
   * the sweep reads the run's state, found by its run-name (the dispatch API returns no run id).
   */
  async docsSweep(): Promise<StepOutcome> {
    const d = this.d;
    const waited = this.minutesSince(d.waiting_since);
    const since = Date.parse(d.waiting_since ?? this.now().toISOString()) - DOCS_RUN_CLOCK_SLACK_MS;
    const run = await this.github.findWorkflowRun({
      workflow: DOCS_WORKFLOW,
      displayTitle: docsRunName(this.id),
      createdAfter: new Date(since).toISOString(),
    });
    if (run === null) {
      if (waited < DOCS_NO_RUN_MINUTES) return "unchanged";
      return this.redispatchDocsOnce(`no ${DOCS_WORKFLOW} run started within ${DOCS_NO_RUN_MINUTES} minutes`);
    }
    if (run.status !== "completed") {
      if (waited < DOCS_WAIT_LIMIT_MINUTES) return "unchanged";
      await this.toOwnerFailure(`Docs-keeper did not finish within ${DOCS_WAIT_LIMIT_MINUTES} minutes.`, "docs");
      return "applied";
    }
    if (run.conclusion === "success" || run.conclusion === "skipped") {
      // No start report: every job was skipped (KCW_AGENT_WORKFLOWS_ENABLED not true). No inbox item.
      if (!d.docs_started) return this.finish("failed", "Docs-keeper did not run (agent workflows disabled or every job skipped)");
      if (d.pr_number === null) {
        this.log("no docs change");
        await this.enter("done", "done");
        return "applied";
      }
      await this.toOwnerFailure(`Docs-keeper finished without new commits on PR #${d.pr_number}.`, "docs");
      return "applied";
    }
    // The sweeper cancels agent runs on pause-all.
    if (run.conclusion === "cancelled") return this.redispatchDocsOnce(`the ${DOCS_WORKFLOW} run was cancelled`);
    await this.toOwnerFailure(`the ${DOCS_WORKFLOW} run ended ${run.conclusion ?? "without a conclusion"}.`, "docs");
    return "applied";
  }

  async redispatchDocsOnce(reason: string): Promise<StepOutcome> {
    if (this.d.redispatched) {
      await this.toOwnerFailure(`${reason}, after one redispatch.`, "docs");
      return "applied";
    }
    await this.dispatchDocs(reason);
    this.d.redispatched = true;
    return "applied";
  }
}
