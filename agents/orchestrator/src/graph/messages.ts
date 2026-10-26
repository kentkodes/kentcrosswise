// Queue messages for the task graph (D5: everything arrives on orchestrator-in). All are untrusted
// and validated here; the FIFO group must be the task's thread id. Error messages never quote input.
//
//   {type:"task.created", task_id}                                       console (§4.2 step 1)
//   {type:"owner.decision", task_id, thread_id, resume:{approval_id, decision}}   inbox (§4.3)
//   {type:"sweep", task_id, thread_id}                                   sweeper (§4.3, P2-17)
//   {source:"github", delivery_id, task_id, thread_id, resume:{event, head_sha, payload}}   relay (P2-05)
//   {task_id, agent, event_type?, usage?} (event, usage, or both)       kcw-report (P2-03)
import { parseAgentReport, threadIdOf } from "@kcw/core/events";
import { InputError } from "../handler";
import type { GitHubInput, TaskInput } from "./types";

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ACTION = /^[a-z_]{1,50}$/;

function taskIdOf(x: Obj): number {
  if (!isPosInt(x.task_id)) throw new InputError("task_id must be a positive integer");
  return x.task_id;
}

/** Messages that carry thread_id must name the task's own thread. */
function checkThread(x: Obj, taskId: number): void {
  if (x.thread_id !== threadIdOf(taskId)) throw new InputError("thread_id does not match task_id");
}

const strOrNull = (v: unknown, max = 255): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || v.length > max) throw new InputError("malformed github payload");
  return v;
};
const shaOrNull = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || !SHA.test(v)) throw new InputError("malformed github payload");
  return v;
};
const action = (v: unknown): string => {
  if (typeof v !== "string" || !ACTION.test(v)) throw new InputError("malformed github payload");
  return v;
};
const prNumber = (v: unknown): number => {
  if (!isPosInt(v)) throw new InputError("malformed github payload");
  return v;
};

/** The relay's normalized payload (agents/webhook-relay/src/normalize.ts), reduced to what the graph reads. */
function parseGitHubPayload(p: unknown): GitHubInput {
  if (!isObject(p)) throw new InputError("malformed github payload");
  switch (p.type) {
    case "pull_request":
      return {
        kind: "github",
        event: "pull_request",
        action: action(p.action),
        pr_number: prNumber(p.pr_number),
        head_ref: strOrNull(p.head_ref),
        head_sha: shaOrNull(p.head_sha),
        merged: p.merged === true,
      };
    case "pull_request_review":
      return {
        kind: "github",
        event: "pull_request_review",
        action: action(p.action),
        pr_number: prNumber(p.pr_number),
        review_state: strOrNull(p.review_state, 50),
        commit_id: shaOrNull(p.commit_id),
      };
    case "workflow_run": {
      if (!Array.isArray(p.pr_numbers) || !p.pr_numbers.every(isPosInt)) throw new InputError("malformed github payload");
      return {
        kind: "github",
        event: "workflow_run",
        action: action(p.action),
        run_id: prNumber(p.run_id),
        ...(p.agent_task_id === undefined ? {} : { agent_task_id: prNumber(p.agent_task_id) }),
        run_attempt: p.run_attempt == null ? null : prNumber(p.run_attempt),
        head_branch: strOrNull(p.head_branch),
        run_started_at: strOrNull(p.run_started_at, 40),
        updated_at: strOrNull(p.updated_at, 40),
        workflow_path: strOrNull(p.workflow_path),
        conclusion: strOrNull(p.conclusion, 50),
        trigger: strOrNull(p.trigger, 50),
        head_sha: shaOrNull(p.head_sha),
        pr_numbers: [...p.pr_numbers],
      };
    }
    case "issues":
      return { kind: "github", event: "issues", action: action(p.action) };
    case "push":
      return { kind: "github", event: "push", action: "push" };
    default:
      throw new InputError("unknown github payload type");
  }
}

/**
 * Parses one queue message for the task graph. `messageId` is the SQS message id (the same on a
 * redelivery), kept so a redelivered message is not applied twice.
 */
export function parseTaskMessage(body: string, groupId: string | undefined, messageId: string): { task_id: number; input: TaskInput } {
  let x: unknown;
  try {
    x = JSON.parse(body);
  } catch {
    throw new InputError("message body is not JSON");
  }
  if (!isObject(x)) throw new InputError("message must be a JSON object");

  let taskId: number;
  let input: TaskInput;
  if (x.type === "task.created") {
    taskId = taskIdOf(x);
    input = { kind: "start", message_id: messageId };
  } else if (x.type === "owner.decision") {
    taskId = taskIdOf(x);
    checkThread(x, taskId);
    const r = x.resume;
    if (!isObject(r) || typeof r.approval_id !== "string" || !UUID.test(r.approval_id)) {
      throw new InputError("resume.approval_id must be a uuid");
    }
    if (r.decision !== "approved" && r.decision !== "rejected") {
      throw new InputError("resume.decision must be approved or rejected");
    }
    input = { kind: "decision", approval_id: r.approval_id.toLowerCase(), decision: r.decision, message_id: messageId };
  } else if (x.type === "sweep") {
    taskId = taskIdOf(x);
    checkThread(x, taskId);
    input = { kind: "sweep", message_id: messageId };
  } else if (x.type === undefined && x.source === "github") {
    taskId = taskIdOf(x);
    checkThread(x, taskId);
    if (typeof x.delivery_id !== "string" || x.delivery_id.length === 0 || x.delivery_id.length > 100) {
      throw new InputError("delivery_id must be a string");
    }
    if (!isObject(x.resume)) throw new InputError("resume must be an object");
    input = { ...parseGitHubPayload(x.resume.payload), message_id: messageId };
  } else if (x.type === undefined && x.source === undefined) {
    const report = parseAgentReport(x);
    taskId = report.task_id;
    input = { kind: "report", report, message_id: messageId };
  } else {
    throw new InputError("unknown message type");
  }

  if (groupId !== threadIdOf(taskId)) throw new InputError("MessageGroupId does not match the task's thread id");
  return { task_id: taskId, input };
}
