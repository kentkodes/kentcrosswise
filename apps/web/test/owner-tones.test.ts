// Owner console status tones and UTC timestamps (pure helpers used by the Dense UI pages).
import { describe, expect, it } from "vitest";
import { formatUtc } from "../src/app/(owner)/format";
import { approvalTone, taskTone } from "../src/app/(owner)/tones";

describe("taskTone", () => {
  it("is ok while a task is moving or finished", () => {
    for (const status of ["planning", "in_progress", "merged", "done"]) expect(taskTone(status)).toBe("ok");
  });

  it("is warn when a task waits or fails", () => {
    for (const status of ["waiting", "failed"]) expect(taskTone(status)).toBe("warn");
  });

  it("is idle when queued or cancelled, and for an unknown status", () => {
    for (const status of ["queued", "cancelled", "something_new"]) expect(taskTone(status)).toBe("idle");
  });
});

describe("approvalTone", () => {
  it("maps pending to warn, approved to ok and rejected to idle", () => {
    expect(approvalTone("pending")).toBe("warn");
    expect(approvalTone("approved")).toBe("ok");
    expect(approvalTone("rejected")).toBe("idle");
  });

  it("is idle for an unknown status", () => {
    expect(approvalTone("withdrawn")).toBe("idle");
  });
});

describe("formatUtc", () => {
  it("prints the UTC date and time in the owner console form", () => {
    expect(formatUtc("2026-11-11T15:42:09.000Z")).toBe("Nov 11, 15:42 UTC");
  });

  it("reads UTC fields even when the instant falls near midnight", () => {
    expect(formatUtc("2026-01-01T00:05:00.000Z")).toBe("Jan 1, 00:05 UTC");
  });
});
