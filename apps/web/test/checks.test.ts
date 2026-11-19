// PL6: the read-back check list, evaluated on facts (pure), and the accuracy aggregates over published step lines.
// Synthetic data only.
import { describe, expect, it } from "vitest";
import { evaluateChecks, type CheckFacts } from "../src/server/checks";
import { accuracyOf, type PublicStep } from "../src/server/public-log";

const CREATED = new Date("2026-11-18T14:30:00.000Z");
const step = (s: string, detail: Record<string, unknown> = {}) => ({ step: s as CheckFacts["steps"][number]["step"], detail });
const facts = (over: Partial<CheckFacts>): CheckFacts => ({
  kind: "idea",
  rawText: "Synthetic idea",
  createdAt: CREATED,
  timeZone: "Europe/London",
  steps: [step("captured"), step("routed", { kind: "idea", by: "model" }), step("derived", { kind: "idea" }), step("confirmed", { kind: "idea" })],
  derived: { crm_note: 0, diary: 0, todo: 0, idea: 1 },
  body: "Synthetic idea",
  note: null,
  suggestion: null,
  moodRow: false,
  usage: { route: 1 },
  ...over,
});
const result = (f: CheckFacts) => Object.fromEntries(evaluateChecks(f).map((c) => [c.check, c.result]));

describe("evaluateChecks", () => {
  it("a clean idea passes derived rows, usage and the body check, with no failure check", () => {
    expect(result(facts({}))).toEqual({ derived_rows: "pass", usage_recorded: "pass", body_matches: "pass" });
  });

  it("fails when a derived row is missing or extra, the usage record is missing, or the body differs", () => {
    expect(result(facts({ derived: { crm_note: 0, diary: 0, todo: 1, idea: 1 }, usage: { route: 0 }, body: "Changed" }))).toEqual({
      derived_rows: "fail",
      usage_recorded: "fail",
      body_matches: "fail",
    });
  });

  it("an agent request has no derived row; an owner-routed entry made no model call, so no usage check", () => {
    const r = result(
      facts({
        kind: "agent_request",
        derived: { crm_note: 0, diary: 0, todo: 0, idea: 0 },
        steps: [step("captured"), step("routed", { kind: "agent_request", by: "owner" })],
        usage: {},
      }),
    );
    expect(r).toEqual({ derived_rows: "pass" });
  });

  it("a failed route followed by a route is resolved; a failure with no later success is unresolved", () => {
    const failed = step("route_failed", { code: "provider_error", attempt: 1 });
    expect(result(facts({ steps: [step("captured"), failed, step("routed", { kind: "idea", by: "model" }), step("derived", { kind: "idea" })] })).failures_resolved).toBe("pass");
    expect(
      result(facts({ kind: "diary", derived: { crm_note: 0, diary: 1, todo: 0, idea: 0 }, steps: [step("routed", { kind: "diary", by: "model" }), step("mood_scored", { outcome: "failed" })] }))
        .failures_resolved,
    ).toBe("unresolved");
  });

  it("a spend-cap failure proves no model call; a provider error does", () => {
    const capped = [step("route_failed", { code: "spend_cap", attempt: 1 }), step("routed", { kind: "idea", by: "owner" })];
    expect(result(facts({ steps: capped, usage: {} }))).not.toHaveProperty("usage_recorded");
    const errored = [step("route_failed", { code: "provider_error", attempt: 1 }), step("routed", { kind: "idea", by: "owner" })];
    expect(result(facts({ steps: errored, usage: {} })).usage_recorded).toBe("fail");
  });

  describe("crm_note", () => {
    const note = (over: Partial<CheckFacts>) =>
      facts({
        kind: "crm_note",
        derived: { crm_note: 1, diary: 0, todo: 0, idea: 0 },
        body: null,
        steps: [
          step("routed", { kind: "crm_note", by: "model" }),
          step("contact_linked", { outcome: "linked" }),
          step("calendar_suggested", { outcome: "created" }),
        ],
        note: { body: "Lunch with Tam on Friday", linkStatus: "linked", names: ["Tamsin Vale", "Tam"] },
        suggestion: { startAt: new Date("2026-11-20T12:00:00.000Z"), allDay: false, timeZone: "Europe/London" },
        usage: { route: 1, calendar: 1 },
        ...over,
      });

    it("passes the link, name (by alias), calendar and start checks", () => {
      expect(result(note({}))).toEqual({
        derived_rows: "pass",
        usage_recorded: "pass",
        link_recorded: "pass",
        link_name: "pass",
        calendar_recorded: "pass",
        calendar_start: "pass",
      });
    });

    it("fails when the linked name is not in the note, a step is missing, or the event starts before capture", () => {
      const r = result(
        note({
          steps: [step("routed", { kind: "crm_note", by: "model" })],
          note: { body: "Lunch on Friday", linkStatus: "linked", names: ["Tamsin Vale"] },
          suggestion: { startAt: new Date("2026-11-18T09:00:00.000Z"), allDay: false, timeZone: "Europe/London" },
        }),
      );
      expect(r).toMatchObject({ link_recorded: "fail", link_name: "fail", calendar_recorded: "fail", calendar_start: "fail" });
    });

    it("an all-day event on the capture's local day passes; the day before fails", () => {
      const tz = "America/New_York"; // capture is 09:30 there on 18 Nov
      const allDay = (iso: string) => result(note({ timeZone: tz, suggestion: { startAt: new Date(iso), allDay: true, timeZone: tz } })).calendar_start;
      expect(allDay("2026-11-18T05:00:00.000Z")).toBe("pass"); // local midnight, 18 Nov
      expect(allDay("2026-11-17T05:00:00.000Z")).toBe("fail");
    });

    it("keeps the name check after the owner kept the automatic link (list v2)", () => {
      expect(result(note({ steps: [step("contact_linked", { outcome: "linked" }), step("contact_chosen", { linked: true, kept: true })] })).link_name).toBe("pass");
    });

    it("leaves out the name check when the owner chose the contact or nothing was linked", () => {
      expect(result(note({ steps: [step("contact_linked", { outcome: "ambiguous" }), step("contact_chosen", { linked: true })] }))).not.toHaveProperty("link_name");
      expect(result(note({ note: { body: "x", linkStatus: "none", names: [] } }))).not.toHaveProperty("link_name");
    });
  });

  describe("diary", () => {
    const diary = (steps: CheckFacts["steps"], moodRow: boolean) =>
      result(facts({ kind: "diary", derived: { crm_note: 0, diary: 1, todo: 0, idea: 0 }, body: null, steps, moodRow, usage: { route: 1, mood: 1 } })).mood_consistent;

    it("a stored score with a scored outcome, or no score with a recorded reason, passes", () => {
      expect(diary([step("mood_scored", { outcome: "scored" })], true)).toBe("pass");
      expect(diary([step("mood_scored", { outcome: "cap" })], false)).toBe("pass");
    });

    it("a score with no scored outcome, a scored outcome with no score, or no outcome at all fails", () => {
      expect(diary([step("mood_scored", { outcome: "failed" })], true)).toBe("fail");
      expect(diary([step("mood_scored", { outcome: "scored" })], false)).toBe("fail");
      expect(diary([], false)).toBe("fail");
    });
  });

  it("skips the body check for a row moved from a diary entry (its body may have been edited)", () => {
    const r = result(facts({ kind: "todo", derived: { crm_note: 0, diary: 0, todo: 1, idea: 0 }, body: "Edited", steps: [step("derived", { kind: "todo", moved_from: "diary" })] }));
    expect(r).not.toHaveProperty("body_matches");
  });
});

