// parseTaskMessage: every queue message the task graph accepts, validated like agent reports.
import { ReportFormatError } from "@kcw/core/events";
import { describe, expect, it } from "vitest";
import { InputError } from "../src/index";
import { parseTaskMessage } from "../src/graph";

const APPROVAL = "5eed0000-0000-4000-8000-000000000001";
const HEAD = "a".repeat(40);
const SENDER = { id: 1, login: "bot", type: "Bot" };
const parse = (body: unknown, group = "task-7") => parseTaskMessage(JSON.stringify(body), group, "msg-1");
const decision = (resume: unknown, extra: Record<string, unknown> = {}) => ({
  type: "owner.decision",
  task_id: 7,
  thread_id: "task-7",
  resume,
  ...extra,
});
const github = (payload: unknown, extra: Record<string, unknown> = {}) => ({
  source: "github",
  delivery_id: "d1",
  task_id: 7,
  thread_id: "task-7",
  resume: { event: "x", head_sha: HEAD, payload },
  ...extra,
});

describe("parseTaskMessage", () => {
  it("task.created, sweep and agent reports", () => {
    expect(parse({ type: "task.created", task_id: 7 })).toEqual({ task_id: 7, input: { kind: "start", message_id: "msg-1" } });
    expect(parse({ type: "sweep", task_id: 7, thread_id: "task-7" })).toEqual({ task_id: 7, input: { kind: "sweep", message_id: "msg-1" } });
    expect(parse({ task_id: 7, agent: "developer", event_type: "coding", extra: 1 })).toEqual({
      task_id: 7,
      input: { kind: "report", report: { task_id: 7, agent: "developer", event_type: "coding" }, message_id: "msg-1" },
    });
    expect(() => parse({ task_id: 7, agent: "nobody", event_type: "coding" })).toThrow(ReportFormatError);
  });

  it("never lets a queue message start a docs task (the orchestrator builds that start itself)", () => {
    for (const docs of [{ pr: 41 }, true]) {
      expect(parse({ type: "task.created", task_id: 7, docs })).toEqual({ task_id: 7, input: { kind: "start", message_id: "msg-1" } });
      expect(parse({ type: "task.created", task_id: 7, kind: "start", docs, resume: { docs } })).toEqual({
        task_id: 7,
        input: { kind: "start", message_id: "msg-1" },
      });
    }
  });

  it("owner.decision from the console", () => {
    expect(parse(decision({ approval_id: APPROVAL.toUpperCase(), decision: "approved" }))).toEqual({
      task_id: 7,
      input: { kind: "decision", approval_id: APPROVAL, decision: "approved", message_id: "msg-1" },
    });
  });

  it.each([
    ["no resume", decision(undefined)],
    ["a non-uuid approval id", decision({ approval_id: "1; DROP TABLE x", decision: "approved" })],
    ["an unknown decision", decision({ approval_id: APPROVAL, decision: "maybe" })],
    ["another task's thread", decision({ approval_id: APPROVAL, decision: "approved" }, { thread_id: "task-8" })],
    ["a bad task id", decision({ approval_id: APPROVAL, decision: "approved" }, { task_id: -7 })],
    ["a sweep for another thread", { type: "sweep", task_id: 7, thread_id: "task-8" }],
    ["an unknown type", { type: "task.deleted", task_id: 7 }],
    ["an unknown source", { source: "gitlab", task_id: 7 }],
  ])("rejects owner and sweep messages with %s", (_name, body) => {
    expect(() => parse(body)).toThrow(InputError);
  });

  it("rejects a message in another task's FIFO group", () => {
    expect(() => parse(decision({ approval_id: APPROVAL, decision: "approved" }), "task-8")).toThrow(InputError);
    expect(() => parseTaskMessage(JSON.stringify({ type: "task.created", task_id: 7 }), undefined, "msg-1")).toThrow(InputError);
  });

  it("relay events keep only the fields the graph reads", () => {
    expect(
      parse(
        github({
          type: "pull_request",
          action: "opened",
          pr_number: 3,
          merged: false,
          draft: false,
          head_ref: "kcw/task-7",
          head_sha: HEAD,
          base_ref: "main",
          sender: SENDER,
        }),
      ).input,
    ).toEqual({ kind: "github", event: "pull_request", action: "opened", pr_number: 3, head_ref: "kcw/task-7", head_sha: HEAD, merged: false, message_id: "msg-1" });
    expect(
      parse(github({ type: "pull_request_review", action: "submitted", pr_number: 3, review_state: "approved", commit_id: HEAD, sender: SENDER })).input,
    ).toMatchObject({ event: "pull_request_review", review_state: "approved", commit_id: HEAD });
    expect(
      parse(
        github({
          type: "workflow_run",
          action: "completed",
          run_id: 9,
          workflow_path: ".github/workflows/ci.yml",
          conclusion: "success",
          trigger: "pull_request",
          head_sha: HEAD,
          pr_numbers: [3],
          sender: SENDER,
        }),
      ).input,
    ).toMatchObject({ event: "workflow_run", run_id: 9, conclusion: "success", pr_numbers: [3] });
    expect(parse(github({ type: "push", ref: "refs/heads/x", sender: SENDER })).input).toMatchObject({ event: "push" });
  });

  it.each([
    ["no payload", github(undefined)],
    ["an unknown payload type", github({ type: "star", action: "created" })],
    ["a bad sha", github({ type: "pull_request", action: "opened", pr_number: 3, head_sha: "nope" })],
    ["a bad pr number", github({ type: "pull_request", action: "opened", pr_number: 0, head_sha: HEAD })],
    ["bad pr_numbers", github({ type: "workflow_run", action: "completed", run_id: 1, pr_numbers: ["3"] })],
    ["a bad action", github({ type: "issues", action: "Opened Now" })],
    ["no delivery id", github({ type: "push" }, { delivery_id: "" })],
    ["another task's thread", github({ type: "push" }, { thread_id: "task-8" })],
  ])("rejects relay messages with %s", (_name, body) => {
    expect(() => parse(body)).toThrow(InputError);
  });

  it("never quotes the input in errors", () => {
    const secret = "private-owner-text";
    for (const body of [decision({ approval_id: secret, decision: secret }), github({ type: secret })]) {
      try {
        parse(body);
        expect.unreachable();
      } catch (err) {
        expect((err as Error).message).not.toContain(secret);
      }
    }
  });
});
