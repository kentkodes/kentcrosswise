import { describe, expect, it } from "vitest";
import { OfficeRoom, executionActor, executionLabel } from "../src/office-room";
import { OfficePlayback } from "../src/office-playback";
import type { AvailableOffice, OfficeEvent } from "../src/office-contract";
import { bootstrapFixture, REFS } from "./fixtures/office-contract";
const clock = { wallMs: Date.parse("2026-10-25T18:30:00.000Z"), monoMs: 0 };
function setup() {
  const playback = new OfficePlayback();
  playback.receive(playback.request("bootstrap", clock)!, bootstrapFixture(), clock);
  const room = new OfficeRoom(); room.reconcile(playback.view(clock));
  return { playback, room };
}
function enqueue(p: OfficePlayback, type: OfficeEvent["type"], revision: number, task = REFS.health as OfficeEvent["task_ref"], execution = REFS.healthRun as OfficeEvent["execution_ref"]): void {
  const e: AvailableOffice = bootstrapFixture();
  e.events = [{ ref: `event_00000000-0000-4000-8000-${String(revision).padStart(12, "0")}`, position: { revision: String(revision), ordinal: 0 }, recorded_at: e.observed_at, role: execution === REFS.docsRun ? "docs" : "qa", type, task_ref: task, execution_ref: execution, visibility: "public", description: task === REFS.docs ? "Document the health endpoint" : "Add a health endpoint" }];
  const request = p.request("incremental", clock)!;
  e.revision = String(revision); e.history.mode = "incremental"; e.history.replay = null; e.history.from = request.after;
  e.history.through = e.history.watermark = { revision: String(revision), ordinal: 0 };
  e.history.cursor = `cur_RoomQaBinding_${revision}_Only`;
  expect(p.receive(request, e, clock)).toBe("accepted");
}
function complete(p: OfficePlayback, r: OfficeRoom): void {
  const event = p.begin()!; r.reconcile(p.view(clock)); r.settle(); r.complete(); expect(p.finish(event.ref)).toBe(true); r.reconcile(p.view(clock));
}

describe("office room independent review", () => {
  it("does not fabricate Developer seats for unknown assignments", () => {
    const e = bootstrapFixture().snapshot.executions![1]!;
    expect(executionActor({ ...e, assignment: null })).toBeNull();
    expect(executionActor({ ...e, assignment: { station: "developer", seat: 4 } })).toBe("dev4");
    expect(executionActor({ ...e, assignment: { station: "annex", seat: 17 } })).toBe("extra");
    expect(executionLabel({ ...e, assignment: { station: "annex", seat: 17 } })).toBe("Developer · annex seat 17");
  });
  it("does not invent filed packets from a current merged snapshot", () => {
    const { playback, room } = setup();
    expect(room.render(playback.view(clock)).filed).toBe(0);
    expect(room.render(playback.view(clock)).packets).toHaveLength(0);
  });
  it("files only a task's actual merge and keeps Docs/deployment separate", () => {
    const { playback, room } = setup();
    enqueue(playback, "approved", 11); complete(playback, room);
    expect(room.render(playback.view(clock)).filed).toBe(0);
    enqueue(playback, "merged", 12); complete(playback, room);
    expect(room.render(playback.view(clock)).filed).toBe(1);
    enqueue(playback, "coding", 13, REFS.docs, REFS.docsRun); complete(playback, room);
    expect(room.render(playback.view(clock)).filed).toBe(1);
    expect(room.render(playback.view(clock)).packets).toHaveLength(1);
  });
  it("moves each actor at most one native pixel even on a slow frame", () => {
    const { playback, room } = setup();
    enqueue(playback, "merged", 11); playback.begin(); room.reconcile(playback.view(clock));
    for (let n = 0; n < 600; n++) {
      const before = structuredClone(room.scene.positions);
      room.tick(30000);
      for (const actor of Object.keys(before) as (keyof typeof before)[]) {
        const p = room.scene.positions[actor], q = before[actor];
        expect(Math.abs(p.x - q.x) + Math.abs(p.y - q.y)).toBeLessThanOrEqual(1);
      }
    }
  });
  it("whole-scene mode changes clear accumulated packet geometry", () => {
    const { playback, room } = setup();
    enqueue(playback, "merged", 11); complete(playback, room);
    expect(room.render(playback.view(clock)).filed).toBe(1);
    playback.setMode("replay"); room.reconcile(playback.view(clock));
    expect(room.render(playback.view(clock)).filed).toBe(0);
    expect(room.render(playback.view(clock)).packets).toHaveLength(0);
  });
  it("does not infer Developer running from a reported coding event", () => {
    const { playback, room } = setup();
    const working = room.render(playback.view(clock)).working;
    expect(working).not.toContain("dev1");
    expect(working).toContain("docs");
  });
});

