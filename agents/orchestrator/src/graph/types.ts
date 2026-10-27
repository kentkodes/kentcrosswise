// Task graph types and limits (P2-10, DESIGN §4.2-§4.3, D20, §11 Q11).
import type { AgentReport } from "@kcw/core/events";

/** Agent workflows the orchestrator dispatches (§4.1). */
export const DEV_WORKFLOW = "agent-developer.yml";
export const QA_WORKFLOW = "agent-qa.yml";
export const DOCS_WORKFLOW = "agent-docs.yml";

/**
 * The `run-name` of an agent-docs.yml run (the workflow sets `run-name: docs task <task_id>`).
 * The dispatch API returns no run id, so the docs sweep finds the run by this title.
 */
export const docsRunName = (taskId: number): string => `docs task ${taskId}`;

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

/** The Developer's branch for a task (Developer playbook; the relay resolves tasks from it). */
export const branchOf = (taskId: number): string => `kcw/task-${taskId}`;

/**
 * Where a task thread is:
 * - `queued`: not started (paused, or the in-flight limit is reached); a sweep retries.
 * - `dev` / `ci` / `qa`: waiting on the Developer, CI or QA.
 * - `merge`: QA approved; waiting for complete merge-rules inputs (Q11).
 * - `owner`: waiting on an approval.
 * - `children`: the planner split the task into subtasks (child tasks with their own threads); a
 *   sweep finishes the parent once every child has ended (§11 Q12).
 * - `done`: merged, failed or cancelled (the thread ends).
 */
export type Phase = "queued" | "dev" | "ci" | "qa" | "merge" | "owner" | "children" | "done";

/** `tasks.waiting_on` (§3.2). */
export type WaitingOn = "dev" | "ci" | "qa" | "owner" | "deploy";

/** Why the thread waits on the owner. */
export type OwnerWait = "issue_text" | "critical" | "failure";

export type DevMode = "implement" | "fix";

/**
 * What approving a failure restarts: the Developer, QA, planning (planner or public-title output
 * invalid), or Docs-keeper (a docs task has no Developer).
 */
export type RetryTarget = "dev" | "qa" | "plan" | "docs";

/** A work task runs the PR loop for owner text; a docs task runs Docs-keeper after a merge (§4.2 step 8). */
export type TaskKind = "work" | "docs";

/** Why the merge step is waiting (Q11). */
export type IncompleteReason = "ci_not_finished" | "head_moved" | "diff_incomplete" | "no_run" | "no_artifact";

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
) & { message_id: string };

/** What processing one input did (logged by the handler; never message content). */
export type StepOutcome =
  | "applied" // the task moved on
  | "stale" // unexpected or outdated input: recorded, the thread waits on as before
  | "unchanged" // a sweep with nothing to do, or a usage-only report
  | "deferred" // agents_paused: kept and processed on unpause
  | "paused" // a sweep while agents_paused
  | "queued"; // not started yet (paused or in-flight limit)

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
}

export interface PlanRequest {
  task_id: number;
  /** Private: never sent to a public surface unsanitized. */
  owner_text: string;
  is_private: boolean;
}

/** The planner and public-title nodes (P2-11: `ModelPlanner` in `@kcw/orchestrator/nodes`; tests use fakes). */
export interface Planner {
  /**
   * Planner node: the task's private text split into 1..MAX_SUBTASKS subtasks, each a private,
   * self-contained description of one PR. Only top-level tasks are split.
   */
  split(req: PlanRequest): Promise<string[]>;
  /** Public-title node: the public title and issue body of one (sub)task. */
  plan(req: PlanRequest): Promise<Plan>;
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
