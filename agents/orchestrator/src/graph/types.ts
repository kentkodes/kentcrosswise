// Task graph types and limits (P2-10, DESIGN §4.2-§4.3, D20, §11 Q11).
import type { TaskContract } from "@kcw/core/contract";
import type { AgentReport } from "@kcw/core/events";
import type { OperationKind } from "./operations";

/** Agent workflows the orchestrator dispatches (§4.1). */
export const DEV_WORKFLOW = "agent-developer.yml";
export const QA_WORKFLOW = "agent-qa.yml";
export const DOCS_WORKFLOW = "agent-docs.yml";

/** The role of an agent workflow run (agent_runs.role, agent_dispatches.role). */
export type AgentRunRole = "developer" | "qa" | "docs" | "scraper";

const AGENT_WORKFLOW_ROLES: Readonly<Record<string, AgentRunRole>> = {
  "agent-developer.yml": "developer",
  "agent-qa.yml": "qa",
  "agent-docs.yml": "docs",
  "agent-scraper.yml": "scraper",
};

/** The role of a dispatched workflow file (RUN-ID-MAPPING-SPEC §2), or null for any non-agent workflow. */
export function agentRoleOfWorkflow(workflow: string): AgentRunRole | null {
  return Object.hasOwn(AGENT_WORKFLOW_ROLES, workflow) ? AGENT_WORKFLOW_ROLES[workflow]! : null;
}

/** Docs task sweep (§4.3): a run still queued or in progress after this many minutes goes to the owner (job timeouts sum to 95). */
export const DOCS_WAIT_LIMIT_MINUTES = 150;

/** Docs task sweep: no agent-docs.yml run this long after the dispatch means it was lost (redispatch once). */
export const DOCS_NO_RUN_MINUTES = 30;

/** §4.2 step 5: a failure while attempts < 3 goes back to the Developer; the third goes to the owner. */
export const MAX_ATTEMPTS = 3;

/** D20: at most this many agent tasks in flight (statuses planning, in_progress, waiting). */
export const IN_FLIGHT_LIMIT = 4;

/** §4.3 sweeper limits per wait, in minutes. The owner never times out. */
export const WAIT_LIMIT_MINUTES = { dev: 60, ci: 90, qa: 60 } as const;

/**
 * Q11: how long the merge step waits for complete inputs (CI finished on the PR head, the full
 * file list, the merge-rules artifact) before it marks the PR critical. Every missing input is a CI
 * output, so it gets the CI wait's limit.
 */
export const INCOMPLETE_INPUT_TIMEOUT_MINUTES = 90;

/**
 * AR2 slice 2a: a dispatch whose outcome is not known (an intent exists, its run is not visible
 * yet) waits this long, counted from the intent, before the task goes to the owner. It is never
 * redispatched blindly.
 */
export const DISPATCH_UNKNOWN_MINUTES = 10;

/** The Developer's branch for a task (Developer playbook; the relay resolves tasks from it). */
export const branchOf = (taskId: number): string => `kcw/task-${taskId}`;

/**
 * Where a task thread is:
 * - `queued`: not started (paused, or the in-flight limit is reached); a sweep retries.
 * - `dev` / `ci` / `qa`: waiting on the Developer, CI or QA.
 * - `merge`: QA approved; waiting for complete merge-rules inputs (Q11).
 * - `owner`: waiting on an approval.
 * - `children`: the planner split the task into subtasks (child tasks with their own threads); a
 *   child starts by an outbox message once its prerequisites merged (AR4); a sweep finishes the
 *   parent once every child has ended, or parks it for the owner when a failed child blocks others.
 * - `done`: merged, failed or cancelled (the thread ends).
 */
export type Phase = "queued" | "dev" | "ci" | "qa" | "merge" | "owner" | "children" | "done";

/** `tasks.waiting_on` (§3.2). */
export type WaitingOn = "dev" | "ci" | "qa" | "owner" | "deploy";

