// The PR loop of one task (DESIGN §4.2-§4.3) as a state machine over TaskData. `runStep` applies
// one input: it calls GitHub, writes tasks / agent_events / approvals, and returns the new data.
// The LangGraph graph (index.ts) checkpoints the data and interrupts between inputs.
//
// Effects come before the data is checkpointed, so a step that fails half-way (GitHub or DB error)
// is re-run as a whole with the same input when the message is redelivered. The planner result, the
// issue, a dispatch and a merge each have an operation record (github_operations, DESIGN §4.0): the
// intent is written before the effect and the result after it, under a key computed from the
// checkpointed data, so the re-run reads the record or asks GitHub instead of repeating the effect.
// Events and approvals carry an effect key (task, input, effect and its count in the step; AR2 slice 3),
// so a re-run step writes neither twice. A report is applied in one transaction with its receipt.
import { ContractError, canonicalContract, contractHash, parseContract, type ContractPrerequisite, type TaskContract } from "@kcw/core/contract";
import { reportKey, threadIdOf, usageKey, type AgentName, type AgentReport, type EventType } from "@kcw/core/events";
import { MergeInputFormatError } from "@kcw/core/merge-input";
import { PRIVATE_TITLE, createSanitizer } from "@kcw/core/sanitize";
import { evaluate } from "@kcw/merge-rules";
import { ArtifactFormatError, CI_WORKFLOW, GitHubApiError, type GitHubClient, type MergeResult } from "../github";
import { contractViolations } from "../nodes/planner";
import { publicText } from "../nodes/public-title";
import { REPO_BRIEF_PATH, repoBrief } from "../nodes/repo-brief";
import { OperationConflictError, agentRunName, effectKey, issueMarker, requestHash, type OperationKind } from "./operations";
import { DispatchLinkConflictError, type ChildTask, type OperationRecord, type TaskRecord, type TaskStatus, type TaskStore } from "./store";
import {
  DEV_WORKFLOW,
  DISPATCH_UNKNOWN_MINUTES,
  DOCS_NO_RUN_MINUTES,
  DOCS_WAIT_LIMIT_MINUTES,
  DOCS_WORKFLOW,
  INCOMPLETE_INPUT_TIMEOUT_MINUTES,
  ACTIVE_EXECUTION_LIMIT,
  IN_FLIGHT_LIMIT,
  MAX_ATTEMPTS,
  QA_WORKFLOW,
  PlannerInputError,
  PlannerOutputError,
  WAIT_LIMIT_MINUTES,
  agentRoleOfWorkflow,
  branchOf,
  orderSubtasks,
  waitingOnOf,
  type DevMode,
  type GitHubInput,
  type IncompleteReason,
  type OwnerWait,
  type PendingContract,
  type PendingDispatch,
  type Phase,
  type Plan,
  type Planner,
  type RetryTarget,
  type StepOutcome,
  type TaskData,
  type TaskInput,
} from "./types";
import { evidenceValid, latestQaAttempt, type EvidenceRow } from "./validity";

export interface TaskGraphDeps {
  github: GitHubClient;
  store: TaskStore;
  planner: Planner;
  /** Extra sanitizer blocklist terms (§4.5). */
  blocklist?: readonly string[];
  now?: () => Date;
  /** AR6: active worker reservations; default ACTIVE_EXECUTION_LIMIT. Tests of other limits raise it. */
  activeExecutionLimit?: number;
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
  trusted_run_pending: "the trusted preview run for the PR head has not finished",
  trusted_run_failed: "the trusted preview run for the PR head did not pass",
  no_artifact: "the trusted preview run has no merge-rules-input artifact",
};

/** What approving an exhausted task does (AR5b): the owner-facing text of the replan route. */
const REPLAN_TEXT =
  "Approve to replan the task (new contract revision; the PR is kept, CI is reused for an unchanged head, QA reviews again); reject to mark it failed.";

/** How many applied report identities a thread remembers (a task has a few reports per run). */
const APPLIED_REPORTS_KEPT = 200;

/** Allowance for clock skew between the orchestrator and GitHub when looking up a run or an issue. */
const CLOCK_SLACK_MS = 2 * 60_000;

/** `RetryTarget` of a pending dispatch's role (what approving a failed dispatch restarts). */
const RETRY_OF_ROLE = { dev: "dev", qa: "qa", docs: "docs" } as const satisfies Record<PendingDispatch["role"], RetryTarget>;

const isCiRun = (i: Extract<GitHubInput, { event: "workflow_run" }>) =>
  i.action === "completed" &&
  i.trigger === "pull_request" &&
  i.workflow_path !== null &&
  (i.workflow_path === CI_WORKFLOW || i.workflow_path.endsWith(`/${CI_WORKFLOW}`));

/** The relay sets agent_task_id only after validating signed, same-repo dispatch/run-name identity. */
export function agentRunRole(input: TaskInput, taskId: number): "developer" | "qa" | "docs" | "scraper" | null {
  if (input.kind !== "github" || input.event !== "workflow_run" || input.agent_task_id !== taskId ||
      input.head_branch !== "main" || input.trigger !== "workflow_dispatch" ||
      !["requested", "completed"].includes(input.action) || !Number.isSafeInteger(input.run_attempt) ||
      (input.run_attempt ?? 0) < 1 || (input.run_attempt ?? 0) > 2147483647) return null;
  return /^\.github\/workflows\/agent-(developer|qa|docs|scraper)\.yml$/.exec(input.workflow_path ?? "")?.[1] as "developer" | "qa" | "docs" | "scraper" | undefined ?? null;
}

/** Applies one input to the task's data. Returns the new data (the input is not mutated). */
export async function runStep(taskId: number, data: TaskData, input: TaskInput, deps: TaskGraphDeps): Promise<TaskData> {
  const m = new Machine(taskId, structuredClone(data), deps);
  await m.run(input);
  return m.d;
}

class Machine {
  /** The identity of the input being applied, and the effects counted for it (effect keys). */
  private inputId = "";
  private seq = new Map<string, number>();

  constructor(
    readonly id: number,
    readonly d: TaskData,
    readonly deps: TaskGraphDeps,
  ) {}

  /**
   * Starts counting the effects of one input. Its identity is the logical message key when the
   * message has one (stable when the outbox resends it under a new SQS id), else the SQS message id.
   */
  applying(input: TaskInput): void {
    this.inputId = input.message_key ?? input.message_id;
    this.seq = new Map();
  }

  /**
   * The effect key of the next event or approval of this kind for the input being applied:
   * `task-<id>/<message key or id>/<what>/<n>`. A step that is re-run with the same input computes the same keys.
   */
  nextEffectKey(what: string): string {
    const n = this.seq.get(what) ?? 0;
    this.seq.set(what, n + 1);
    return `${threadIdOf(this.id)}/${this.inputId}/${what}/${n}`;
  }

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

