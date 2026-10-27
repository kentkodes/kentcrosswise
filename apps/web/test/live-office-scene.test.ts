import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "../src/app/(public)/_site/activity";
import { advanceVignette, beginVignette, motionKind, neutralPose } from "../src/app/(public)/office/live-scene";
import type { Vignette } from "../src/app/(public)/office/live-scene";

const event = (type: string, agent = "developer", id = 1): ActivityEvent => ({ id, ts: "2026-10-26T00:00:00Z", agent, type, title: "Private task" });
function finish(initial: Vignette) {
  let state = initial;
  for (let frame = 0; !state.done && frame < 2000; frame++) {
    const previous = state.pose;
    state = advanceVignette(state, frame % 7 === 0 ? 500 : 1000 / 60);
    for (const role of ["developer", "qa"] as const) {
      const point = state.pose[role];
      expect(Math.abs(point.x - previous[role].x) + Math.abs(point.y - previous[role].y)).toBeLessThanOrEqual(1);
      expect(Number.isInteger(point.x) && Number.isInteger(point.y)).toBe(true);
    }
  }
  expect(state.done).toBe(true);
  return state;
}
describe("independent recorded-event office scenes", () => {
  it("keeps empty, unknown and unrepresented agent events neutral", () => {
    expect(beginVignette().pose).toEqual(neutralPose());
    for (const entry of [event("coding", "docs"), event("coding", "scraper"), event("new_event")]) {
      expect(motionKind(entry)).toBeUndefined();
      expect(finish(beginVignette(entry)).pose).toEqual(neutralPose());
    }
  });
  it("files only an actual merge event and never infers a merge from deployment or approval", () => {
    for (const kind of ["task_assigned", "coding", "pr_opened", "ci_running", "tests_failed", "ci_passed", "qa_reviewing", "changes_requested", "approved", "merged", "deployed", "waiting_on_owner", "failed"]) {
      expect(finish(beginVignette(event(kind))).pose.filed, kind).toBe(kind === "merged");
    }
  });
  it("preserves positions on interruptions and returns through the aisle one pixel at a time", () => {
    let state = beginVignette(event("pr_opened"));
    for (let frame = 0; frame < 180; frame++) state = advanceVignette(state, 1000 / 60);
    const interrupted = beginVignette(event("merged", "orchestrator", 2), state.pose);
    expect(interrupted.pose.developer).toEqual(state.pose.developer);
    expect(interrupted.pose.qa).toEqual(state.pose.qa);
    expect(interrupted.pose.paper).toBe("none");
    expect(finish(interrupted).pose.filed).toBe(true);
  });
  it("starts unrelated events and repeated-ID replay with fresh paper state", () => {
    const entry = event("merged");
    const first = finish(beginVignette(entry));
    const replay = beginVignette(entry, first.pose);
    expect(replay.done).toBe(false);
    expect(replay.phase).toBe("return");
    expect(replay.pose.filed).toBe(false);
    expect(finish(replay).pose.filed).toBe(true);
    const approved = beginVignette(event("approved", "qa", 2), first.pose);
    expect(approved.pose.paper).toBe("none");
    expect(finish(approved).pose.filed).toBe(false);
  });
});
