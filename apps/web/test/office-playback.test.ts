import { describe, expect, it } from "vitest";
import { OfficePlayback, type OfficeClock, type PlaybackRequest } from "../src/office-playback";
import { parseOfficeEnvelope, type AvailableOffice, type OfficeEvent } from "../src/office-contract";
import { bootstrapFixture, REFS, unavailableFixture } from "./fixtures/office-contract";
const base = Date.parse("2026-10-25T18:30:00.000Z");
const clock = (ms = 0): OfficeClock => ({ wallMs: base + ms, monoMs: ms });
function bootstrap(): AvailableOffice { const e = bootstrapFixture(); e.snapshot = { tasks: null, executions: null, related_tasks: null, pause: { paused: null, observed_at: null } }; return e; }
function start(): OfficePlayback { const p = new OfficePlayback(); expect(p.receive(p.request("bootstrap", clock())!, bootstrap(), clock())).toBe("accepted"); return p; }
function page(req: PlaybackRequest, count = 1, startAt = 11): AvailableOffice {
  const e = bootstrap();
  e.history.mode = "incremental"; e.history.replay = null; e.history.from = req.after;
  e.events = Array.from({ length: count }, (_, i): OfficeEvent => ({ ref: `event_00000000-0000-4000-8000-${String(startAt + i).padStart(12, "0")}`, position: { revision: String(startAt + i), ordinal: 0 }, recorded_at: e.observed_at, role: "developer", type: "coding", task_ref: REFS.health, execution_ref: null, visibility: "public", description: "Add a health endpoint" }));
  e.history.through = e.events.at(-1)?.position ?? req.after;
  e.history.watermark = e.history.through!; e.revision = e.history.watermark.revision;
  e.history.cursor = `cur_Synthetic_${startAt}_${count}_BindingOnly`;
  return e;
}
function state(epoch = "2", revision = "20"): AvailableOffice { const e = bootstrap(); e.privacy_epoch = epoch; e.history.privacy_epoch = epoch; e.revision = revision; e.history.mode = "state"; e.history.from = null; e.history.through = null; e.history.cursor = null; e.history.watermark = { revision, ordinal: 0 }; e.history.replay = null; return e; }
function valid(e: AvailableOffice) { expect(parseOfficeEnvelope(e)).toMatchObject({ ok: true }); return e; }