  /** AR5b: the current contract revision; null for a docs task (no contract, no revision). */
  get revision(): number | null {
    return this.isDocs ? null : (this.d.contract?.revision ?? this.d.revision ?? 1);
  }
  /** AR5b: whether "plan" means a replan (a new contract revision): a work task with its issue and contract. */
  get canReplan(): boolean {
    return !this.isDocs && this.d.issue_number !== null && this.d.contract !== undefined;
  }
  /** AR5b: the hash of the current contract (null for a docs task or one without a contract). */
  get currentHash(): string | null {
    return this.isDocs || this.d.contract === undefined ? null : contractHash(this.d.contract);
  }

  /**
   * AR5b: CI evidence for the head `d.ci` names. Its key does not depend on the revision (CI judges
   * code, so a replan reuses it); the revision column is the one current when it was recorded.
   */
  async writeCi(): Promise<void> {
    const ci = this.d.ci;
    if (ci === null) return;
    await this.store.recordEvidence({
      effectKey: `${threadIdOf(this.id)}/evidence/ci/${ci.sha}/0/ci:${ci.result}`,
      taskId: this.id,
      revision: this.revision,
      kind: "ci",
      headSha: ci.sha,
      outcome: ci.result,
      attemptKey: null,
      createdAt: this.now().toISOString(),
    });
  }

  /** AR5b: the previous dispatch of this role ended without a report (a timeout): its attempt is `lost`. */
  async markLost(role: "developer" | "qa" | "docs"): Promise<void> {
    const op = this.d.dispatch_ops?.[role];
    if (op !== undefined) await this.store.updateAttempt(effectKey(this.id, "dispatch", op), { endedAt: this.now().toISOString(), outcome: "lost" });
  }

  // ------------------------------------------------------------------ entry

