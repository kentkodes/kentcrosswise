import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ActivitySnapshot } from "../src/app/(public)/_site/activity";

const snapshot = vi.hoisted(() => ({ current: { events: [], status: "loading" } as ActivitySnapshot }));
vi.mock("../src/app/(public)/_site/use-activity", () => ({ useActivity: () => snapshot.current }));

const { RecentActivity, agentLabel } = await import("../src/app/(public)/_home/recent-activity");

function notes(state: ActivitySnapshot): string[] {
  snapshot.current = state;
  const html = renderToStaticMarkup(createElement(RecentActivity));
  return [...html.matchAll(/<p[^>]*>(.*?)<\/p>/g)].map((m) => m[1] ?? "");
}

describe("homepage recent activity notes", () => {
  it("shows one retry note and no empty note when the feed fails with no events", () => {
    expect(notes({ events: [], status: "error" })).toEqual(["Feed unavailable. Retrying shortly."]);
  });

  it("shows the loading and empty-feed notes otherwise", () => {
    expect(notes({ events: [], status: "loading" })).toEqual(["Loading agent activity…"]);
    expect(notes({ events: [], status: "ready" })).toEqual(["No public agent activity yet."]);
  });

  it("shows only the cached note when the feed fails with events", () => {
    const event = { id: 1, ts: "2026-10-25T12:00:00Z", agent: "developer", type: "task_completed", title: "Public task 1" } as ActivitySnapshot["events"][number];
    expect(notes({ events: [event], status: "error" })).toEqual(["Feed unavailable. Cached activity shown."]);
  });
});

describe("homepage recent activity agent label", () => {
  it("spells QA as an acronym and leaves other agents to CSS capitalization", () => {
    expect(agentLabel("qa")).toBe("QA");
    expect(agentLabel("developer")).toBe("developer");
    snapshot.current = { events: [{ id: 2, ts: "2026-10-25T12:00:00Z", agent: "qa", type: "task_completed", title: "Public task 2" }], status: "ready" } as ActivitySnapshot;
    expect(renderToStaticMarkup(createElement(RecentActivity))).toContain(">QA</span>");
  });
});
