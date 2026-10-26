import { describe, expect, it } from "vitest";
import { SCENARIOS, beatAt, initialClock, next, poseFor, scenePose, tick, walk } from "../src/app/(public)/office/preview/scene";

describe("sample office choreography", () => {
  it("files only merged work, never approved or failed work", () => {
    for (const scenario of Object.values(SCENARIOS)) {
      scenario.beats.forEach((beat, index) => {
        const pose = scenePose(scenario.beats, index, 1);
        expect(pose.filed).toBe(beat.kind === "merged" || beat.kind === "deployed");
      });
    }
    expect(poseFor("merged", 0.5).filed).toBe(false);
    expect(poseFor("approved", 1).paper).toBe("qa");
  });
  it("delivers papers without putting both robots on the same tile", () => {
    const pose = poseFor("pr_opened", 1);
    expect(pose.paper).toBe("qa");
    expect(pose.developer).not.toEqual(pose.qa);
    expect(pose.carrying).toBeUndefined();
    expect(poseFor("pr_opened", 0.5).carrying).toBe("developer");
  });
  it("keeps positions continuous at beat boundaries", () => {
    for (const scenario of Object.values(SCENARIOS)) {
      for (let index = 1; index < scenario.beats.length; index++) {
        const before = scenePose(scenario.beats, index - 1, 1);
        const after = scenePose(scenario.beats, index, 0);
        expect(after.developer, `${scenario.label}: ${beatAt(scenario.beats, index).kind}`).toEqual(before.developer);
        expect(after.qa, `${scenario.label}: ${beatAt(scenario.beats, index).kind}`).toEqual(before.qa);
      }
    }
  });
  it("returns rejected and failing work to Developer without filing it", () => {
    for (const kind of ["changes_requested", "tests_failed"] as const) {
      const halfway = poseFor(kind, 0.5);
      const final = poseFor(kind, 1);
      expect(halfway.carrying).toBe("qa");
      expect(final.paper).toBe("developer");
      expect(final.filed).toBe(false);
      expect(final.developer).not.toEqual(final.qa);
    }
  });
  it("leaves waiting and terminal failure as stopped, unfiled work", () => {
    expect(poseFor("waiting_on_owner", 1)).toMatchObject({ paper: "inbox", filed: false });
    expect(poseFor("failed", 1)).toMatchObject({ filed: false, paper: "developer" });
  });
  it("manual stepping settles poses and restart makes a fresh clock", () => {
    const beats = SCENARIOS.success.beats;
    let clock = initialClock();
    clock = next(clock, beats);
    clock = next(clock, beats);
    expect(clock.index).toBe(2);
    expect(clock.elapsed).toBe(beatAt(beats, 2).duration);
    expect(scenePose(beats, clock.index, 1).carrying).toBeUndefined();
    while (!clock.done) clock = next(clock, beats);
    expect(tick(clock, 100, beats)).toBe(clock);
    expect(initialClock()).toEqual({ index: 0, elapsed: 0, done: false });
  });
  it("moves at a consistent speed around corners and clamps endpoints", () => {
    const path = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 30 }];
    expect(walk(path, 0.5)).toEqual({ x: 10, y: 10 });
    expect(walk(path, -1)).toEqual(path[0]);
    expect(walk(path, 2)).toEqual(path[2]);
  });
});
