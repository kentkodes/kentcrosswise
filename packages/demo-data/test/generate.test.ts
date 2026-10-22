import { describe, expect, it } from "vitest";
import { MOOD_METRICS, createRng, generateDemoData, getDemoData } from "../src/index";

describe("createRng", () => {
  it("is deterministic per seed", () => {
    const a = createRng("x");
    const b = createRng("x");
    const c = createRng("y");
    const seqA = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(seqA);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(seqA);
  });

  it("produces v4-shaped uuids and ints in range", () => {
    const r = createRng(1);
    expect(r.uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    for (let i = 0; i < 200; i++) {
      const n = r.int(3, 5);
      expect(n >= 3 && n <= 5).toBe(true);
    }
  });
});

describe("generateDemoData", () => {
  it("same seed = same output", () => {
    expect(generateDemoData({ seed: "s1" })).toEqual(generateDemoData({ seed: "s1" }));
    expect(getDemoData()).toEqual(generateDemoData());
  });

  it("different seed = different output", () => {
    expect(generateDemoData({ seed: "s1" }).contacts).not.toEqual(generateDemoData({ seed: "s2" }).contacts);
  });

  it("has the requested shape", () => {
    const d = generateDemoData({ days: 30, contacts: 5 });
    expect(d.contacts).toHaveLength(5);
    expect(d.diaryEntries).toHaveLength(30);
    expect(d.moods).toHaveLength(30);
    expect(d.socialAccounts).toHaveLength(3);
    expect(d.socialSnapshots).toHaveLength(90);
    expect(new Set(d.contacts.map((c) => c.name)).size).toBe(5);
    const ids = [...d.entries, ...d.contacts, ...d.diaryEntries].map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("mood values respect the DB ranges", () => {
    for (const m of generateDemoData().moods) {
      for (const k of MOOD_METRICS) expect(m[k] >= 0 && m[k] <= 1).toBe(true);
      expect(m.sentiment >= -1 && m.sentiment <= 1).toBe(true);
    }
  });

  it("social snapshots are unique per account and day, with non-negative counts", () => {
    const d = generateDemoData();
    const keys = d.socialSnapshots.map((s) => `${s.accountId}/${s.day}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(d.socialSnapshots.every((s) => s.followers >= 0 && s.views >= 0)).toBe(true);
  });

  it("does not depend on the clock", () => {
    const d = generateDemoData();
    expect(d.entries[0]?.createdAt.startsWith("2026-01-01")).toBe(true);
  });
});
