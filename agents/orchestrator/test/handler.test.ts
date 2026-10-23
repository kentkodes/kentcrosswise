// The SQS record loop (handleRecords) through the task graph's handler, without a database.
// Message validation itself is covered by task-messages.test.ts.
import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index";
import { handleTaskSqsEvent, type TaskGraph } from "../src/graph";

const report = { task_id: 7, agent: "developer", event_type: "pr_opened" };

describe("@kcw/orchestrator", () => {
  it("is importable", () => {
    expect(PACKAGE_NAME).toBe("@kcw/orchestrator");
  });
});

describe("handleTaskSqsEvent (no database)", () => {
  const record = (id: string, body: string, group = "task-7") => ({
    messageId: id,
    body,
    attributes: { MessageGroupId: group },
  });

  it("drops invalid messages without retrying them, and logs no bodies", async () => {
    const lines: string[] = [];
    const graph = {} as TaskGraph; // never reached
    const out = await handleTaskSqsEvent(
      {
        Records: [
          record("m1", "{private"),
          record("m2", JSON.stringify(report), "task-9"),
          record("m3", JSON.stringify({ ...report, event_type: "private-text" })),
        ],
      },
      { graph, log: (l) => lines.push(l) },
    );
    expect(out.batchItemFailures).toEqual([]);
    expect(lines).toEqual([
      "message m1: dropped (message body is not JSON)",
      "message m2: dropped (MessageGroupId does not match the task's thread id)",
      expect.stringMatching(/^message m3: dropped \(/),
    ]);
    expect(lines.join("\n")).not.toContain("private-text");
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
    const out = await handleTaskSqsEvent(
      { Records: [record("m1", JSON.stringify(report)), record("m2", JSON.stringify(report))] },
      { graph, log: (l) => lines.push(l) },
    );
    expect(out.batchItemFailures).toEqual([{ itemIdentifier: "m1" }, { itemIdentifier: "m2" }]);
    expect(calls).toBe(1);
    expect(lines).toEqual(["message m1: failed (Error)"]);
  });
});
