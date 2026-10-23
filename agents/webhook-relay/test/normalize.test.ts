import { describe, expect, it } from "vitest";
import { normalize, senderOf, taskIdFromBranch, type NormalizeResult } from "../src/index";
import { IDS, fixture } from "./helpers";

const SHA1 = "1111111111111111111111111111111111111111";
const SHA2 = "2222222222222222222222222222222222222222";

function value(r: NormalizeResult) {
  if (!r.ok) throw new Error(`ignored: ${r.reason}`);
  return r.value;
}

describe("taskIdFromBranch", () => {
  it.each<[string | null | undefined, number | null]>([
    ["kcw/task-42", 42],
    ["task-42", 42],
    ["refs/heads/kcw/task-7", 7],
    ["refs/heads/task-7", 7],
    ["kcw/task-9007199254740991", 9007199254740991],
    ["kcw/task-0", null],
    ["kcw/task-007", null],
    ["kcw/task-", null],
    ["kcw/task-42-fix", null],
    ["kcw/task-42/x", null],
    ["feature/task-42", null],
    ["other/kcw/task-42", null],
    ["refs/tags/task-42", null],
    ["KCW/TASK-42", null],
    ["kcw/task-99999999999999999", null], // beyond a safe integer
    ["main", null],
    ["", null],
    [null, null],
    [undefined, null],
  ])("%j -> %j", (ref, id) => {
    expect(taskIdFromBranch(ref)).toBe(id);
  });
});

describe("normalize: the five event types", () => {
  it("pull_request.opened", () => {
    expect(value(normalize("pull_request", fixture("pull_request.opened")))).toEqual({
      event: "pull_request.opened",
      head_sha: SHA1,
      hint: { pr_number: 12, branch: "kcw/task-42" },
      payload: {
        type: "pull_request",
        action: "opened",
        pr_number: 12,
        merged: false,
        draft: false,
        head_ref: "kcw/task-42",
        head_sha: SHA1,
        base_ref: "main",
        sender: { id: IDS.developer, login: "kcw-developer[bot]", type: "Bot" },
      },
    });
  });

  it("pull_request.closed keeps the merged flag", () => {
    const p = fixture("pull_request.opened");
    p.action = "closed";
    p.pull_request.merged = true;
    const v = value(normalize("pull_request", p));
    expect(v.event).toBe("pull_request.closed");
    expect(v.payload).toMatchObject({ merged: true });
  });

  it("pull_request_review.submitted", () => {
    expect(value(normalize("pull_request_review", fixture("pull_request_review.submitted")))).toEqual({
      event: "pull_request_review.submitted",
      head_sha: SHA2,
      hint: { pr_number: 12, branch: "kcw/task-42" },
      payload: {
        type: "pull_request_review",
        action: "submitted",
        pr_number: 12,
        review_state: "approved",
        commit_id: SHA2,
        sender: { id: IDS.qa, login: "kcw-qa[bot]", type: "Bot" },
      },
    });
  });

  it("workflow_run.completed", () => {
    expect(value(normalize("workflow_run", fixture("workflow_run.completed")))).toEqual({
      event: "workflow_run.completed",
      head_sha: SHA1,
      hint: { branch: "kcw/task-42", pr_number: 12 },
      payload: {
        type: "workflow_run",
        action: "completed",
        run_id: 30000001,
        run_attempt: 1,
        workflow_path: ".github/workflows/ci.yml",
        workflow_name: "ci",
        status: "completed",
        conclusion: "failure",
        trigger: "pull_request",
        head_branch: "kcw/task-42",
        head_sha: SHA1,
        pr_numbers: [12],
        run_started_at: "2026-10-22T10:00:00Z",
        updated_at: "2026-10-22T10:07:30Z",
        sender: { id: IDS.developer, login: "kcw-developer[bot]", type: "Bot" },
      },
    });
  });

  it("issues.closed", () => {
    expect(value(normalize("issues", fixture("issues.closed")))).toEqual({
      event: "issues.closed",
      head_sha: null,
      hint: { issue_number: 11 },
      payload: {
        type: "issues",
        action: "closed",
        issue_number: 11,
        state: "closed",
        sender: { id: IDS.owner, login: "example-owner", type: "User" },
      },
    });
  });

  it("push", () => {
    expect(value(normalize("push", fixture("push")))).toEqual({
      event: "push",
      head_sha: SHA2,
      hint: { branch: "kcw/task-42" },
      payload: {
        type: "push",
        ref: "refs/heads/kcw/task-42",
        before: SHA1,
        after: SHA2,
        forced: false,
        sender: { id: IDS.qa, login: "kcw-qa[bot]", type: "Bot" },
      },
    });
  });

  it("never forwards free text (titles, bodies, review text, commit messages, emails)", () => {
    for (const [name, f] of [
      ["pull_request", "pull_request.opened"],
      ["pull_request_review", "pull_request_review.submitted"],
      ["workflow_run", "workflow_run.completed"],
      ["issues", "issues.closed"],
      ["push", "push"],
    ] as const) {
      const json = JSON.stringify(value(normalize(name, fixture(f))));
      expect(json).not.toMatch(/Synthetic|example\.com|example\.invalid|Closes/);
    }
  });
});