describe("office playback", () => {
  it("rewinds only completed replay position while preserving live truth and pause", () => {
    const p = start();
    expect(p.rewindReplay()).toBe(false);
    const r = p.request("incremental", clock())!; p.receive(r, page(r), clock());
    expect(p.rewindReplay()).toBe(false);
    const live = p.begin()!; p.finish(live.ref);
    p.setMode("replay"); const replay = p.begin()!;
    expect(p.rewindReplay()).toBe(false); p.finish(replay.ref);
    p.setPaused(true); const before = p.view(clock());
    expect(p.rewindReplay()).toBe(true);
    const after = p.view(clock());
    expect(after).toEqual({ ...before, replay: { ...before.replay, index: 0, illustrated: null } });
    expect(p.begin()).toBeNull(); p.setPaused(false);
    expect(p.begin()!.ref).toBe(replay.ref);
  });
  it("keeps delivery, illustration and latest state independent", () => {
    const p = start(); const r = p.request("incremental", clock())!;
    expect(p.receive(r, valid(page(r, 2)), clock())).toBe("accepted");
    const sr = p.request("state", clock())!;
    expect(p.receive(sr, valid(state()), clock())).toBe("accepted");
    expect(p.view(clock())).toMatchObject({ received: { revision: "12" }, illustrated: null, current: { revision: "20" }, pending: [{ position: { revision: "11" } }, { position: { revision: "12" } }] });
    const active = p.begin()!; expect(p.begin()).toBeNull();
    p.setPaused(true); expect(p.finish(active.ref)).toBe(false);
    p.setPaused(false); expect(p.finish(active.ref)).toBe(true);
    expect(p.view(clock())).toMatchObject({ illustrated: { revision: "11" }, pending: [{ position: { revision: "12" } }] });
  });
  it("preserves every queued event while full and keeps polling state", () => {
    const p = start();
    for (let n = 0; n < 5; n++) { const r = p.request("incremental", clock())!; expect(p.receive(r, valid(page(r, 50, 11 + n * 50)), clock())).toBe("accepted"); }
    expect(p.view(clock()).pending).toHaveLength(250); expect(p.request("incremental", clock())).toBeNull();
    expect(p.request("state", clock())).not.toBeNull();
    expect(p.view(clock()).received).toEqual({ revision: "260", ordinal: 0 });
  });
  it("accepts needed older delivery pages without regressing state", () => {
    const p = start(), r = p.request("incremental", clock())!;
    p.receive(p.request("state", clock())!, valid(state("2", "100")), clock());
    p.receive(r, valid(page(r)), clock());
    expect(p.view(clock())).toMatchObject({ current: { revision: "100" }, received: { revision: "11" }, pending: [{ position: { revision: "11" } }] });
  });
  it("ignores reverse and duplicate cursor chains including same revision ordinals", () => {
    const p = start(), a = p.request("incremental", clock())!, b = p.request("incremental", clock())!;
    const e = page(a, 2); e.events[0]!.position = { revision: "11", ordinal: 0 }; e.events[1]!.position = { revision: "11", ordinal: 1 };
    e.revision = "11"; e.history.through = { revision: "11", ordinal: 1 }; e.history.watermark = { revision: "11", ordinal: 1 };
    expect(p.receive(a, valid(e), clock())).toBe("accepted"); expect(p.receive(b, e, clock())).toBe("ignored");
    expect(p.view(clock()).pending).toHaveLength(2);
  });
  it("redacts queue, active, log and replay then rejects an older epoch", () => {
    const p = start(), r = p.request("incremental", clock())!;
    p.receive(r, page(r, 3), clock()); const a = p.begin()!; p.finish(a.ref); p.begin();
    const old = p.request("incremental", clock())!; const redaction = state("3");
    redaction.history.completeness = "gap"; redaction.history.gap = { reason: "privacy_changed", from: null, through: null, recovery: "rebind" };
    redaction.history.invalidations = [{ task_ref: REFS.health, kind: "redact" }];
    expect(p.receive(p.request("state", clock())!, valid(redaction), clock())).toBe("gap");
    expect(JSON.stringify(p.view(clock()))).not.toContain("Add a health endpoint");
    expect(p.view(clock()).pending).toHaveLength(1);
    expect(p.receive(old, page(old, 1, 14), clock())).toBe("ignored");
    expect(p.request("incremental", clock())!.rebind).toBe(true);
  });
  it("suppresses all labels when privacy restart omits invalidations", () => {
    const p = start(), r = p.request("incremental", clock())!; p.receive(r, page(r), clock());
    const e = state("3"); e.history.completeness = "gap"; e.history.gap = { reason: "privacy_changed", from: null, through: null, recovery: "restart" };
    p.receive(p.request("state", clock())!, valid(e), clock());
    expect(p.view(clock()).pending[0]).toEqual({ ref: page(r).events[0]!.ref, position: { revision: "11", ordinal: 0 }, deleted: true });
    expect(p.request("incremental", clock())).toBeNull(); const old = p.request("state", clock())!;
    p.restart(); expect(p.view(clock()).history).toBe("partial"); expect(p.receive(old, e, clock())).toBe("ignored");
  });
  it("never resets freshness on cached timestamps and accounts for transit", () => {
    const p = start(); expect(p.view(clock()).freshness).toBe("fresh");
    p.receive(p.request("state", clock(20000))!, state(), clock(20000));
    expect(p.view(clock(30000)).freshness).toBe("stale");
    const late = state(); late.observed_at = new Date(base + 31000).toISOString();
    p.receive(p.request("state", clock(30000))!, late, clock(70000));
    expect(p.view(clock(70000)).freshness).toBe("stale");
    p.receive(p.request("state", clock(71000))!, unavailableFixture(), clock(71000));
    expect(p.view(clock(71000))).toMatchObject({ freshness: "unavailable", current: { revision: "20" } });
  });
  it("does not establish freshness from future observations", () => {
    const p = new OfficePlayback(), e = bootstrap(); e.observed_at = new Date(base + 100).toISOString();
    p.receive(p.request("bootstrap", clock())!, e, clock()); expect(p.view(clock()).freshness).toBe("unknown");
  });
  it("retains original replay timestamps and interrupted position when live arrives", () => {
    const p = start(); expect(p.setMode("replay")).toBe(true); const first = p.begin()!;
    expect("recorded_at" in first && first.recorded_at).toBe("2026-10-25T18:20:00.000Z");
    p.finish(first.ref); const r = p.request("incremental", clock())!; p.receive(r, page(r), clock());
    expect(p.view(clock())).toMatchObject({ mode: "live", replay: { index: 1, completeness: "partial" } });
    const live = p.begin()!; p.finish(live.ref); expect(p.setMode("replay")).toBe(true);
    expect(p.begin()!.position).toEqual({ revision: "10", ordinal: 1 });
  });
  it("retains missing range and queued transitions until explicit recovery", () => {
    const p = start(), r = p.request("incremental", clock())!; p.receive(r, page(r), clock());
    const e = state(); e.history.completeness = "gap"; e.history.gap = { reason: "cursor_unavailable", from: { revision: "11", ordinal: 0 }, through: { revision: "19", ordinal: 0 }, recovery: "restart" };
    p.receive(p.request("state", clock())!, valid(e), clock()); expect(p.view(clock())).toMatchObject({ gap: e.history.gap, pending: [{ position: { revision: "11" } }] });
  });
  it("returns independent copies so a room cannot mutate retained history", () => {
    const p = start(), value = p.view(clock()); value.replay.events.length = 0;
    expect(p.view(clock()).replay.events).toHaveLength(3);
  });
});
