import { describe, expect, it } from "vitest";
import { OfficePlayback, type OfficeClock, type PlaybackRequest } from "../src/office-playback";
import type { AvailableOffice } from "../src/office-contract";
import { bootstrapFixture, officeFixture } from "./fixtures/office-contract";

const base = Date.parse("2026-10-25T18:30:00.000Z");
const clock = (ms = 0): OfficeClock => ({ wallMs: base + ms, monoMs: ms });
const stateEnvelope = (ms = 0): AvailableOffice => {
  const e = officeFixture();
  e.observed_at = new Date(base + ms).toISOString();
  e.events = [];
  e.history = { ...e.history, mode: "state", from: null, through: null, cursor: null };
  return e;
};
function initialized(): OfficePlayback {
  const p = new OfficePlayback();
  const r = p.request("bootstrap", clock())!;
  expect(p.receive(r, bootstrapFixture(), clock())).toBe("accepted");
  return p;
}
function nextPage(): AvailableOffice {
  const e = officeFixture();
  const event = e.events[2]!;
  e.revision = "11";
  e.observed_at = new Date(base + 1000).toISOString();
  e.events = [{ ...event, ref: "event_12345678-1234-4123-8123-123456789abc", position: { revision: "11", ordinal: 0 } }];
  e.history = { ...e.history, from: { revision: "10", ordinal: 2 }, through: { revision: "11", ordinal: 0 }, watermark: { revision: "11", ordinal: 0 }, cursor: "cur_QaNextPageBindingForTestsOnly_v1" };
  return e;
}

describe("office playback independent review", () => {
  it("does not repopulate old generation labels after detecting a replacement", () => {
    const p = initialized();
    const old = p.request("state", clock(100))!;
    const detect = p.request("state", clock(200))!;
    const e = stateEnvelope(200);
    e.generation = "gen_12345678-1234-4123-8123-123456789abc";
    e.history.generation = e.generation;
    expect(p.receive(detect, e, clock(200))).toBe("gap");
    expect(p.view(clock(200)).current).toBeNull();
    p.receive(old, stateEnvelope(300), clock(300));
    expect(p.view(clock(300)).current).toBeNull();
    expect(JSON.stringify(p.view(clock(300)))).not.toContain("Add a health endpoint");
  });

  it("keeps a replay illustration out of a scene labeled live", () => {
    const p = initialized();
    p.setMode("replay");
    const active = p.begin()!;
    const r = p.request("incremental", clock(1000))!;
    expect(p.receive(r, nextPage(), clock(1000))).toBe("accepted");
    const view = p.view(clock(1000));
    expect(view.mode === "live" && view.active?.ref === active.ref).toBe(false);
  });

  it("rejects old epoch data after a state invalidation", () => {
    const p = initialized();
    const old = p.request("state", clock(100))!;
    const r = p.request("state", clock(200))!;
    const e = stateEnvelope(200);
    e.privacy_epoch = e.history.privacy_epoch = "3";
    e.history.gap = { reason: "privacy_changed", from: null, through: null, recovery: "restart" };
    e.history.completeness = "gap";
    expect(p.receive(r, e, clock(200))).toBe("gap");
    expect(p.receive(old, stateEnvelope(300), clock(300))).toBe("ignored");
    expect(p.view(clock(300)).epoch).toBe("3");
  });

  it("does not freshen a repeated cached observation", () => {
    const p = initialized();
    const r = p.request("state", clock(29000))!;
    expect(p.receive(r, stateEnvelope(), clock(29000))).toBe("accepted");
    expect(p.view(clock(30000)).freshness).toBe("stale");
  });

  it("clones views and preserves source execution observation time", () => {
    const p = initialized();
    const a = p.view(clock());
    a.current!.snapshot.tasks![0]!.description = "Changed by caller";
    expect(p.view(clock()).current!.snapshot.tasks![0]!.description).toBe("Add a health endpoint");
    const oldTime = p.view(clock()).current!.snapshot.executions![0]!.observation!.observed_at;
    p.receive(p.request("state", clock(1000))!, stateEnvelope(1000), clock(1000));
    expect(p.view(clock(1000)).current!.snapshot.executions![0]!.observation!.observed_at).toBe(oldTime);
  });

  it("invalidates outstanding request session on explicit restart", () => {
    const p = initialized();
    const r: PlaybackRequest = p.request("state", clock(100))!;
    p.restart();
    expect(p.receive(r, stateEnvelope(200), clock(200))).toBe("ignored");
    expect(p.view(clock(200)).history).toBe("partial");
  });
});

