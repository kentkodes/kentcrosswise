import { describe, expect, it } from "vitest";
import {
  AGENTS,
  EVENT_TYPES,
  ReportFormatError,
  isAgentName,
  isEventType,
  parseAgentReport,
  threadIdOf,
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

describe("parseAgentReport", () => {
  it("accepts a minimal report and drops unknown fields", () => {
    expect(parseAgentReport({ task_id: 3, agent: "qa", event_type: "approved", extra: "x" })).toEqual({
      task_id: 3,
      agent: "qa",
      event_type: "approved",
    });
  });

  it("keeps valid usage and drops an empty usage list", () => {
    const usage = [
      { kind: "model", provider: "anthropic", model: "claude-haiku-5-5", input_tokens: 10, output_tokens: 0 },
      { kind: "actions_minutes", minutes: 0.5 },
    ];
    expect(parseAgentReport({ task_id: 1, agent: "developer", event_type: "coding", usage }).usage).toEqual(usage);
    expect(parseAgentReport({ task_id: 1, agent: "developer", event_type: "coding", usage: [] })).not.toHaveProperty(
      "usage",
    );
  });

  it("accepts a usage-only report without event_type", () => {
    const usage = [{ kind: "model", provider: "anthropic", model: "claude-haiku-5-5", input_tokens: 10, output_tokens: 2 }];
    const report = parseAgentReport({ task_id: 4, agent: "qa", usage });
    expect(report).toEqual({ task_id: 4, agent: "qa", usage });
    expect(report).not.toHaveProperty("event_type");
  });

  it.each([
    [null, /object/],
    [{ task_id: 1, agent: "qa" }, /event_type, usage, or both/],
    [{ task_id: 1, agent: "qa", usage: [] }, /event_type, usage, or both/],
    [{ task_id: 1, agent: "qa", event_type: null, usage: [{ kind: "actions_minutes", minutes: 1 }] }, /event_type/],
    [{ task_id: "1", agent: "qa", event_type: "approved" }, /task_id/],
    [{ task_id: 1.5, agent: "qa", event_type: "approved" }, /task_id/],
    [{ task_id: 1, agent: "boss", event_type: "approved" }, /agent/],
    [{ task_id: 1, agent: "qa", event_type: "danced" }, /event_type/],
    [{ task_id: 1, agent: "qa", event_type: "approved", usage: {} }, /usage must be an array/],
    [{ task_id: 1, agent: "qa", event_type: "approved", usage: [{ kind: "gpu" }] }, /kind/],
    [{ task_id: 1, agent: "qa", event_type: "approved", usage: [{ kind: "model", provider: "a" }] }, /provider and model/],
    [
      { task_id: 1, agent: "qa", event_type: "approved", usage: [{ kind: "model", provider: "a", model: "m", input_tokens: -1, output_tokens: 1 }] },
      /token counts/,
    ],
    [{ task_id: 1, agent: "qa", event_type: "approved", usage: [{ kind: "actions_minutes", minutes: -2 }] }, /minutes/],
  ])("rejects %j", (input, msg) => {
    expect(() => parseAgentReport(input)).toThrow(ReportFormatError);
    expect(() => parseAgentReport(input)).toThrow(msg);
  });

  it("does not quote the input in errors", () => {
    expect(() => parseAgentReport({ task_id: 1, agent: "secret-ish-value", event_type: "coding" })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("secret-ish-value") }),
    );
  });
});
