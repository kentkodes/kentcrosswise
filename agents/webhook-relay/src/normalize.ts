// Normalization of the five webhook events the orchestrator App subscribes to (DESIGN §4.1):
// issues, pull_request, pull_request_review, workflow_run, push. The output keeps ids, refs, SHAs
// and states only: no titles, bodies, comments or commit messages (free text written by people).

export const EVENT_NAMES = ["issues", "pull_request", "pull_request_review", "workflow_run", "push"] as const;
export type GitHubEventName = (typeof EVENT_NAMES)[number];

/** Actions forwarded per event; other actions (labeled, assigned, in_progress, ...) are ignored. */
export const FORWARDED_ACTIONS: Readonly<Record<Exclude<GitHubEventName, "push">, readonly string[]>> = {
  issues: ["opened", "edited", "closed", "reopened"],
  pull_request: ["opened", "reopened", "synchronize", "ready_for_review", "converted_to_draft", "closed"],
  pull_request_review: ["submitted", "dismissed"],
  workflow_run: ["requested", "completed"],
};

export interface Sender {
  id: number;
  login: string;
  type: string;
}

export type GitHubEventPayload =
  | { type: "issues"; action: string; issue_number: number; state: string | null; sender: Sender }
  | {
      type: "pull_request";
      action: string;
      pr_number: number;
      merged: boolean;
      draft: boolean;
      head_ref: string | null;
      head_sha: string | null;
      base_ref: string | null;
      sender: Sender;
    }
  | {
      type: "pull_request_review";
      action: string;
      pr_number: number;
      /** `approved`, `changes_requested`, `commented` or `dismissed` (lowercased). */
      review_state: string | null;
      commit_id: string | null;
      sender: Sender;
    }
  | {
      type: "workflow_run";
      action: string;
      run_id: number;
      agent_task_id?: number;
      run_attempt: number | null;
      workflow_path: string | null;
      workflow_name: string | null;
      status: string | null;
      conclusion: string | null;
      trigger: string | null;
      head_branch: string | null;
      head_sha: string | null;
      pr_numbers: number[];
      run_started_at: string | null;
      updated_at: string | null;
      sender: Sender;
    }
  | { type: "push"; ref: string; before: string | null; after: string | null; forced: boolean; sender: Sender };

/** Where the task can be found: a branch name (needs no lookup), else a PR or issue number. */
export interface TaskHint {
  agent_task_id?: number;
  branch?: string;
  pr_number?: number;
  issue_number?: number;
}

export interface Normalized {
  /** `<event>.<action>`, or `push`. */
  event: string;
  head_sha: string | null;
  payload: GitHubEventPayload;
  hint: TaskHint;
}

export type NormalizeResult = { ok: true; value: Normalized } | { ok: false; reason: string };

// ------------------------------------------------------------------ untrusted JSON helpers
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : undefined;
const posInt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : undefined;
const str = (v: unknown, max = 255): string | null => (typeof v === "string" && v.length <= max ? v : null);
const sha = (v: unknown): string | null =>
  typeof v === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v) ? v : null;
const NULL_SHA = /^0+$/;

/** The webhook sender (`sender.id` is the immutable GitHub account id used by the allowlist). */
export function senderOf(payload: unknown): Sender | undefined {
  const s = obj(obj(payload)?.sender);
  const id = posInt(s?.id);
  const login = str(s?.login, 100);
  if (id === undefined || login === null) return undefined;
  return { id, login, type: str(s?.type, 50) ?? "" };
}

/** Same-repository check: a branch name from a fork must not be trusted as a task branch. */
function sameRepo(repo: unknown, base: unknown): boolean {
  const a = posInt(obj(repo)?.id);
  return a !== undefined && a === posInt(obj(base)?.id);
}

const ignored = (reason: string): NormalizeResult => ({ ok: false, reason });

