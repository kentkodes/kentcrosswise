import { describe, expect, it } from "vitest";
import { OfficeRoom } from "../src/office-room";
import { OfficePlayback } from "../src/office-playback";
import { bootstrapFixture, REFS } from "./fixtures/office-contract";
import type { AvailableOffice, OfficeEvent } from "../src/office-contract";
const now = { wallMs: Date.parse("2026-10-25T18:30:00.000Z"), monoMs: 0 };
function setup() { const p = new OfficePlayback(); p.receive(p.request("bootstrap", now)!, bootstrapFixture(), now); const room = new OfficeRoom(); room.reconcile(p.view(now)); return { p, room }; }
function add(p: OfficePlayback, type: OfficeEvent["type"], n: number) {
  const e = bootstrapFixture(), r = p.request("incremental", now)!;
  e.events = [{ ...e.history.replay!.events[2]!, type, ref: `event_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, position: { revision: String(n), ordinal: 0 } }];
  e.revision = String(n); e.history.mode = "incremental"; e.history.replay = null; e.history.from = r.after; e.history.through = e.history.watermark = e.events[0]!.position; e.history.cursor = `cur_OwnRoom_${n}_BindingOnly`;
  expect(p.receive(r, e, now)).toBe("accepted");
}
function finish(p: OfficePlayback, room: OfficeRoom) { const e = p.begin()!; room.reconcile(p.view(now)); room.settle(); room.complete(); p.finish(e.ref); room.reconcile(p.view(now)); }

describe("connected room geometry", () => {
  it("retains known station geometry when inventories become unavailable", () => {
    const { p, room } = setup();
    const view = p.view(now); expect(room.render(view).actors).toContain("dev1");
    view.current!.snapshot.tasks = null; view.current!.snapshot.executions = null;
    room.reconcile(view); expect(room.render(view).actors).toContain("dev1");
    expect(room.render(view).working).toEqual([]);
  });
  it("preserves a completed live merge across historical replay", () => {
    const { p, room } = setup(); add(p, "merged", 11); finish(p, room);
    expect(room.render(p.view(now)).filed).toBe(1);
    p.setMode("replay"); room.reconcile(p.view(now)); expect(room.render(p.view(now)).filed).toBe(0);
    p.setMode("live"); room.reconcile(p.view(now)); expect(room.render(p.view(now)).filed).toBe(1);
  });
  it("paper starts at pickup, moves with actor, and settles without a jump", () => {
    const { p, room } = setup(); add(p, "pr_opened", 11); const event = p.begin()!; room.reconcile(p.view(now));
    let previous = room.render(p.view(now)).packets[0]!.position;
    for (let n = 0; n < 1000; n++) {
      const done = room.tick(1600); const packet = room.render(p.view(now)).packets[0]!.position;
      expect(Math.abs(previous.x - packet.x) + Math.abs(previous.y - packet.y)).toBeLessThanOrEqual(1); previous = packet;
      if (done) break;
    }
    const before = room.render(p.view(now)).packets[0]!.position; room.complete(); p.finish(event.ref);
    expect(room.render(p.view(now)).packets[0]!.position).toEqual(before);
  });
  it("removes cached geometry when completed events become tombstones", () => {
    const { p, room } = setup(); add(p, "approved", 11); finish(p, room);
    expect(room.render(p.view(now)).packets).toHaveLength(1);
    const e: AvailableOffice = bootstrapFixture(); e.privacy_epoch = e.history.privacy_epoch = "3"; e.revision = "12";
    e.snapshot = { tasks: [], executions: [], related_tasks: [], pause: { paused: null, observed_at: null } };
    e.history = { ...e.history, mode: "state", watermark: { revision: "12", ordinal: 0 }, from: null, through: null, cursor: null, replay: null, completeness: "gap", gap: { reason: "deleted", from: null, through: null, recovery: "restart" }, invalidations: [{ task_ref: REFS.health, kind: "delete" }] };
    p.receive(p.request("state", now)!, e, now); room.reconcile(p.view(now));
    expect(room.render(p.view(now)).packets).toHaveLength(0);
  });
  it("tombstones neutralize an active merge immediately", () => {
    const { p, room } = setup(); add(p, "merged", 11); p.begin(); room.reconcile(p.view(now)); room.tick(16);
    const view = p.view(now); view.active = { ref: view.active!.ref, position: view.active!.position, deleted: true }; room.reconcile(view);
    expect(room.render(view).beat.kind).toBe("queued");
    const before = structuredClone(room.scene.positions); room.tick(1000); expect(room.scene.positions).toEqual(before);
  });
});