  async run(input: TaskInput): Promise<void> {
    const d = this.d;
    d.last_message_id = input.message_id;
    this.applying(input);

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

    const role = agentRunRole(input, this.id);
    if (role && input.kind === "github" && input.event === "workflow_run") {
      await this.store.recordRun({ runId: input.run_id, attempt: input.run_attempt!, taskId: this.id,
        role, action: input.action as "requested" | "completed",
        timestamp: input.action === "completed" ? input.updated_at ?? null : input.run_started_at ?? null,
        conclusion: input.conclusion });
      d.last_outcome = "unchanged";
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
    for (const next of queue) {
      this.applying(next);
      outcome = await this.apply(next);
    }
    // A dispatch still waiting for its run is not progress: a sweep checks it again.
    d.last_outcome = d.pending_capacity != null ? "queued" : outcome === "applied" && d.pending_dispatch != null ? "unchanged" : outcome;
  }

  async apply(input: TaskInput): Promise<StepOutcome> {
    const d = this.d;
    if (input.kind === "report") return this.report(input.report);
    // The task's PR merged or closed outside the orchestrator (the owner merge script, by hand):
    // the task ends in any phase, so it never waits forever.
    if (input.kind === "github" && input.event === "pull_request" && input.action === "closed" &&
        d.phase !== "done" && d.pr_number !== null && input.pr_number === d.pr_number) {
      return this.onPrClosed(input.merged);
    }
    // A dispatch whose run is not visible yet (see dispatchAgent): only a sweep resumes it, and an
    // owner decision cannot apply to a step that has not finished.
    if (d.pending_capacity != null && input.kind === "sweep") return this.resumeDispatch(d.pending_capacity);
    if (d.pending_dispatch != null && input.kind === "sweep") return this.resumeDispatch(d.pending_dispatch);
    let out: StepOutcome | undefined;
    if ((d.pending_dispatch != null || d.pending_capacity != null) && input.kind === "decision") out = undefined;
    else switch (d.phase) {
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
        else if (input.kind === "github" && input.event === "workflow_run") out = (await this.recordCiEvidence(input)) ? "applied" : undefined;
        break;
      case "merge":
        if (input.kind === "sweep") {
          await this.mergeStep();
          out = "applied";
        } else if (input.kind === "github" && input.event === "workflow_run") {
          if (await this.recordCiEvidence(input)) {
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

  /** The effect key of this task's current operation of that kind (graph/operations.ts). */
  opKey(kind: OperationKind): string {
    return effectKey(this.id, kind, this.d.ops?.[kind] ?? 0);
  }

  /** The current operation of that kind is finished or abandoned: the next one gets a new key. */
  bumpOp(kind: OperationKind): void {
    this.d.ops = { ...this.d.ops, [kind]: (this.d.ops?.[kind] ?? 0) + 1 };
  }

  /**
   * Writes the intent of the current operation of that kind, or finds the record that is already
   * there (a step that is re-run). The same key with another request is a contradiction: nothing is
   * sent, the key is abandoned and the task goes to the owner (null).
   */
  async beginOp(kind: OperationKind, request: unknown, retry: RetryTarget): Promise<{ key: string; record: OperationRecord; created: boolean } | null> {
    const key = this.opKey(kind);
    try {
      const begun = await this.store.beginOperation({
        effectKey: key,
        taskId: this.id,
        kind,
        requestHash: requestHash(request),
        createdAt: this.now().toISOString(),
      });
      return { key, ...begun };
    } catch (err) {
      if (!(err instanceof OperationConflictError)) throw err;
      this.log(`operation_conflict kind=${kind}`);
      this.d.pending_dispatch = null;
      this.bumpOp(kind);
      if (kind === "plan") this.bumpOp("issue"); // a new plan means a new issue operation
      await this.toOwnerFailure(`A ${kind} request contradicts the one already recorded under ${key}; nothing was sent.`, retry);
      return null;
    }
  }

  async event(type: EventType, agent: AgentName, detail: Record<string, unknown> = {}): Promise<void> {
    await this.store.addEvent(this.id, agent, type, detail, this.nextEffectKey(`event/${type}`));
  }

  /**
   * Moves to a phase: writes tasks.status / waiting_on and restarts the wait clock. A merged task
   * also releases the sibling subtasks that waited for it (AR4, store.mergeTask), in the same write.
   */
  async enter(phase: Phase, finalStatus?: TaskStatus, mergeSha?: string | null): Promise<void> {
    const d = this.d;
    // Leaving the wait for a dispatch's run abandons it; its next dispatch is a new operation.
    if (d.pending_dispatch != null) {
      d.pending_dispatch = null;
      this.bumpOp("dispatch");
    }
    // Leaving the wait for an execution reservation (a PR closed, a replan): the refusal no longer stands.
    const wasWaitingForCapacity = d.pending_capacity != null;
    d.pending_capacity = null;
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
    if (status === "merged") {
      // A reconciled merge whose commit GitHub did not return records "unknown" (merge()): no merge_sha.
      const released = await this.store.mergeTask(this.id, mergeSha != null && mergeSha !== "unknown" ? mergeSha : null);
      if (released.length > 0) this.log(`released ${released.map((c) => `task-${c}`).join(", ")}`);
      return;
    }
    await this.store.updateTask(this.id, { status, waiting_on: waitingOnOf(phase), agent, ...(wasWaitingForCapacity && { execution_wait: null }) });
  }

  /**
   * AR2 slice 3: a report is applied once, all or nothing. Its receipt (key = the report identity),
   * every usage line (dedupe key = the call identity) and its event are written in one transaction;
   * a report whose receipt exists writes nothing, and one already in `applied_reports` changes
   * nothing at all (`duplicate`). Usage is always recorded, also after
   * the task ended; the event only when the report is the expected agent's in the current phase and
   * its run is not superseded: a report whose op is lower than the agent's latest dispatch comes from
   * an obsolete run and has no lifecycle effect. Reports never cause transitions or approvals.
   */
  async report(r: AgentReport): Promise<StepOutcome> {
    const key = reportKey(r);
    // Applied and checkpointed before: a no-op (no state change, no write).
    if (this.d.applied_reports?.includes(key)) {
      this.log(`report_duplicate job=${r.job}`);
      return "duplicate";
    }
    // From here the step's state updates always apply, also when the database write below finds the
    // receipt (a crash after the report transaction and before the checkpoint): the checkpoint then
    // reaches the state the first run would have left, and nothing is written twice.
    this.d.applied_reports = [...(this.d.applied_reports ?? []), key].slice(-APPLIED_REPORTS_KEPT);
    let outcome: StepOutcome = "unchanged";
    let event: EventType | null = null;
    // A usage-only report (DESIGN §11 Q14(5)) has no lifecycle meaning: no event, no status change.
    if (r.event_type !== undefined) {
      const current = r.agent === "developer" || r.agent === "qa" || r.agent === "docs" ? this.d.dispatch_ops?.[r.agent] : undefined;
      const expected: AgentName | null =
        this.d.phase === "dev" ? (this.isDocs ? "docs" : "developer") : this.d.phase === "qa" ? "qa" : null;
      const hash = this.currentHash;
      if (r.op !== null && current !== undefined && r.op < current) {
        this.d.stale += 1;
        this.log(`report_fenced agent=${r.agent} op=${r.op} current=${current}`);
        outcome = "stale";
      } else if (r.contract !== undefined && hash !== null && r.contract !== hash) {
        // AR5b: a run of an earlier revision (after a replan) has no lifecycle effect.
        this.d.stale += 1;
        this.log(`report_obsolete_contract agent=${r.agent} op=${r.op}`);
        outcome = "stale";
      } else if (r.agent !== expected) {
        this.d.stale += 1;
        this.log(`stale report from ${r.agent} in phase ${this.d.phase}`);
        outcome = "stale";
      } else {
        // Bookkeeping only (the docs sweep tells a no-change run from one that never ran); reports
        // still never drive the loop.
        if (this.isDocs && r.event_type === "coding") this.d.docs_started = true;
        event = r.event_type;
        outcome = "applied";
      }
    }
    const written = await this.store.recordReport({
      receiptKey: key,
      taskId: this.id,
      agent: r.agent,
      usage: (r.usage ?? []).map(({ call, ...u }) => ({ ...u, dedupeKey: usageKey(r, call) })),
      event: event === null ? null : { type: event, detail: { source: "report" }, effectKey: `${key}/event` },
    });
    if (!written) this.log(`report_recorded_before job=${r.job}`);
    // AR5b: the attempt of the report's dispatch key (a report with no row, from before this slice,
    // changes nothing). The start counts only when its contract is the attempt's (the store guards it).
    if (r.op !== null && (r.agent === "developer" || r.agent === "qa" || r.agent === "docs")) {
      const at = this.now().toISOString();
      const key = effectKey(this.id, "dispatch", r.op);
      if (r.job === "start") await this.store.updateAttempt(key, { startedAt: at, startContract: r.contract ?? null });
      else await this.store.updateAttempt(key, { endedAt: at, outcome: r.event_type === "failed" ? "failed" : "succeeded" });
    }
    return outcome;
  }

  // ------------------------------------------------------------------ start (§4.2 step 2)

  async start(): Promise<StepOutcome> {
    const task = await this.store.getTask(this.id);
    if (!task || !["queued", "planning", "waiting"].includes(task.status)) {
      // Unknown, or already finished/cancelled outside the graph: nothing to run. `waiting`: a re-run start step
      // whose execution reservation (AR6) was already claimed. The status is no running-worker guard: start()
      // runs only in phase `queued`, which the checkpoint leaves once the start step completes.
      this.log(task ? `not started: status ${task.status}` : "not started: no such task");
      this.d.phase = "done";
      return "stale";
    }
    // AR4: a subtask starts only after each prerequisite merged (its start message is sent then; this
    // also holds for any other start or sweep of its thread).
    if (task.parent_id !== null && task.prerequisites.length > 0) {
      const merged = new Set((await this.store.getChildren(task.parent_id)).filter((c) => c.status === "merged").map((c) => c.id));
      const waiting = task.prerequisites.filter((p) => !merged.has(p));
      if (waiting.length > 0) {
        this.log(`not started: waiting for ${waiting.map((p) => `task-${p}`).join(", ")}`);
        return "queued";
      }
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
    // The planner's answers are recorded before any external effect (private text, database only),
    // so a re-run of this step reuses them instead of calling the model again.
    const begun = await this.beginOp("plan", { owner_text: task.owner_text, is_private: task.is_private, subtask: task.parent_id !== null }, "plan");
    if (begun === null) return "applied";
    // after: each subtask's prerequisites (indices); records written before AR4 have none (sequential).
    // AR5a: the contract base, its prerequisites and the repository brief are recorded with the answers, so a re-run makes no second read.
    const stored = (begun.record.result ?? {}) as { subtasks?: string[]; after?: number[][]; plan?: Plan; base?: string; brief?: string; prerequisites?: ContractPrerequisite[] };
    // A plan recorded before the contract existed has no base: it is asked again.
    if (stored.base === undefined) delete stored.plan;
    const save = () => this.store.updateOperation(begun.key, (stored.subtasks?.length ?? 0) > 1 || stored.plan !== undefined ? "done" : "intent", stored);
    let plan: Plan;
    let pc: PendingContract;
    try {
      const context = async (): Promise<"ok" | "applied"> => {
        if (stored.base !== undefined && stored.brief !== undefined && stored.prerequisites !== undefined) return "ok";
        const prerequisites: ContractPrerequisite[] = [];
        for (const p of task.prerequisites) {
          const merge = (await this.store.getTask(p))?.merge_sha;
          if (!merge) {
            await this.toOwnerFailure("a prerequisite task has no recorded merge commit, so the task cannot be planned; approve to plan it again", "plan");
            return "applied";
          }
          prerequisites.push({ task: p, merge });
        }
        const base = await this.github.getBranchHead("main");
        const file = await this.github.readFile(REPO_BRIEF_PATH, base);
        const brief = file === null ? null : repoBrief(file);
        if (brief === null) {
          await this.toOwnerFailure("the repository brief is missing or too large; approve to plan it again", "plan");
          return "applied";
        }
        Object.assign(stored, { base, brief, prerequisites });
        await save();
        return "ok";
      };
      let subtasks = stored.subtasks;
      let after = stored.after;
      if (subtasks === undefined) {
        if (task.parent_id === null) {
          if ((await context()) === "applied") return "applied";
          const list = await this.deps.planner.split({ task_id: this.id, owner_text: task.owner_text, is_private: task.is_private, brief: stored.brief! });
          // AR4: an invalid order (unknown or self reference, cycle) is invalid planner output.
          const order = orderSubtasks(list);
          if (!order.ok) throw new PlannerOutputError("planner", order.reason);
          subtasks = [...list];
          after = order.value;
          Object.assign(stored, { subtasks, after });
          await save();
        } else {
          // A subtask was planned by its parent: it is never split again.
          subtasks = [task.owner_text];
        }
      }
      if (subtasks.length > 1) {
        const order = after === undefined ? orderSubtasks(subtasks) : { ok: true as const, value: after };
        if (!order.ok) throw new PlannerOutputError("planner", order.reason);
        return await this.split(subtasks, order.value);
      }
      if ((await context()) === "applied") return "applied";
      if (stored.plan !== undefined) {
        plan = stored.plan;
      } else {
        plan = await this.deps.planner.plan({ task_id: this.id, owner_text: subtasks[0] ?? task.owner_text, is_private: task.is_private, brief: stored.brief! });
        Object.assign(stored, { subtasks, plan });
        await save();
      }
      pc = { acceptance: plan.acceptance, scope: plan.scope, context: plan.context, base: stored.base!, prerequisites: stored.prerequisites! };
    } catch (err) {
      if (err instanceof PlannerInputError) {
        this.log("planning failed: input too large");
        await this.toOwnerFailure("The planner input is larger than the size limit; nothing was sent to the model.", "plan");
        return "applied";
      }
      if (!(err instanceof PlannerOutputError)) throw err;
      this.log(`planning failed: ${err.message}`);
      await this.toOwnerFailure(`The ${err.node === "planner" ? "planner" : "public-title"} model returned unusable output (${err.reason}).`, "plan");
      return "applied";
    }

    const sanitizer = createSanitizer({
      contacts: await this.store.loadContacts(),
      ...(this.deps.blocklist && { blocklist: this.deps.blocklist }),
    });
    // §4.5: a title that fails is never published; the feed and GitHub show `Private task`.
    const text = publicText(plan, sanitizer);
    await this.store.updateTask(this.id, { public_title: text.publicTitle, branch: branchOf(this.id) });

    // AR5a: the contract text is built only from this sanitized plan; one that cannot be a valid contract never reaches GitHub.
    if (!this.contractFits(plan.body, pc)) {
      await this.toOwnerFailure("the proposed task contract is not valid (characters or size); approve to plan it again", "plan");
      return "applied";
    }
    const codes = [...new Set([...text.body.violations, ...contractViolations(plan, sanitizer)])];
    if (codes.length > 0) {
      // §4.2 step 2: GitHub issue text (and contract text) that fails the sanitizer goes to the owner first.
      this.d.pending_issue = text.issue;
      this.d.pending_contract = pc;
      await this.toOwner("issue_text", "issue_text", [
        `The issue or contract text fails the sanitizer (${codes.join(", ")}). Approve to publish it as written; reject to cancel the task.`,
        `Proposed title: ${text.issue.title}`,
        `Proposed body: ${plan.body}`,
        `Proposed acceptance: ${plan.acceptance.join(" | ")}`,
        `Proposed scope: ${plan.scope.join(", ") || "(none)"}`,
        `Proposed context: ${plan.context.join(", ") || "(none)"}`,
      ], `Task ${this.id}: issue text needs review`);
      return "applied";
    }
    await this.publishAndDispatch(text.issue, pc);
    return "applied";
  }

  /** The contract of this task for the issue (AR5a): revision 1, the goal is the issue body as published. */
  contractOf(issue: number, goal: string, pc: PendingContract, revision = 1): TaskContract {
    return { v: 1, task: this.id, revision, issue, goal, acceptance: pc.acceptance, base: pc.base, prerequisites: pc.prerequisites, scope: pc.scope, context: pc.context };
  }

  /** Whether the contract for this text passes the strict parse the workers apply (issue number aside). */
  contractFits(goal: string, pc: PendingContract, revision = 1, issue = 1): boolean {
    try {
      parseContract(canonicalContract(this.contractOf(issue, goal, pc, revision)));
      return true;
    } catch (err) {
      if (err instanceof ContractError) return false;
      throw err;
    }
  }

  /** Opens the issue, builds the contract once the issue number is known, then dispatches the Developer. */
  async publishAndDispatch(issue: { title: string; body: string }, pc: PendingContract): Promise<void> {
    if (!(await this.publishIssue(issue))) return;
    this.d.contract = this.contractOf(this.d.issue_number!, issue.body, pc);
    this.d.revision = 1;
    this.d.pending_contract = null;
    await this.dispatchDev("implement");
  }

  /**
   * Child rows for the subtasks with their prerequisites. The children without prerequisites get
   * their start message in the same transaction (AR4); each child is planned in its own invocation
   * when that message arrives, never in this one.
   */
  async split(subtasks: string[], after: number[][]): Promise<StepOutcome> {
    this.d.children = await this.store.createSubtasks(this.id, subtasks, after);
    this.log(`split into ${this.d.children.length} subtasks: ${this.d.children.map((c) => `task-${c}`).join(", ")}`);
    await this.enter("children");
    return "applied";
  }

  /**
   * Phase `children`, on a sweep: the parent ends once every child has (§11 Q12). A child that
   * failed or was cancelled blocks the queued children that depend on it, directly or not (AR4):
   * they never start. Once no child can make progress, the parent goes to the owner with the reason.
   */
  async childrenDone(): Promise<StepOutcome> {
    const children = await this.store.getChildren(this.id);
    const blocked = blockedChildren(children);
    if (children.some((c) => !FINAL_STATUSES.has(c.status) && !blocked.has(c.id))) return "unchanged";
    if (blocked.size > 0) {
      const ended = children.filter((c) => c.status === "failed" || c.status === "cancelled").map((c) => `task-${c.id}`);
      const waiting = [...blocked].map((c) => `task-${c}`);
      this.log(`children blocked: ${waiting.join(", ")}`);
      await this.toOwner("blocked", "critical_pr", [
        `Subtask ${ended.join(", ")} ended without a merge; the subtasks that depend on it were not started: ${waiting.join(", ")}.`,
        "Approve or reject to close the task as failed; the blocked subtasks are then cancelled.",
      ], `Task ${this.id}: subtasks blocked`);
      return "applied";
    }
    if (children.every((c) => c.status === "merged" || c.status === "done")) {
      await this.enter("done", "done");
      return "applied";
    }
    return this.finish("failed", "a subtask failed or was cancelled");
  }

  /**
   * Opens the task's issue once. False: the request contradicted its record and the task went to the
   * owner. The intent comes before `createIssue`; the body carries a marker line with the effect key,
   * so a re-run that finds an intent but no result looks for that marker in the recent issues before
   * it creates anything. The number is stored in tasks.github_issue as soon as it is known.
   */
  async publishIssue(issue: { title: string; body: string }): Promise<boolean> {
    const row = await this.store.getTask(this.id);
    let number = row?.github_issue ?? null;
    if (number === null) {
      const begun = await this.beginOp("issue", { title: issue.title, body: issue.body }, "plan");
      if (begun === null) return false;
      if (begun.record.state === "done") {
        number = (begun.record.result as { number: number }).number;
      } else {
        if (!begun.created) number = await this.findIssue(begun.key, begun.record.createdAt);
        if (number === null) {
          // AR4: a subtask starts only after its prerequisites merged, so main at its dispatch contains
          // them. The footer names their merge commits (the known ones, in prerequisite order).
          const merges: string[] = [];
          for (const p of row?.prerequisites ?? []) {
            const commit = (await this.store.getTask(p))?.merge_sha;
            if (commit) merges.push(commit);
          }
          const prereqs = merges.length > 0 ? `Prerequisites merged on \`main\`: ${merges.join(", ")}.\n` : "";
          const footer = `\n\n---\nTask ${this.id}. Branch: \`${branchOf(this.id)}\`.\n${prereqs}${issueMarker(begun.key)}`;
          number = (await this.github.createIssue({ title: issue.title, body: issue.body + footer })).number;
        }
        await this.store.updateOperation(begun.key, "done", { number });
      }
      await this.store.updateTask(this.id, { github_issue: number });
    }
    this.d.issue_number = number;
    this.d.issue_title = issue.title;
    this.d.pending_issue = null;
    return true;
  }

  /** The number of the issue that carries this key's marker, among the bot issues created since the intent. */
  async findIssue(key: string, intentAt: string): Promise<number | null> {
    const issues = await this.github.listRecentIssues({ createdAfter: new Date(Date.parse(intentAt) - CLOCK_SLACK_MS).toISOString() });
    const marker = issueMarker(key);
    return issues.find((i) => i.body.includes(marker))?.number ?? null;
  }

  // ------------------------------------------------------------------ dispatches

  /**
   * Dispatches an agent workflow once and links the returned run id to this task (agent_dispatches,
   * RUN-ID-MAPPING-SPEC §2) before the caller writes its event or phase. A null run id (204 or
   * invalid run details, logged by the client) stores nothing: the relay then maps by run title.
   * The link is advisory: if storing it fails (a conflicting link or a database error), the run
   * already exists, so the step logs the fixed code `dispatch_link_failed` and continues.
   *
   * The intent is written before `dispatchWorkflow` and the run id after it. A step that is re-run
   * reuses a recorded run id; with an intent but no result it looks for the run by its run-name
   * (created since the intent) and never dispatches again: if the run is not visible yet the
   * dispatch stays pending (`d.pending_dispatch`, a sweep checks again), and
   * DISPATCH_UNKNOWN_MINUTES after the intent the task goes to the owner. False: the caller must stop
   * (pending, or the owner has the task); true: the run exists.
   */
  async dispatchAgent(workflow: string, baseInputs: Record<string, string>, pending: PendingDispatch): Promise<boolean> {
    const d = this.d;
    // `op` is the dispatch counter of the key: the run carries the identity of its operation (the workflow's run-name and admission).
    const opInputs = () => ({ ...baseInputs, op: String(d.ops?.dispatch ?? 0) });
    let inputs = opInputs();
    const role = agentRoleOfWorkflow(workflow);
    if (role === null || role === "scraper") throw new Error("dispatchAgent: not an agent workflow");
    // AR6: the active execution reservation comes first. A task that holds one (a redispatch, a re-run step) claims nothing twice.
    if (!(await this.store.claimExecution(this.id, role, this.deps.activeExecutionLimit ?? ACTIVE_EXECUTION_LIMIT))) {
      d.pending_capacity = pending;
      this.log(`execution_full role=${role}`);
      return false;
    }
    d.pending_capacity = null;
    let begun = await this.beginOp("dispatch", { workflow, inputs }, RETRY_OF_ROLE[pending.role]);
    // A key whose dispatch GitHub refused created no run: this attempt (a re-run of the step) uses the next key.
    while (begun !== null && begun.record.state === "done" && (begun.record.result as { dispatched?: boolean }).dispatched === false) {
      this.bumpOp("dispatch");
      inputs = opInputs();
      begun = await this.beginOp("dispatch", { workflow, inputs }, RETRY_OF_ROLE[pending.role]);
    }
    if (begun === null) return false;
    // From the intent on, reports of this role with a lower op come from superseded runs (AR2 slice 3).
    d.dispatch_ops = { ...d.dispatch_ops, [role]: Number(inputs.op) };
    // AR5b: one attempt per dispatch key, with the intent (a docs task has no contract and no revision).
    await this.store.recordAttempt({
      effectKey: begun.key,
      taskId: this.id,
      revision: this.revision,
      role,
      op: Number(inputs.op),
      contractHash: this.currentHash,
      baseSha: this.isDocs ? null : (d.contract?.base ?? null),
      createdAt: this.now().toISOString(),
    });
    let runId: number | null;
    if (begun.record.state === "done") {
      runId = (begun.record.result as { runId: number | null }).runId;
    } else {
      if (begun.created) {
        try {
          runId = (await this.github.dispatchWorkflow({ workflow, inputs })).runId;
        } catch (err) {
          // A 4xx other than 408 and 429 is a refusal: no run exists. Everything else stays an ambiguous intent.
          const status = err instanceof GitHubApiError ? err.status : undefined;
          if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
            await this.store.updateOperation(begun.key, "done", { dispatched: false, status });
            await this.store.updateAttempt(begun.key, { endedAt: this.now().toISOString(), outcome: "failed" });
            this.bumpOp("dispatch");
            // AR6: no run, so no reservation: the row goes back to what the phase says (a re-run claims again).
            await this.store.updateTask(this.id, { status: d.phase === "queued" ? "planning" : "waiting", waiting_on: waitingOnOf(d.phase) });
          }
          throw err;
        }
      } else {
        const run = await this.github.findWorkflowRun({
          workflow,
          displayTitle: agentRunName(role, this.id, Number(inputs.op)),
          createdAfter: new Date(Date.parse(begun.record.createdAt) - CLOCK_SLACK_MS).toISOString(),
        });
        if (run === null) {
          if (this.minutesSince(begun.record.createdAt) >= DISPATCH_UNKNOWN_MINUTES) {
            this.log(`dispatch_outcome_unknown role=${role}`);
            await this.toOwnerFailure(
              `The ${role} dispatch outcome is unknown: no run appeared ${DISPATCH_UNKNOWN_MINUTES} minutes after it was requested, and it is not repeated automatically.`,
              RETRY_OF_ROLE[pending.role],
            );
          } else {
            d.pending_dispatch = pending;
            this.log(`dispatch pending role=${role}`);
          }
          return false;
        }
        runId = run.id;
      }
      await this.store.updateOperation(begun.key, "done", { runId });
    }
    d.pending_dispatch = null;
    this.bumpOp("dispatch");
    if (runId !== null) {
      await this.store.updateAttempt(begun.key, { runId });
      try {
        await this.store.recordDispatch(runId, this.id, role);
      } catch (err) {
        const reason = err instanceof DispatchLinkConflictError ? "conflict" : "db";
        this.log(`dispatch_link_failed role=${role} reason=${reason}`);
      }
    }
    return true;
  }

  /** A sweep on a pending dispatch: look for its run again (the same operation, the same key). */
  async resumeDispatch(p: PendingDispatch): Promise<StepOutcome> {
    if (p.role === "dev") await this.dispatchDev(p.mode ?? "implement", p.reason, p.redispatched);
    else if (p.role === "qa") await this.dispatchQa(p.reason, p.redispatched);
    else await this.dispatchDocs(p.reason, p.redispatched);
    if (this.d.pending_capacity != null) return "queued";
    return this.d.pending_dispatch != null ? "unchanged" : "applied";
  }

  /**
   * The canonical contract input of a Developer or QA dispatch. A task planned before contracts
   * existed has none: it fails (null). Its issue, and any PR, belong to that earlier plan, so it is
   * not planned again here; the owner creates a new task.
   */
  async contractInput(): Promise<string | null> {
    const c = this.d.contract;
    if (c !== undefined) {
      // AR5b: the revision's row is written before its first dispatch (a second write changes nothing).
      this.d.revision = c.revision;
      await this.store.recordRevision({ taskId: this.id, revision: c.revision, contractHash: contractHash(c), contract: c });
      return canonicalContract(c);
    }
    await this.finish("failed", "the task was planned before task contracts existed; create the task again");
    return null;
  }

  /** `redispatched`: this is the timeout's one redispatch (§4.3); the flag is set once the run exists. */
  async dispatchDev(mode: DevMode, reason?: string, redispatched = false): Promise<boolean> {
    const d = this.d;
    const contract = await this.contractInput();
    if (contract === null) return false;
    const sent = await this.dispatchAgent(
      DEV_WORKFLOW,
      {
        contract,
        task_id: String(this.id),
        issue: d.issue_number === null ? "" : String(d.issue_number),
        mode,
        pr: d.pr_number === null ? "" : String(d.pr_number),
      },
      { role: "dev", mode, ...(reason !== undefined && { reason }), redispatched },
    );
    if (!sent) return false;
    d.dev_mode = mode;
    await this.event("task_assigned", "developer", { mode, attempts: d.attempts, ...(reason && { reason }) });
    await this.enter("dev");
    if (redispatched) d.redispatched = true;
    return true;
  }

  async dispatchDocs(reason?: string, redispatched = false): Promise<boolean> {
    const d = this.d;
    const sent = await this.dispatchAgent(
      DOCS_WORKFLOW,
      { task_id: String(this.id), pr: String(d.docs_pr) },
      { role: "docs", ...(reason !== undefined && { reason }), redispatched },
    );
    if (!sent) return false;
    d.docs_started = false; // this run's start report sets it
    await this.event("task_assigned", "docs", { pr: d.docs_pr, attempts: d.attempts, ...(reason && { reason }) });
    await this.enter("dev");
    if (redispatched) d.redispatched = true;
    return true;
  }

  async dispatchQa(reason?: string, redispatched = false): Promise<boolean> {
    // A docs task's PR is reviewed without a contract (Docs dispatches are unchanged, AR5a).
    const contract = this.isDocs ? undefined : await this.contractInput();
    if (contract === null) return false;
    const sent = await this.dispatchAgent(
      QA_WORKFLOW,
      { ...(contract !== undefined && { contract }), task_id: String(this.id), pr: String(this.d.pr_number) },
      { role: "qa", ...(reason !== undefined && { reason }), redispatched },
    );
    if (!sent) return false;
    await this.event("qa_reviewing", "qa", { pr: this.d.pr_number, ...(reason && { reason }) });
    await this.enter("qa");
    if (redispatched) this.d.redispatched = true;
    return true;
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

  /** The task's PR was merged or closed outside the orchestrator: a pending approval no longer applies. */
  async onPrClosed(merged: boolean): Promise<StepOutcome> {
    const d = this.d;
    if (d.approval_id !== null) {
      await this.store.supersedeApproval(d.approval_id, `Superseded: PR #${d.pr_number} was ${merged ? "merged" : "closed"} outside the orchestrator.`);
    }
    if (!merged) return this.finish("cancelled", `PR #${d.pr_number} was closed without merging outside the orchestrator`);
    await this.event("merged", "orchestrator", { pr: d.pr_number, by: "external" });
    // §4.2 step 8 as in merge(): Docs-keeper follows every merged work PR, never a docs PR.
    if (!this.isDocs) await this.createDocsTask(d.pr_number!);
    // The webhook carries no merge commit: dependents are released without a recorded base (their
    // dispatch still runs on main after this merge).
    await this.enter("done", "merged", null);
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

  /** `recordCi`, and the CI evidence row of the head it set (AR5b). */
  async recordCiEvidence(i: Extract<GitHubInput, { event: "workflow_run" }>): Promise<boolean> {
    if (!this.recordCi(i)) return false;
    await this.writeCi();
    return true;
  }

  async onCiResult(i: Extract<GitHubInput, { event: "workflow_run" }>): Promise<StepOutcome | undefined> {
    if (!(await this.recordCiEvidence(i))) return undefined;
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
    // AR5b: attempts exhausted: approving replans (a new contract revision) instead of more attempts.
    // A task planned before contracts existed cannot replan: it keeps the Developer retry, whose
    // dispatch then fails it (it is never planned again onto its existing PR).
    await this.toOwnerFailure(`${what}; ${d.attempts} failed attempts.`, this.canReplan ? "plan" : "dev");
  }

  // ------------------------------------------------------------------ QA (step 6)

  async onReview(i: Extract<GitHubInput, { event: "pull_request_review" }>): Promise<StepOutcome | undefined> {
    const d = this.d;
    if (i.action !== "submitted" || i.pr_number !== d.pr_number || i.commit_id === null || i.commit_id !== d.head_sha) {
      return undefined;
    }
    if (i.review_state === "approved") {
      // AR5b: applied only if it is valid evidence for the current revision and head.
      if (!(await this.applyApproval())) return undefined;
      await this.event("approved", "qa", { pr: d.pr_number, head_sha: d.head_sha });
      await this.mergeStep();
      return "applied";
    }
    if (i.review_state === "changes_requested") {
      // AR5b: like an approval, it counts only from the current revision's latest QA attempt once
      // that attempt has started; a late review of an earlier run must not cost the new revision an attempt.
      const rows = await this.store.loadValidity(this.id, this.revision, d.head_sha!);
      const latest = latestQaAttempt(rows, this.revision);
      if (latest === null || latest.started_at === null) {
        this.log("review_not_valid");
        return undefined;
      }
      await this.recordQaEvidence("changes_requested", latest.effect_key, latest.op);
      await this.event("changes_requested", "qa", { pr: d.pr_number, head_sha: d.head_sha });
      await this.failedAttempt("QA requested changes");
      return "applied";
    }
    return undefined; // a comment-only review
  }

  async recordQaEvidence(outcome: "approved" | "changes_requested", attemptKey: string | null, op: number | null): Promise<void> {
    const head = this.d.head_sha!;
    const revision = this.revision;
    await this.store.recordEvidence({
      effectKey: `${threadIdOf(this.id)}/evidence/qa/${head}/${revision ?? 0}/${op ?? "none"}/${outcome}`,
      taskId: this.id,
      revision,
      kind: "qa",
      headSha: head,
      outcome,
      attemptKey,
      createdAt: this.now().toISOString(),
    });
  }

  /**
   * AR5b: records a QA approval of the current head and returns whether it is valid evidence (the
   * revision's latest QA attempt has started and the revision is current). An approval that is not
   * valid (an older revision's run, or a review from an attempt whose start report has not arrived)
   * is neither recorded nor applied.
   */
  async applyApproval(): Promise<boolean> {
    const head = this.d.head_sha!;
    const revision = this.revision;
    const rows = await this.store.loadValidity(this.id, revision, head);
    const latest = latestQaAttempt(rows, revision);
    const candidate: EvidenceRow | null =
      latest === null ? null : { kind: "qa", revision, head_sha: head, outcome: "approved", attempt_key: latest.effect_key, superseded_at: null };
    if (latest === null || candidate === null || !evidenceValid("qa", { revision, head }, { ...rows, evidence: [...rows.evidence, candidate] })) {
      this.log("approval_not_valid");
      return false;
    }
    await this.recordQaEvidence("approved", latest.effect_key, latest.op);
    return true;
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
    // AR5b: the stored evidence, not the checkpoint, decides. CI evidence is backfilled from `d.ci`
    // (a checkpoint from before the tables existed); QA evidence has no other source: a missing or
    // stale approval sends QA again for the current revision, with no owner step.
    await this.writeCi();
    const revision = this.revision;
    const rows = await this.store.loadValidity(this.id, revision, sha);
    if (!evidenceValid("ci", { revision, head: sha }, rows)) return this.incomplete("ci_not_finished");
    if (!evidenceValid("qa", { revision, head: sha }, rows)) {
      this.log("qa_evidence_not_valid");
      await this.dispatchQa("QA approval is not valid for the current head and revision");
      return;
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
      uncoveredPaths: artifact.input.uncoveredPaths,
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
    // A check run of this name on this head supersedes the earlier one (the ruleset reads the
    // latest), so a repeated post needs no operation record.
    await this.github.postCheck({ headSha, state: "success", title: checkTitle, summary: checkSummary });
    const title = `${d.issue_title ?? PRIVATE_TITLE} (#${pr})`;
    const begun = await this.beginOp("merge", { pr, headSha, title }, this.devRetry);
    if (begun === null) return;
    let res: MergeResult | undefined;
    if (begun.record.state === "done") {
      res = begun.record.result as MergeResult;
    } else {
      // An intent without a result: the merge may have happened without its answer reaching us.
      if (!begun.created) {
        const state = await this.github.getPrMergeState(pr);
        if (state.merged) res = { merged: true, sha: state.mergeCommitSha ?? "unknown" };
      }
      res ??= await this.github.merge({ pr, headSha, title });
      await this.store.updateOperation(begun.key, "done", res);
    }
    this.bumpOp("merge");
    if (res.merged) {
      await this.event("merged", "orchestrator", { pr, sha: res.sha });
      // §4.2 step 8: Docs-keeper follows every merged work PR, never a docs PR (no loop).
      if (!this.isDocs) await this.createDocsTask(pr);
      await this.enter("done", "merged", res.sha);
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
    wait: OwnerWait,
    kind: "issue_text" | "critical_pr",
    reasons: string[],
    inboxTitle: string,
  ): Promise<void> {
    const id = await this.store.createApproval({ taskId: this.id, kind, reasons, inboxTitle, effectKey: this.nextEffectKey(`approval/${kind}`) });
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
    // AR5b: for a task that has its issue and contract, "plan" means a replan (a new contract revision).
    const replan = retry === "plan" && this.canReplan;
    await this.toOwner("failure", "critical_pr", [`Task failed: ${what}`, replan ? REPLAN_TEXT : `Approve to ${again}; reject to mark the task failed.`], `Task ${this.id} failed: needs a decision`);
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

    if (wait === "blocked") {
      await this.store.cancelQueued([...blockedChildren(await this.store.getChildren(this.id))]);
      return this.finish("failed", "a subtask failed; the subtasks that depend on it were cancelled");
    }

    if (wait === "issue_text") {
      if (decision === "rejected") return this.finish("cancelled", "issue text rejected by the owner");
      if (d.pending_revision != null && d.pending_contract && d.pending_issue && d.contract) {
        // AR5b: a replan's contract text, approved as written: nothing is published, the revision is released.
        await this.adoptRevision(d.pending_issue.body, d.pending_contract, d.pending_revision);
        return "applied";
      }
      if (!d.pending_contract) {
        // Planned before the contract existed: nothing to publish as written.
        await this.toOwnerFailure("the task has no contract; approve to plan it again", "plan");
        return "applied";
      }
      await this.publishAndDispatch(d.pending_issue!, d.pending_contract);
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
      // AR5b: a task with its issue and contract replans: a new contract revision, the issue untouched.
      if (this.canReplan) return this.replan(task);
      // A task with a PR is never planned again (that would dispatch `implement` onto the PR).
      if (d.pr_number !== null) return this.finish("failed", "the task was planned before task contracts existed; create the task again");
      // A deliberate replan: new planner and issue operations (new keys).
      this.bumpOp("plan");
      this.bumpOp("issue");
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

  /**
   * AR5b: replan a task that has its issue and contract (attempts exhausted, owner approved). Only the
   * public-title node runs (never `split`), with the previous contract and one fixed failure line
   * built from counts; the answer is sanitized as for revision 1. The new contract keeps the issue,
   * `base` and `prerequisites`; the issue is not edited and nothing is published.
   */
  async replan(task: TaskRecord): Promise<StepOutcome> {
    const d = this.d;
    const prev = d.contract!;
    const revision = prev.revision + 1;
    this.bumpOp("plan");
    const begun = await this.beginOp("plan", { owner_text: task.owner_text, is_private: task.is_private, revision }, "plan");
    if (begun === null) return "applied";
    const stored = (begun.record.result ?? {}) as { brief?: string; plan?: Plan };
    const save = () => this.store.updateOperation(begun.key, stored.plan !== undefined ? "done" : "intent", stored);
    let plan: Plan;
    try {
      if (stored.brief === undefined) {
        // The brief of the contract base: the same text revision 1 was planned from.
        const file = await this.github.readFile(REPO_BRIEF_PATH, prev.base);
        const brief = file === null ? null : repoBrief(file);
        if (brief === null) {
          await this.toOwnerFailure("the repository brief is missing or too large; approve to plan it again", "plan");
          return "applied";
        }
        stored.brief = brief;
        await save();
      }
      if (stored.plan === undefined) {
        stored.plan = await this.deps.planner.plan({
          task_id: this.id,
          owner_text: task.owner_text,
          is_private: task.is_private,
          brief: stored.brief,
          previous: prev,
          failure: `Revision ${prev.revision} used ${d.attempts} of ${MAX_ATTEMPTS} attempts without an approved QA review.`,
        });
        await save();
      }
      plan = stored.plan;
    } catch (err) {
      if (err instanceof PlannerInputError) {
        this.log("replanning failed: input too large");
        await this.toOwnerFailure("The planner input is larger than the size limit; nothing was sent to the model.", "plan");
        return "applied";
      }
      if (!(err instanceof PlannerOutputError)) throw err;
      this.log(`replanning failed: ${err.message}`);
      await this.toOwnerFailure(`The public-title model returned unusable output (${err.reason}).`, "plan");
      return "applied";
    }
    const pc: PendingContract = { acceptance: plan.acceptance, scope: plan.scope, context: plan.context, base: prev.base, prerequisites: prev.prerequisites };
    const sanitizer = createSanitizer({
      contacts: await this.store.loadContacts(),
      ...(this.deps.blocklist && { blocklist: this.deps.blocklist }),
    });
    const text = publicText(plan, sanitizer);
    if (!this.contractFits(plan.body, pc, revision, prev.issue)) {
      await this.toOwnerFailure("the proposed task contract is not valid (characters or size); approve to plan it again", "plan");
      return "applied";
    }
    const codes = [...new Set([...text.body.violations, ...contractViolations(plan, sanitizer)])];
    if (codes.length > 0) {
      d.pending_issue = text.issue;
      d.pending_contract = pc;
      d.pending_revision = revision;
      await this.toOwner("issue_text", "issue_text", [
        `The contract text of revision ${revision} fails the sanitizer (${codes.join(", ")}). Approve to release it as written (nothing is published again); reject to cancel the task.`,
        `Proposed body: ${plan.body}`,
        `Proposed acceptance: ${plan.acceptance.join(" | ")}`,
        `Proposed scope: ${plan.scope.join(", ") || "(none)"}`,
        `Proposed context: ${plan.context.join(", ") || "(none)"}`,
      ], `Task ${this.id}: contract text needs review`);
      return "applied";
    }
    await this.adoptRevision(text.issue.body, pc, revision);
    return "applied";
  }

  /**
   * AR5b: the new revision replaces the current one (one transaction: the old revision, its open
   * attempts and its QA evidence are superseded, the new row is inserted), attempts restart at 0, and
   * the task continues by what its PR has: no PR, the Developer implements; CI success at the head
   * (reused for an unchanged head), QA reviews the new contract; CI failure at the head, the Developer
   * fixes; CI unknown, wait for CI. A task with a PR is never dispatched `implement`.
   */
  async adoptRevision(goal: string, pc: PendingContract, revision: number): Promise<void> {
    const d = this.d;
    const prev = d.contract!;
    const next = this.contractOf(prev.issue, goal, pc, revision);
    await this.store.supersedeRevision(this.id, prev.revision, { taskId: this.id, revision, contractHash: contractHash(next), contract: next });
    d.contract = next;
    d.revision = revision;
    d.pending_issue = null;
    d.pending_contract = null;
    d.pending_revision = null;
    d.attempts = 0;
    await this.store.updateTask(this.id, { attempts: 0 });
    const head = d.head_sha;
    if (d.pr_number === null || head === null) {
      await this.dispatchDev("implement", "replan");
      return;
    }
    if (d.ci?.sha === head && d.ci.result === "failure") {
      await this.dispatchDev("fix", "replan");
      return;
    }
    if (d.ci?.sha === head) {
      await this.writeCi(); // a checkpoint from before the tables existed
      if (evidenceValid("ci", { revision, head }, await this.store.loadValidity(this.id, revision, head))) {
        await this.dispatchQa("replan");
        return;
      }
    }
    await this.event("ci_running", "orchestrator", { pr: d.pr_number, head_sha: head });
    await this.enter("ci");
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
      // AR6: the replacement starts only once the previous run is over. A run that still runs is cancelled and
      // the reservation stays; a later sweep looks again. Completed or not visible: it is reconciled below.
      const role = phase === "dev" ? "developer" : "qa";
      const prev = d.dispatch_ops?.[role] ?? Math.max(0, (d.ops?.dispatch ?? 1) - 1);
      // The run-name is exact (task and op); the time only bounds the listing. `waiting_since` is set when the
      // run was found, which can be up to DISPATCH_UNKNOWN_MINUTES after its dispatch intent.
      const run = await this.github.findWorkflowRun({
        workflow: phase === "dev" ? DEV_WORKFLOW : QA_WORKFLOW,
        displayTitle: agentRunName(role, this.id, prev),
        createdAfter: new Date(Date.parse(d.waiting_since ?? this.now().toISOString()) - DISPATCH_UNKNOWN_MINUTES * 60_000 - CLOCK_SLACK_MS).toISOString(),
      });
      if (run !== null && run.status !== "completed") {
        await this.github.cancelRun(run.id);
        this.log(`replacement_waits role=${role}`);
        return "unchanged";
      }
      // Redispatch once (§4.3); the run that ended without a report is `lost` (AR5b).
      await this.markLost(phase === "dev" ? "developer" : "qa");
      if (phase === "dev") await this.dispatchDev(d.dev_mode, reason, true);
      else await this.dispatchQa(reason, true);
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
   * the sweep reads the run's state, found by its run-name (the run id may be unknown: a dispatch can return none).
   */
  async docsSweep(): Promise<StepOutcome> {
    const d = this.d;
    const waited = this.minutesSince(d.waiting_since);
    const since = Date.parse(d.waiting_since ?? this.now().toISOString()) - CLOCK_SLACK_MS;
    const run = await this.github.findWorkflowRun({
      workflow: DOCS_WORKFLOW,
      // The last dispatch's op: the counter moves when a dispatch completes.
      displayTitle: agentRunName("docs", this.id, Math.max(0, (d.ops?.dispatch ?? 1) - 1)),
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
    await this.markLost("docs");
    await this.dispatchDocs(reason, true);
    return "applied";
  }
}

/**
 * AR4: the queued children that can never start: a prerequisite failed or was cancelled, or is
 * itself blocked.
 */
export function blockedChildren(children: readonly ChildTask[]): Set<number> {
  const byId = new Map(children.map((c) => [c.id, c]));
  const blocked = new Set<number>();
  const dead = (id: number) => blocked.has(id) || ["failed", "cancelled"].includes(byId.get(id)?.status ?? "");
  for (let changed = true; changed; ) {
    changed = false;
    for (const c of children) {
      if (c.status === "queued" && !blocked.has(c.id) && c.prerequisites.some(dead)) {
        blocked.add(c.id);
        changed = true;
      }
    }
  }
  return blocked;
}
