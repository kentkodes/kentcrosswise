import { describe, expect, it } from "vitest";
import {
  AGENTS,
  EVENT_TYPES,
  ReportFormatError,
  isAgentName,
  isEventType,
  parseAgentReport,
  reportKey,
  threadIdOf,
  usageKey,
} from "../src/events/index";
import * as core from "../src/index";

describe("event types (§4.4)", () => {
  it("lists the 13 office events once", () => {
    expect(EVENT_TYPES).toEqual([
      "task_assigned",
      "coding",
      "pr_opened",
      "ci_running",
      "tests_failed",
      "ci_passed",
      "qa_reviewing",
      "changes_requested",
      "approved",
      "merged",
      "deployed",
      "waiting_on_owner",
      "failed",
    ]);
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });

  it("lists the §3.2 agents", () => {
    expect(AGENTS).toEqual(["orchestrator", "developer", "qa", "scraper", "docs", "router"]);
  });

  it("guards", () => {
    expect(isEventType("merged")).toBe(true);
    expect(isEventType("Merged")).toBe(false);
    expect(isEventType(3)).toBe(false);
    expect(isAgentName("qa")).toBe(true);
    expect(isAgentName("owner")).toBe(false);
  });

  it("is re-exported from @kcw/core", () => {
    expect(core.EVENT_TYPES).toBe(EVENT_TYPES);
    expect(core.parseAgentReport).toBe(parseAgentReport);
  });

  it("thread id is task-<id>", () => {
    expect(threadIdOf(12)).toBe("task-12");
  });
});

const ID = { run_id: 900, run_attempt: 1, job: "end", op: 3 } as const;
const work = (index: number) => ({ job: "work", index }) as const;

