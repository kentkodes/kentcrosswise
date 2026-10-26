import { describe, expect, it } from "vitest";
import { BEATS, PEOPLE, TASKS, actorTask, currentBeat, inFlight, initialScene, nextEvent, taskStates, tick } from "../src/app/(public)/office/draft/scene";
import type { Actor } from "../src/app/(public)/office/draft/scene";

describe("connected fictional office", () => {
  it("plays every transition in order, never moves more than one pixel and finishes on slow frames", () => {
    let scene = initialScene();
    const visited = [scene.index];
    for (let frame = 0; !scene.done && frame < 30000; frame++) {
      const before = scene;
      scene = tick(scene, frame % 7 ? 1000 / 60 : 5000);
      expect(scene.index - before.index).toBeLessThanOrEqual(1);
      for (const actor of Object.keys(PEOPLE) as Actor[]) {
        const distance = Math.abs(scene.positions[actor].x - before.positions[actor].x) + Math.abs(scene.positions[actor].y - before.positions[actor].y);
        expect(distance).toBeLessThanOrEqual(1);
      }
      if (scene.index !== visited.at(-1)) visited.push(scene.index);
      expect(inFlight(scene)).toBeLessThanOrEqual(4);
    }
    expect(scene.done).toBe(true);
    expect(visited).toEqual(BEATS.map((_, i) => i));
  });
  it("retains independent task state through rework and files only each task’s completed merge", () => {
    let scene = initialScene();
    let previous = taskStates(scene);
    while (!scene.done) {
      scene = nextEvent(scene);
      const states = taskStates(scene);
      const beat = currentBeat(scene.index);
      for (const key of Object.keys(TASKS) as (keyof typeof TASKS)[]) {
        if (key !== beat.task) expect(states[key]).toEqual(previous[key]);
        if (states[key].filed && !previous[key].filed) expect(beat).toMatchObject({ task: key, kind: "merged" });
      }
      if (beat.kind === "approved") expect(states[beat.task].filed).toBe(false);
      if (beat.kind === "deployed") expect(states.guide.filed).toBe(false);
      previous = states;
    }
    expect(previous.source.filed).toBe(false);
    expect(previous.approval.filed).toBe(false);
    expect(previous.health.filed).toBe(true);
    expect(previous.guide.filed).toBe(true);
  });
  it("starts Docs only after the parent merge, and starts the annex after a slot frees", () => {
    expect(BEATS.findIndex((beat) => beat.task === "guide")).toBeGreaterThan(BEATS.findIndex((beat) => beat.task === "health" && beat.kind === "merged"));
    expect(BEATS.findIndex((beat) => beat.task === "annex")).toBeGreaterThan(BEATS.findIndex((beat) => beat.task === "navigation" && beat.kind === "merged"));
    let scene = initialScene();
    while (!scene.done) { expect(inFlight(scene)).toBeLessThanOrEqual(4); scene = nextEvent(scene); }
    expect(actorTask(scene, "docs")).toBe("guide");
    expect(actorTask(scene, "dev3")).toBeUndefined();
  });
  it("requires a fresh check/review sequence for every approval", () => {
    BEATS.forEach((beat, index) => {
      if (beat.kind !== "approved") return;
      const history = BEATS.slice(0, index).filter((entry) => entry.task === beat.task);
      expect(history.at(-1)?.kind).toBe("reviewing");
      expect(history.at(-2)?.kind).toBe("ci_passed");
      expect(history.at(-3)?.kind).toBe("ci_running");
    });
  });
  it("manual Next settles one next event per click while automatic merges wait for illustration completion", () => {
    const first = nextEvent(initialScene());
    expect(first.index).toBe(1);
    expect(first.settled).toBe(true);
    const second = nextEvent(first);
    expect(second.index).toBe(2);
    expect(second.settled).toBe(true);
    let scene = initialScene();
    while (currentBeat(scene.index + 1).kind !== "merged") scene = nextEvent(scene);
    const enteringMerge = tick(scene, 16);
    expect(currentBeat(enteringMerge.index).kind).toBe("merged");
    expect(taskStates(enteringMerge).navigation.filed).toBe(false);
    expect(taskStates(nextEvent(scene)).navigation.filed).toBe(true);
  });
});