describe("normalize: ignored and defensive cases", () => {
  it.each<[string, (p: Record<string, unknown>) => void, string, string]>([
    ["pull_request", (p) => (p.action = "labeled"), "pull_request.opened", "action"],
    ["pull_request_review", (p) => (p.action = "edited"), "pull_request_review.submitted", "action"],
    ["workflow_run", (p) => (p.action = "in_progress"), "workflow_run.completed", "action"],
    ["issues", (p) => (p.action = "assigned"), "issues.closed", "action"],
    ["issues", (p) => delete p.action, "issues.closed", "action"],
    ["push", (p) => (p.ref = "refs/tags/v1"), "push", "not_a_branch"],
    ["push", (p) => (p.deleted = true), "push", "branch_deleted"],
    ["push", (p) => (p.after = "0".repeat(40)), "push", "branch_deleted"],
    ["pull_request", (p) => delete p.sender, "pull_request.opened", "malformed"],
    ["pull_request", (p) => delete p.pull_request, "pull_request.opened", "malformed"],
    ["issues", (p) => ((p.issue as Record<string, unknown>).number = "11"), "issues.closed", "malformed"],
    ["workflow_run", (p) => ((p.workflow_run as Record<string, unknown>).id = -1), "workflow_run.completed", "malformed"],
  ])("%s with a change -> ignored", (name, edit, f, reason) => {
    const p = fixture(f as Parameters<typeof fixture>[0]);
    edit(p);
    expect(normalize(name, p)).toEqual({ ok: false, reason });
  });

  it("ignores other event types", () => {
    for (const e of ["ping", "issue_comment", "check_run", "installation", "", "push "]) {
      expect(normalize(e, fixture("push"))).toEqual({ ok: false, reason: "event_type" });
    }
  });

  it("ignores a non-object body", () => {
    expect(normalize("push", null)).toEqual({ ok: false, reason: "malformed" });
    expect(normalize("push", [1])).toEqual({ ok: false, reason: "malformed" });
  });

  it("does not trust a branch name from a fork (only the PR number is a hint)", () => {
    const p = fixture("pull_request.opened");
    p.pull_request.head.repo = { id: 2000, full_name: "someone/fork" };
    expect(value(normalize("pull_request", p)).hint).toEqual({ pr_number: 12 });
    const r = fixture("pull_request_review.submitted");
    r.pull_request.head.repo = null;
    expect(value(normalize("pull_request_review", r)).hint).toEqual({ pr_number: 12 });
    const w = fixture("workflow_run.completed");
    w.workflow_run.head_repository.id = 2000;
    expect(value(normalize("workflow_run", w)).hint).toEqual({ pr_number: 12 });
  });

  it("drops malformed SHAs and over-long strings instead of forwarding them", () => {
    const p = fixture("pull_request.opened");
    p.pull_request.head.sha = "not-a-sha";
    p.pull_request.base.ref = "x".repeat(300);
    const v = value(normalize("pull_request", p));
    expect(v.head_sha).toBeNull();
    expect(v.payload).toMatchObject({ head_sha: null, base_ref: null });
  });

  it("workflow_run without PRs or a task branch has an empty hint", () => {
    const w = fixture("workflow_run.completed");
    w.workflow_run.head_branch = "main";
    w.workflow_run.pull_requests = [];
    expect(value(normalize("workflow_run", w)).hint).toEqual({ branch: "main" });
  });

  it("senderOf needs a numeric id and a login", () => {
    expect(senderOf(fixture("push"))).toEqual({ id: IDS.qa, login: "kcw-qa[bot]", type: "Bot" });
    expect(senderOf({ sender: { id: "9000003", login: "x" } })).toBeUndefined();
    expect(senderOf({ sender: { id: 1 } })).toBeUndefined();
    expect(senderOf({})).toBeUndefined();
  });
});