describe("parseAgentReport", () => {
  it("accepts a minimal report and drops unknown fields", () => {
    expect(parseAgentReport({ task_id: 3, agent: "qa", ...ID, event_type: "approved", extra: "x" })).toEqual({
      task_id: 3,
      agent: "qa",
      ...ID,
      event_type: "approved",
    });
  });

  it("copies a 64-hex contract hash and rejects anything else", () => {
    const hash = "ab".repeat(32);
    expect(parseAgentReport({ task_id: 3, agent: "qa", ...ID, event_type: "approved", contract: hash }).contract).toBe(hash);
    expect(parseAgentReport({ task_id: 3, agent: "qa", ...ID, event_type: "approved" })).not.toHaveProperty("contract");
    for (const bad of ["AB".repeat(32), "ab".repeat(31), 5, null]) {
      expect(() => parseAgentReport({ task_id: 3, agent: "qa", ...ID, event_type: "approved", contract: bad })).toThrow(ReportFormatError);
    }
  });

  it("keeps valid usage and drops an empty usage list", () => {
    const usage = [
      { kind: "model", provider: "anthropic", model: "claude-haiku-5-5", input_tokens: 10, output_tokens: 0, call: work(0) },
      { kind: "actions_minutes", minutes: 0.5, call: { job: "review", index: 0 } },
    ];
    expect(parseAgentReport({ task_id: 1, agent: "developer", ...ID, event_type: "coding", usage }).usage).toEqual(usage);
    expect(parseAgentReport({ task_id: 1, agent: "developer", ...ID, event_type: "coding", usage: [] })).not.toHaveProperty(
      "usage",
    );
  });

  it("accepts a usage-only report without event_type, and a null op (scraper)", () => {
    const usage = [{ kind: "model", provider: "anthropic", model: "claude-haiku-5-5", input_tokens: 10, output_tokens: 2, call: work(0) }];
    const report = parseAgentReport({ task_id: 4, agent: "qa", ...ID, op: null, usage });
    expect(report).toEqual({ task_id: 4, agent: "qa", ...ID, op: null, usage });
    expect(report).not.toHaveProperty("event_type");
  });

  it("derives report and usage keys from run, attempt and job, not from the model or position alone", () => {
    expect(reportKey(ID)).toBe("report:900:1:end");
    expect(reportKey({ ...ID, job: "start" })).toBe("report:900:1:start");
    expect(reportKey({ ...ID, run_attempt: 2 })).toBe("report:900:2:end"); // a re-run counts separately
    expect(usageKey(ID, work(0))).toBe("report:900:1:work:0");
    expect(usageKey(ID, { job: "review", index: 0 })).toBe("report:900:1:review:0");
    expect(usageKey({ ...ID, run_attempt: 2 }, work(0))).not.toBe(usageKey(ID, work(0)));
  });

  const m = (call: unknown) => ({ kind: "model", provider: "a", model: "m", input_tokens: 1, output_tokens: 1, call });
  it.each([
    [null, /object/],
    [{ task_id: 1, agent: "qa", event_type: "approved" }, /run_id and run_attempt/], // the format before AR2 slice 3
    [{ task_id: 1, agent: "qa", ...ID, run_id: 0, event_type: "approved" }, /run_id/],
    [{ task_id: 1, agent: "qa", ...ID, run_attempt: "1", event_type: "approved" }, /run_attempt/],
    [{ task_id: 1, agent: "qa", ...ID, job: "work", event_type: "approved" }, /job must be/],
    [{ task_id: 1, agent: "qa", ...ID, op: -1, event_type: "approved" }, /op must be/],
    [{ task_id: 1, agent: "qa", ...ID, op: undefined, event_type: "approved" }, /op must be/],
    [{ task_id: 1, agent: "qa", ...ID }, /event_type, usage, or both/],
    [{ task_id: 1, agent: "qa", ...ID, usage: [] }, /event_type, usage, or both/],
    [{ task_id: 1, agent: "qa", ...ID, event_type: null, usage: [{ kind: "actions_minutes", minutes: 1, call: work(0) }] }, /event_type/],
    [{ task_id: "1", agent: "qa", ...ID, event_type: "approved" }, /task_id/],
    [{ task_id: 1.5, agent: "qa", ...ID, event_type: "approved" }, /task_id/],
    [{ task_id: 1, agent: "boss", ...ID, event_type: "approved" }, /agent/],
    [{ task_id: 1, agent: "qa", ...ID, event_type: "danced" }, /event_type/],
    [{ task_id: 1, agent: "qa", ...ID, event_type: "approved", usage: {} }, /usage must be an array/],
    [{ task_id: 1, agent: "qa", ...ID, event_type: "approved", usage: [{ kind: "gpu" }] }, /kind/],
    [{ task_id: 1, agent: "qa", ...ID, event_type: "approved", usage: [{ kind: "model", provider: "a" }] }, /provider and model/],
    [
      { task_id: 1, agent: "qa", ...ID, event_type: "approved", usage: [{ kind: "model", provider: "a", model: "m", input_tokens: -1, output_tokens: 1, call: work(0) }] },
      /token counts/,
    ],
    [{ task_id: 1, agent: "qa", ...ID, event_type: "approved", usage: [{ kind: "actions_minutes", minutes: -2, call: work(0) }] }, /minutes/],
    [{ task_id: 1, agent: "qa", ...ID, event_type: "approved", usage: [m(undefined)] }, /call/],
    [{ task_id: 1, agent: "qa", ...ID, event_type: "approved", usage: [m({ job: "start", index: 0 })] }, /call/],
    [{ task_id: 1, agent: "qa", ...ID, event_type: "approved", usage: [m({ job: "work", index: 100 })] }, /call/],
    [{ task_id: 1, agent: "qa", ...ID, event_type: "approved", usage: [m(work(1)), m(work(1))] }, /distinct/],
  ])("rejects %j", (input, msg) => {
    expect(() => parseAgentReport(input)).toThrow(ReportFormatError);
    expect(() => parseAgentReport(input)).toThrow(msg);
  });

  it("does not quote the input in errors", () => {
    expect(() => parseAgentReport({ task_id: 1, agent: "secret-ish-value", ...ID, event_type: "coding" })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("secret-ish-value") }),
    );
  });
});