/**
 * Why the thread waits on the owner. `blocked`: a split parent whose failed or cancelled subtask
 * blocks the subtasks that depend on it (AR4); either decision closes the parent as failed and
 * cancels the blocked subtasks.
 */
export type OwnerWait = "issue_text" | "critical" | "failure" | "blocked";

export type DevMode = "implement" | "fix";

/**
 * What approving a failure restarts: the Developer, QA, planning (planner or public-title output
 * invalid), or Docs-keeper (a docs task has no Developer).
 */
export type RetryTarget = "dev" | "qa" | "plan" | "docs";

/** A work task runs the PR loop for owner text; a docs task runs Docs-keeper after a merge (§4.2 step 8). */
export type TaskKind = "work" | "docs";

/** Why the merge step is waiting (Q11). */
export type IncompleteReason = "ci_not_finished" | "head_moved" | "diff_incomplete" | "trusted_run_pending" | "trusted_run_failed" | "no_artifact";

/** GitHub webhook events as the relay forwards them (only the fields the graph reads). */
export type GitHubInput =
  | {
      kind: "github";
      event: "pull_request";
      action: string;
      pr_number: number;
      head_ref: string | null;
      head_sha: string | null;
      merged: boolean;
    }
  | {
      kind: "github";
      event: "pull_request_review";
      action: string;
      pr_number: number;
      /** `approved`, `changes_requested`, `commented`, `dismissed` (lowercase). */
      review_state: string | null;
      commit_id: string | null;
    }
  | {
      kind: "github";
      event: "workflow_run";
      action: string;
      run_id: number;
      agent_task_id?: number;
      run_attempt?: number | null;
      head_branch?: string | null;
      run_started_at?: string | null;
      updated_at?: string | null;
      workflow_path: string | null;
      conclusion: string | null;
      trigger: string | null;
      head_sha: string | null;
      pr_numbers: number[];
    }
  | { kind: "github"; event: "issues" | "push"; action: string };

export type Decision = "approved" | "rejected";

/** One validated queue message for a task thread. `message_id` (the SQS message id) detects redeliveries. */
export type TaskInput = (
  /**
   * `docs` is set only by the orchestrator itself (index.ts `startDocsTask`) when it starts the
   * docs task of a merged PR; `parseTaskMessage` never produces it, so a queue message cannot.
   */
  | { kind: "start"; docs?: { pr: number } }
  | { kind: "report"; report: AgentReport }
  | GitHubInput
  | { kind: "decision"; approval_id: string; decision: Decision }
  | { kind: "sweep" }
) & {
  message_id: string;
  /** The logical message key (relay delivery id, web outbox key) when the message has one: stable across SQS resends. */
  message_key?: string;
};

/** What processing one input did (logged by the handler; never message content). */
export type StepOutcome =
  | "applied" // the task moved on
  | "stale" // unexpected or outdated input: recorded, the thread waits on as before
  | "unchanged" // a sweep with nothing to do, or a usage-only report
  | "deferred" // agents_paused: kept and processed on unpause
  | "paused" // a sweep while agents_paused
  | "queued" // not started yet (paused or in-flight limit)
  | "duplicate"; // a report whose identity was already applied (AR2 slice 3): nothing written