describe("accuracyOf", () => {
  const H = "2026-11-18T14:00:00.000Z";
  const s = (step: string, extra: Record<string, string | number | boolean> = {}) => ({ step, hour: H, ...extra }) as PublicStep;

  it("counts each record once by the last verdict after its first model route, per model", () => {
    const a = accuracyOf([
      [s("routed", { kind: "idea", by: "model", model: "deepseek-flash" }), s("confirmed", { kind: "idea" })],
      [s("routed", { kind: "idea", by: "model", model: "deepseek-flash" }), s("confirmed", { kind: "idea" }), s("corrected", { from: "idea", to: "todo" })],
      [s("routed", { kind: "idea", by: "model" }), s("confirmed", { kind: "idea" })],
      [s("routed", { kind: "idea", by: "model", model: "deepseek-flash" })], // no verdict
      [s("needs_owner", { kind: "idea" }), s("routed", { kind: "todo", by: "owner" })], // not a model route
      [s("calendar_suggested", { outcome: "created" }), s("calendar_added")],
      [s("calendar_suggested", { outcome: "created" }), s("calendar_dismissed")],
      [s("calendar_suggested", { outcome: "created" })],
      [s("contact_linked", { outcome: "linked" }), s("contact_chosen", { linked: true, kept: true })],
      [s("contact_linked", { outcome: "linked" }), s("contact_chosen", { linked: true, kept: false })],
      [s("contact_linked", { outcome: "linked" }), s("contact_chosen", { linked: false, kept: false })],
      [s("contact_linked", { outcome: "ambiguous" }), s("contact_chosen", { linked: true, kept: false })], // not an automatic link
      [s("contact_linked", { outcome: "linked" })], // no verdict
    ]);
    expect(a).toEqual({
      routes: [
        { model: "deepseek-flash", confirmed: 1, corrected: 1 },
        { model: "unknown", confirmed: 1, corrected: 0 },
      ],
      links: { confirmed: 1, changed: 2 },
      calendar: { added: 1, dismissed: 1 },
    });
  });
});