describe("office playback request and freshness races", () => {
  it("can still bootstrap after a current-state response wins the initial race", () => {
    const p = new OfficePlayback();
    const bootstrap = p.request("bootstrap", clock())!;
    const state = p.request("state", clock())!;
    p.receive(state, stateEnvelope(), clock());
    p.receive(bootstrap, bootstrapFixture(), clock());
    const view = p.view(clock());
    expect(view.history === "initialized" || p.request("bootstrap", clock()) !== null).toBe(true);
  });

  it("does not label a new future-dated snapshot fresh using an old observation", () => {
    const p = initialized();
    const r = p.request("state", clock(1000))!;
    const e = stateEnvelope(60000);
    e.revision = e.history.watermark.revision = "11";
    p.receive(r, e, clock(1000));
    const view = p.view(clock(1000));
    expect(view.current?.revision === "11" && view.freshness === "fresh").toBe(false);
  });

  it("does not downgrade newer successful state after an earlier request fails late", () => {
    const p = initialized();
    const old = p.request("state", clock(100))!;
    const latest = p.request("state", clock(200))!;
    p.receive(latest, stateEnvelope(300), clock(300));
    p.fail(old);
    expect(p.view(clock(300)).availability).toBe("available");
  });
});

const healthRef = "task_355a7bfa-0a9b-432a-8c63-b13ea0f5d841" as const;
function manyPage(request: PlaybackRequest, count: number, first: number): AvailableOffice {
  const e = nextPage();
  const sample = e.events[0]!;
  e.events = Array.from({ length: count }, (_, i) => ({ ...sample, ref: `event_00000000-0000-4000-8000-${String(first + i).padStart(12, "0")}` as const, execution_ref: null, position: { revision: String(first + i), ordinal: 0 } }));
  e.revision = String(first + count - 1);
  e.history.from = request.after;
  e.history.through = e.history.watermark = { revision: e.revision, ordinal: 0 };
  e.history.cursor = `cur_QaManyPage_${first}_${count}_BindingOnly`;
  return e;
}
function privacyChange(kind: "redact" | "relabel" | "delete", epoch: string): AvailableOffice {
  const e = stateEnvelope(1000);
  e.revision = e.history.watermark.revision = "300";
  e.privacy_epoch = e.history.privacy_epoch = epoch;
  e.snapshot = { tasks: kind === "delete" ? [] : [{ ref: healthRef, kind: "work", state: "in_progress", waiting_on: null, paused: false, role: "developer", execution_ref: null, visibility: kind === "redact" ? "private" : "public", description: kind === "redact" ? "Private task" : "Revised public description" }], executions: [], related_tasks: [], pause: { paused: false, observed_at: e.observed_at } };
  e.history.completeness = "gap";
  e.history.gap = { reason: kind === "delete" ? "deleted" : "privacy_changed", from: null, through: null, recovery: kind === "delete" ? "restart" : "rebind" };
  e.history.invalidations = [{ task_ref: healthRef, kind }];
  return e;
}

describe("office playback privacy at exact capacity", () => {
  it("redacts then relabels and deletes all256 positions without evicting transitions", () => {
    const p = initialized();
    let first = 11;
    for (const count of [50, 50, 50, 50, 6, 50]) {
      const r = p.request("incremental", clock(1000))!;
      expect(r).not.toBeNull();
      expect(p.receive(r, manyPage(r, count, first), clock(1000))).toBe("accepted");
      first += count;
    }
    const before = p.view(clock(1000));
    expect(before.pending).toHaveLength(256);
    expect(p.request("incremental", clock(1000))).toBeNull();
    const positions = before.pending.map(e => e.position);
    for (const [kind, epoch] of [["redact", "3"], ["relabel", "4"], ["delete", "5"]] as const) {
      expect(p.receive(p.request("state", clock(1000))!, privacyChange(kind, epoch), clock(1000))).toBe("gap");
      const view = p.view(clock(1000));
      expect(view.pending.map(e => e.position)).toEqual(positions);
      expect(view.pending).toHaveLength(256);
      if (kind === "redact") {
        expect(JSON.stringify(view)).not.toContain("Add a health endpoint");
        expect(view.pending.every(e => "description" in e && e.description === "Private task")).toBe(true);
      } else if (kind === "relabel") {
        expect(view.pending.every(e => "description" in e && e.description === "Revised public description")).toBe(true);
      } else {
        expect(view.pending.every(e => "deleted" in e && Object.keys(e).length === 3)).toBe(true);
        expect(JSON.stringify(view)).not.toContain("Revised public description");
      }
    }
  });
});

describe("office playback latest refresh outcome", () => {
  it("keeps a newer failed refresh visible when an older request succeeds late", () => {
    const p = initialized();
    const old = p.request("state", clock(100))!;
    const latest = p.request("state", clock(200))!;
    p.fail(latest);
    p.receive(old, stateEnvelope(100), clock(300));
    expect(p.view(clock(300)).availability).toBe("unavailable");
  });
});
