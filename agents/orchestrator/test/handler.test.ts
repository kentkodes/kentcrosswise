import { ReportFormatError } from "@kcw/core/events";
import { describe, expect, it } from "vitest";
import { InputError, PACKAGE_NAME, handleSqsEvent, parseMessage, type TaskGraph } from "../src/index";

const report = { task_id: 7, agent: "developer", event_type: "pr_opened" };

describe("@kcw/orchestrator", () => {
  it("is importable", () => {
    expect(PACKAGE_NAME).toBe("@kcw/orchestrator");
  });
});

describe("parseMessage", () => {
  it("accepts task.created in the task's group", () => {
    expect(parseMessage(JSON.stringify({ type: "task.created", task_id: 7 }), "task-7")).toEqual({
      kind: "start",
      task_id: 7,
    });
  });

  it("validates agent reports with parseAgentReport and keeps only known fields", () => {
    const body = JSON.stringify({ ...report, usage: [], extra: "dropped" });
    expect(parseMessage(body, "task-7")).toEqual({ kind: "report", report });
  });

  it("rejects a report that parseAgentReport rejects", () => {
    const body = JSON.stringify({ ...report, event_type: "nope" });
    expect(() => parseMessage(body, "task-7")).toThrow(ReportFormatError);
  });

  it.each([
    ["not JSON", "{", "task-7"],
    ["an array", "[]", "task-7"],
    ["an unknown type", JSON.stringify({ type: "task.deleted", task_id: 7 }), "task-7"],
    ["a bad task id", JSON.stringify({ type: "task.created", task_id: 0 }), "task-0"],
    ["another task's group", JSON.stringify(report), "task-8"],
    ["no group", JSON.stringify(report), undefined],
  ])("rejects %s", (_name, body, group) => {
    expect(() => parseMessage(body, group)).toThrow(InputError);
  });

  it("never quotes the input in errors", () => {
    const secret = "private-owner-text";
    try {
      parseMessage(JSON.stringify({ task_id: 7, agent: secret, event_type: secret }), "task-7");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain(secret);
    }
  });
});

describe("handleSqsEvent (no database)", () => {
  const record = (id: string, body: string, group = "task-7") => ({
    messageId: id,
    body,
    attributes: { MessageGroupId: group },
  });

  it("drops invalid messages without retrying them, and logs no bodies", async () => {
    const lines: string[] = [];
    const graph = {} as TaskGraph; // never reached
    const out = await handleSqsEvent(
      { Records: [record("m1", "{private"), record("m2", JSON.stringify(report), "task-9")] },
      { graph, log: (l) => lines.push(l) },
    );
    expect(out.batchItemFailures).toEqual([]);
    expect(lines).toEqual([
      "message m1: dropped (message body is not JSON)",
      "message m2: dropped (MessageGroupId does not match the task's thread id)",
    ]);
  });

  it("returns transient failures, and every later message, as batch item failures (FIFO order)", async () => {
    let calls = 0;
    const graph = {
      getState: async () => {
        calls++;
        throw new Error("connection refused postgres://user:pw@host/db");
      },
    } as unknown as TaskGraph;
    const lines: string[] = [];
    const out = await handleSqsEvent(
      { Records: [record("m1", JSON.stringify(report)), record("m2", JSON.stringify(report))] },
      { graph, log: (l) => lines.push(l) },
    );
    expect(out.batchItemFailures).toEqual([{ itemIdentifier: "m1" }, { itemIdentifier: "m2" }]);
    expect(calls).toBe(1);
    expect(lines.join("\n")).not.toContain("postgres://");
  });
});