/** The part of the thread state the state machine owns (checkpointed in schema lg; private). */
export interface TaskData {
  phase: Phase;
  owner_wait: OwnerWait | null;
  approval_id: string | null;
  /** For an owner wait after a failure: what approving it restarts. */
  retry: RetryTarget | null;
  dev_mode: DevMode;
  issue_number: number | null;
  /** The public issue title (sanitized; also used for the squash commit). */
  issue_title: string | null;
  /** Issue text waiting for an `issue_text` approval. */
  pending_issue: { title: string; body: string } | null;
  /**
   * AR5a: the contract fields proposed with `pending_issue` (acceptance, paths, base, prerequisites);
   * approving the issue text builds the contract from them as written. Absent otherwise.
   */
  pending_contract?: PendingContract | null;
  /**
   * AR5a: the revision contract Developer and QA dispatches carry (built after the issue is
   * published). Absent in checkpoints written before the contract existed: such a task cannot be dispatched.
   */
  contract?: TaskContract;
  pr_number: number | null;
  head_sha: string | null;
  /** The ci.yml result on `head_sha`, once known. */
  ci: { sha: string; result: "success" | "failure" } | null;
  attempts: number;
  /** A timed-out agent wait was redispatched once already (§4.3). */
  redispatched: boolean;
  /** ISO time the current wait started. */
  waiting_since: string | null;
  incomplete: { since: string; reason: IncompleteReason } | null;
  /** Inputs that arrived while agents_paused, oldest first. */
  deferred: TaskInput[];
  /** Number of stale inputs seen. */
  stale: number;
  last_message_id: string | null;
  last_outcome: StepOutcome | null;
  /** Child task ids, once the planner split the task (phase `children`). */
  children: number[];
  /** Absent in checkpoints written before docs tasks existed: those are work tasks. */
  kind?: TaskKind;
  /** Docs task: the merged PR Docs-keeper documents. */
  docs_pr?: number | null;
  /** Work task: the docs task created when its PR merged. */
  docs_task?: number | null;
  /** Docs task: the current agent-docs.yml run sent its start report (`coding`). */
  docs_started?: boolean;
  /**
   * AR2 slice 2a: per kind, the number n of the next effect key `task-<id>/<kind>/<n>`
   * (graph/operations.ts). It moves only when an operation finishes or is abandoned, so a step that
   * is re-run from the previous checkpoint computes the same key. Absent in older checkpoints (0).
   */
  ops?: Partial<Record<OperationKind, number>>;
  pending_dispatch?: PendingDispatch | null;
  /**
   * AR2 slice 3: per agent, the op of its latest dispatch (written with the dispatch intent). A
   * report with a lower op comes from a superseded run: its usage is recorded, its event is not.
   * Absent in older checkpoints: no report is fenced.
   */
  dispatch_ops?: Partial<Record<"developer" | "qa" | "docs", number>>;
  /**
   * AR2 slice 3: the identities (reportKey) of the reports this thread applied, newest last (bounded).
   * A redelivered report found here is a no-op; one whose database write already happened but is
   * missing here (a crash before the checkpoint) still gets its state updates.
   */
  applied_reports?: string[];
}

/** The contract fields that are not the issue text (see TaskData.pending_contract). */
export type PendingContract = Pick<TaskContract, "acceptance" | "scope" | "context" | "base" | "prerequisites">;

/** A dispatch waiting for its run to become visible (see DISPATCH_UNKNOWN_MINUTES); a sweep resumes it. */
export interface PendingDispatch {
  role: "dev" | "qa" | "docs";
  mode?: DevMode;
  reason?: string;
  /** The timeout redispatch: set `redispatched` once the run is found. */
  redispatched?: boolean;
}

export function initialTaskData(): TaskData {
  return {
    phase: "queued",
    owner_wait: null,
    approval_id: null,
    retry: null,
    dev_mode: "implement",
    issue_number: null,
    issue_title: null,
    pending_issue: null,
    pr_number: null,
    head_sha: null,
    ci: null,
    attempts: 0,
    redispatched: false,
    waiting_since: null,
    incomplete: null,
    deferred: [],
    stale: 0,
    last_message_id: null,
    last_outcome: null,
    children: [],
  };
}

/** `tasks.waiting_on` for a phase. */
export function waitingOnOf(phase: Phase): WaitingOn | null {
  switch (phase) {
    case "dev":
    case "ci":
    case "qa":
    case "owner":
      return phase;
    case "merge":
      return "ci"; // the missing inputs are CI outputs
    default:
      return null;
  }
}

/** §4.2 step 2: the planner splits a task into at most this many subtasks. */
export const MAX_SUBTASKS = 5;

/** The public text of one (sub)task, from the public-title node (`@kcw/orchestrator/nodes`). */
export interface Plan {
  /** Proposed public title (sanitized before use). */
  title: string;
  /** Proposed issue body (sanitized before use). */
  body: string;
  /** 1 to 10 checkable acceptance items (AR5a). */
  acceptance: string[];
  /** Repository path prefixes the task owns (0 to 20). */
  scope: string[];
  /** Repository paths to read first (0 to 20). */
  context: string[];
}