export function normalize(eventName: string, body: unknown): NormalizeResult {
  if (!(EVENT_NAMES as readonly string[]).includes(eventName)) return ignored("event_type");
  const p = obj(body);
  const sender = senderOf(body);
  if (!p || !sender) return ignored("malformed");
  const name = eventName as GitHubEventName;

  if (name === "push") {
    const ref = str(p.ref);
    if (ref === null || !ref.startsWith("refs/heads/")) return ignored("not_a_branch");
    const after = sha(p.after);
    if (p.deleted === true || after === null || NULL_SHA.test(after)) return ignored("branch_deleted");
    return ok("push", after, { type: "push", ref, before: sha(p.before), after, forced: p.forced === true, sender }, {
      branch: ref.slice("refs/heads/".length),
    });
  }

  const action = str(p.action, 50);
  if (action === null || !FORWARDED_ACTIONS[name].includes(action)) return ignored("action");
  const event = `${name}.${action}`;
  const repo = p.repository;

  switch (name) {
    case "issues": {
      const issue = obj(p.issue);
      const n = posInt(issue?.number);
      if (n === undefined) return ignored("malformed");
      return ok(event, null, { type: "issues", action, issue_number: n, state: str(issue?.state, 50), sender }, {
        issue_number: n,
      });
    }
    case "pull_request":
    case "pull_request_review": {
      const pr = obj(p.pull_request);
      const n = posInt(pr?.number);
      if (n === undefined) return ignored("malformed");
      const head = obj(pr?.head);
      const headRef = str(head?.ref);
      const hint: TaskHint = { pr_number: n };
      if (headRef !== null && sameRepo(head?.repo, repo)) hint.branch = headRef;
      if (name === "pull_request") {
        const headSha = sha(head?.sha);
        return ok(
          event,
          headSha,
          {
            type: "pull_request",
            action,
            pr_number: n,
            merged: pr?.merged === true,
            draft: pr?.draft === true,
            head_ref: headRef,
            head_sha: headSha,
            base_ref: str(obj(pr?.base)?.ref),
            sender,
          },
          hint,
        );
      }
      const review = obj(p.review);
      const commit = sha(review?.commit_id);
      const state = str(review?.state, 50);
      return ok(
        event,
        commit,
        {
          type: "pull_request_review",
          action,
          pr_number: n,
          review_state: state === null ? null : state.toLowerCase(),
          commit_id: commit,
          sender,
        },
        hint,
      );
    }
    case "workflow_run": {
      const run = obj(p.workflow_run);
      const id = posInt(run?.id);
      if (id === undefined) return ignored("malformed");
      const prs = Array.isArray(run?.pull_requests) ? run.pull_requests : [];
      const prNumbers = prs.map((x) => posInt(obj(x)?.number)).filter((x): x is number => x !== undefined);
      const headBranch = str(run?.head_branch);
      const headSha = sha(run?.head_sha);
      const hint: TaskHint = {};
      if (headBranch !== null && sameRepo(run?.head_repository, repo)) hint.branch = headBranch;
      if (prNumbers.length > 0) hint.pr_number = prNumbers[0]!;
      const role = /^\.github\/workflows\/agent-(developer|qa|docs|scraper)\.yml$/.exec(str(run?.path) ?? "")?.[1];
      const title = /^(developer|qa|docs|scraper) task ([1-9]\d{0,15})$/.exec(str(run?.display_title, 100) ?? "");
      // Only the two actions the orchestrator records (UNIT3-PLAN §6) become agent-run observations.
      // FORWARDED_ACTIONS already drops every other action above; this keeps the hint scoped even if
      // another workflow_run action is ever forwarded for CI runs (it would then be dropped as no_task).
      if ((action === "requested" || action === "completed") &&
          role && title?.[1] === role && posInt(Number(title[2])) !== undefined &&
          run?.event === "workflow_dispatch" && headBranch === "main" && sameRepo(run?.head_repository, repo)) {
        hint.agent_task_id = Number(title[2]);
      }
      return ok(
        event,
        headSha,
        {
          type: "workflow_run",
          action,
          run_id: id,
          ...(hint.agent_task_id === undefined ? {} : { agent_task_id: hint.agent_task_id }),
          run_attempt: posInt(run?.run_attempt) ?? null,
          workflow_path: str(run?.path),
          workflow_name: str(run?.name, 100),
          status: str(run?.status, 50),
          conclusion: str(run?.conclusion, 50),
          trigger: str(run?.event, 50),
          head_branch: headBranch,
          head_sha: headSha,
          pr_numbers: prNumbers,
          run_started_at: str(run?.run_started_at, 40),
          updated_at: str(run?.updated_at, 40),
          sender,
        },
        hint,
      );
    }
  }
}

function ok(event: string, headSha: string | null, payload: GitHubEventPayload, hint: TaskHint): NormalizeResult {
  return { ok: true, value: { event, head_sha: headSha, payload, hint } };
}