export interface PlanRequest {
  task_id: number;
  /** Private: never sent to a public surface unsanitized. */
  owner_text: string;
  is_private: boolean;
  /** AR5a: the bounded repository brief (public text) read at the contract base. */
  brief: string;
}

/**
 * The planner's subtasks in order (AR4). `after[i]`, when present, lists the subtasks (0-based
 * indices) that must be merged before subtask i starts; `[]` marks it independent. Without `after`
 * (or for a missing entry) a subtask waits for the one before it: sequential by default. A plain
 * `string[]` is a valid list, so planners that give no order information stay sequential.
 */
export type SubtaskList = string[] & { after?: (number[] | undefined)[] };

/**
 * The validated prerequisites of each subtask (0-based indices), or why the order is invalid: an
 * entry that is not a list of integers, a self reference, an unknown subtask, a repeated entry or a
 * cycle. Missing entries default to the previous subtask. The reason never quotes subtask text.
 */
export function orderSubtasks(list: SubtaskList): { ok: true; value: number[][] } | { ok: false; reason: string } {
  const n = list.length;
  const after = list.after;
  if (after !== undefined && (!Array.isArray(after) || after.length > n)) return { ok: false, reason: "after does not match the subtasks" };
  const value: number[][] = [];
  for (let i = 0; i < n; i++) {
    const given = after?.[i];
    if (given === undefined) {
      value.push(i === 0 ? [] : [i - 1]);
      continue;
    }
    if (!Array.isArray(given) || !given.every((p) => Number.isInteger(p))) return { ok: false, reason: `subtask ${i + 1}: after is not a list of subtask numbers` };
    if (given.includes(i)) return { ok: false, reason: `subtask ${i + 1} depends on itself` };
    if (given.some((p) => p < 0 || p >= n)) return { ok: false, reason: `subtask ${i + 1} depends on an unknown subtask` };
    if (new Set(given).size !== given.length) return { ok: false, reason: `subtask ${i + 1} lists a prerequisite twice` };
    value.push([...given].sort((a, b) => a - b));
  }
  // Kahn's algorithm: every subtask must become startable.
  const remaining = value.map((p) => p.length);
  const ready = remaining.flatMap((r, i) => (r === 0 ? [i] : []));
  let seen = 0;
  while (ready.length > 0) {
    const done = ready.pop()!;
    seen += 1;
    value.forEach((p, i) => {
      if (p.includes(done) && --remaining[i]! === 0) ready.push(i);
    });
  }
  if (seen !== n) return { ok: false, reason: "the subtask order has a cycle" };
  return { ok: true, value };
}

/** The planner and public-title nodes (P2-11: `ModelPlanner` in `@kcw/orchestrator/nodes`; tests use fakes). */
export interface Planner {
  /**
   * Planner node: the task's private text split into 1..MAX_SUBTASKS subtasks, each a private,
   * self-contained description of one PR, with their order (SubtaskList). Only top-level tasks are split.
   */
  split(req: PlanRequest): Promise<SubtaskList>;
  /** Public-title node: the public title and issue body of one (sub)task. */
  plan(req: PlanRequest): Promise<Plan>;
}

/** The planner prompt exceeds MAX_PLANNER_INPUT_BYTES: no model call was made. */
export class PlannerInputError extends Error {
  constructor() {
    super("planner input too large");
    this.name = "PlannerInputError";
  }
}

/**
 * A node's model output failed its schema twice (the first failure is retried once). The task
 * goes to the owner as a failure. `reason` names the schema problem and never quotes model output.
 */
export class PlannerOutputError extends Error {
  constructor(
    readonly node: "planner" | "public_title",
    readonly reason: string,
  ) {
    super(`${node} output invalid: ${reason}`);
    this.name = "PlannerOutputError";
  }
}
