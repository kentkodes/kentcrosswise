// PL5: the browser-side copy of the public log (D10: public pages cannot import server code). The parser keeps only
// the public shape, and every step line reads in plain words. Synthetic data only.
import { describe, expect, it } from "vitest";
import {
  accuracyLines,
  checksSummary,
  checkText,
  eventWhen,
  hourLabel,
  isMine,
  isProblem,
  parsePublicLog,
  stepText,
  summary,
  type LogCheck,
  type LogRecord,
  type LogStep,
} from "../src/app/(public)/_site/public-log";

const H = "2026-11-18T14:00:00.000Z";
const step = (s: string, extra: Record<string, string | number | boolean> = {}): LogStep => ({ step: s, hour: H, ...extra });
const record = (steps: LogStep[], checks: LogCheck[] = []): LogRecord => ({ id: "r1", capturedHour: H, kind: "todo", text: "t", steps, checks, checksVersion: checks.length ? 1 : null });

describe("parsePublicLog", () => {
  const good = {
    available: true,
    label: "L",
    counts: { published: 1, withheld: 0, awaitingReview: 2 },
    records: [{ id: "a", capturedHour: H, kind: "idea", text: "x", steps: [{ step: "captured", hour: H }], extra: "dropped" }],
  };

  it("keeps the public shape and drops unknown fields", () => {
    const log = parsePublicLog(good);
    expect(log).toEqual({
      available: true,
      label: "L",
      counts: { published: 1, withheld: 0, awaitingReview: 2 },
      accuracy: null,
      records: [{ id: "a", capturedHour: H, kind: "idea", text: "x", steps: [{ step: "captured", hour: H }], checks: [], checksVersion: null }],
      calendar: null,
    });
  });

  it("keeps the demo calendar's link and well-formed events only (PL7)", () => {
    const RID = "11111111-2222-4333-8444-555555555555";
    const ev = (o: Record<string, unknown> = {}) => ({ recordId: RID, title: "Call [Person 1]", allDay: false, start: H, end: "2026-11-18T15:00:00.000Z", ...o });
    const link = "https://calendar.google.com/calendar/embed?src=demo.calendar%40example.com";
    const log = parsePublicLog({
      ...good,
      calendar: { link, events: [ev({ extra: "dropped" }), ev({ recordId: "r1" }), ev({ end: H }), ev({ title: "" }), ev({ allDay: "yes" })] },
    });
    expect(log?.available && log.calendar).toEqual({ link, events: [ev()] });
    const bad = (calendar: unknown) => {
      const l = parsePublicLog({ ...good, calendar });
      return l?.available && l.calendar;
    };
    expect(bad({ link: "https://evil.example/?src=x", events: [] })).toBeNull();
    expect(bad({ link: "https://calendar.google.com/calendar/embed?src=a&b=<x>", events: [] })).toBeNull();
    expect(bad({ link: "javascript:alert(1)", events: [] })).toBeNull();
    expect(bad({ link: null })).toBeNull();
    expect(bad({ link: null, events: [] })).toEqual({ link: null, events: [] });
  });

  it("writes when an event is", () => {
    expect(eventWhen({ allDay: false, start: "2026-12-01T10:00:00.000Z", end: "2026-12-01T11:00:00.000Z" })).toBe("1 Dec 2026, 10:00-11:00 UTC");
    expect(eventWhen({ allDay: true, start: "2026-12-01T00:00:00.000Z", end: "2026-12-02T00:00:00.000Z" })).toBe("1 Dec 2026, all day");
    expect(eventWhen({ allDay: false, start: "2026-12-01T23:00:00.000Z", end: "2026-12-02T01:00:00.000Z" })).toBe("1 Dec 2026, 23:00 UTC to 2 Dec 2026, 01:00 UTC");
  });

  it("skips malformed records and drops non-scalar step fields", () => {
    const log = parsePublicLog({
      ...good,
      records: [
        { id: "a", capturedHour: "not an hour", kind: "idea", text: "x", steps: [] },
        { id: "b", capturedHour: H, kind: "secret", text: "x", steps: [] },
        { id: "c", capturedHour: H, kind: "todo", text: "x", steps: [{ step: "captured", hour: H, nested: { a: 1 } }] },
      ],
    });
    expect(log?.available && log.records).toEqual([{ id: "c", capturedHour: H, kind: "todo", text: "x", steps: [{ step: "captured", hour: H }], checks: [], checksVersion: null }]);
  });

  it("keeps known checks and the version, skips a record with an unknown check, and reads the aggregates", () => {
    const rec = (checks: unknown, checksVersion: unknown = 1) => ({ id: "a", capturedHour: H, kind: "todo", text: "x", steps: [], checks, checksVersion });
    const accuracy = { routes: [{ model: "deepseek-flash", confirmed: 3, corrected: 1 }], links: { confirmed: 2, changed: 1 }, calendar: { added: 1, dismissed: 2 } };
    const log = parsePublicLog({
      ...good,
      accuracy,
      records: [rec([{ check: "derived_rows", result: "pass", extra: 1 }]), rec([{ check: "secret", result: "pass" }]), rec([], 0)],
    });
    expect(log?.available && log.records).toEqual([{ id: "a", capturedHour: H, kind: "todo", text: "x", steps: [], checks: [{ check: "derived_rows", result: "pass" }], checksVersion: 1 }]);
    expect(log?.available && log.accuracy).toEqual(accuracy);
    const bad = parsePublicLog({ ...good, accuracy: { routes: [{ model: "<b>", confirmed: 1, corrected: 0 }], links: { confirmed: 0, changed: 0 }, calendar: { added: 0, dismissed: 0 } } });
    expect(bad?.available && bad.accuracy).toBeNull();
    const noLinks = parsePublicLog({ ...good, accuracy: { routes: [], calendar: { added: 0, dismissed: 0 } } });
    expect(noLinks?.available && noLinks.accuracy).toBeNull();
  });

  it("reads an unavailable reply, and rejects anything else", () => {
    expect(parsePublicLog({ available: false, label: "L", note: "down" })).toEqual({ available: false, label: "L", note: "down" });
    expect(parsePublicLog(null)).toBeNull();
    expect(parsePublicLog({ available: true, label: "L", counts: { published: -1, withheld: 0, awaitingReview: 0 }, records: [] })).toBeNull();
    expect(parsePublicLog({ available: true, counts: {}, records: [] })).toBeNull();
  });
});

describe("step text", () => {
  it.each([
    [step("captured"), "Captured"],
    [step("routed", { kind: "idea", by: "model", confidence: 0.9, model: "deepseek-flash" }), "The model filed it as idea (confidence 0.90, deepseek-flash)"],
    [step("routed", { kind: "todo", by: "owner", guess: "idea" }), "I filed it as todo (the model had guessed idea)"],
    [step("needs_owner", { kind: "diary", confidence: 0.42 }), "The model was unsure (diary, confidence 0.42), so it asked me"],
    [step("route_failed", { code: "spend_cap", attempt: 2 }), "Filing failed: the monthly spend cap was reached (attempt 2)"],
    [step("derived", { kind: "crm_note" }), "Created the contact note"],
    [step("derived", { kind: "todo", moved_from: "idea" }), "Moved the record from idea to todo"],
    [step("contact_linked", { outcome: "linked" }), "Linked the note to the contact it is about"],
    [step("mood_scored", { outcome: "scored" }), "Scored the entry's mood"],
    [step("calendar_suggested", { outcome: "no-zone" }), "No time zone was known, so it made no calendar suggestion"],
    [step("corrected", { from: "idea", to: "todo" }), "I corrected it from idea to todo"],
    [step("confirmed", { kind: "idea" }), "I confirmed how it was filed"],
    [step("contact_chosen", { linked: false }), "I marked it as about no contact"],
    [step("contact_chosen", { linked: true, kept: true }), "I confirmed the linked contact"],
    [step("contact_chosen", { linked: true, kept: false }), "I chose the contact it is about"],
    [step("calendar_added"), "I added the suggested event to my calendar"],
    [step("calendar_dismissed"), "I dismissed the suggested event"],
    [step("route_failed", { code: "<script>", attempt: 1 }), "Filing failed: an unknown error (attempt 1)"],
    [step("mystery"), "An unknown step"],
  ])("%o reads as %s", (s, text) => {
    expect(stepText(s)).toBe(text);
  });

  it("marks problems and my own actions", () => {
    expect(isProblem(step("route_failed", { code: "provider_error", attempt: 1 }))).toBe(true);
    expect(isProblem(step("calendar_suggested", { outcome: "none" }))).toBe(false);
    expect(isMine(step("routed", { kind: "todo", by: "owner" }))).toBe(true);
    expect(isMine(step("routed", { kind: "todo", by: "model" }))).toBe(false);
  });
});

describe("summary", () => {
  it("says how the filing was judged", () => {
    expect(summary(record([step("routed", { kind: "idea", by: "model" }), step("confirmed", { kind: "idea" })]))).toBe("Filed by the model, confirmed");
    expect(summary(record([step("corrected", { from: "idea", to: "todo" })]))).toBe("Corrected: Idea → Todo");
    expect(summary(record([step("needs_owner", { kind: "idea" }), step("routed", { kind: "todo", by: "owner" })]))).toBe("Filed by me");
  });

  it("reports a recovery only when a later step filed the entry", () => {
    const failed = step("route_failed", { code: "provider_error", attempt: 1 });
    expect(summary(record([failed, step("routed", { kind: "idea", by: "model" }), step("confirmed", { kind: "idea" })]))).toBe(
      "Filed by the model, confirmed · Recovered after 1 failed attempt",
    );
    expect(summary(record([step("routed", { kind: "idea", by: "model" }), failed]))).toBe("");
  });
});

describe("checks and accuracy", () => {
  it("reads checks in plain words and sums them up", () => {
    expect(checkText({ check: "usage_recorded", result: "pass" })).toBe("Passed: Every model call has a usage record");
    expect(checkText({ check: "failures_resolved", result: "unresolved" })).toBe("Unresolved: Every failed step was followed by a success");
    expect(checksSummary([])).toBe("");
    expect(checksSummary([{ check: "derived_rows", result: "pass" }])).toBe("The check passed");
    expect(checksSummary([{ check: "derived_rows", result: "pass" }, { check: "body_matches", result: "pass" }])).toBe("All 2 checks passed");
    expect(checksSummary([{ check: "derived_rows", result: "fail" }, { check: "failures_resolved", result: "unresolved" }])).toBe("1 check failed · A failure is unresolved");
    expect(summary(record([step("routed", { kind: "todo", by: "model" }), step("confirmed", { kind: "todo" })], [{ check: "derived_rows", result: "pass" }]))).toBe(
      "Filed by the model, confirmed · The check passed",
    );
  });

  it("writes the aggregate lines, including empty ones", () => {
    expect(accuracyLines({ routes: [], links: { confirmed: 0, changed: 0 }, calendar: { added: 0, dismissed: 0 } })).toEqual([
      "Model filings confirmed: none reviewed yet",
      "Calendar suggestions added: none decided yet",
      "Contact links confirmed: none reviewed yet",
    ]);
    expect(accuracyLines({ routes: [{ model: "deepseek-flash", confirmed: 2, corrected: 1 }, { model: "unknown", confirmed: 1, corrected: 0 }], links: { confirmed: 3, changed: 1 }, calendar: { added: 1, dismissed: 3 } })).toEqual([
      "Model filings confirmed: 2 of 3 (67%), deepseek-flash",
      "Model filings confirmed: 1 of 1 (100%), model not recorded",
      "Calendar suggestions added: 1 of 4",
      "Contact links confirmed: 3 of 4 (75%)",
    ]);
  });
});

describe("hourLabel", () => {
  it("formats the rounded hour in UTC", () => {
    expect(hourLabel(H)).toBe("18 Nov 2026, 14:00 UTC");
    expect(hourLabel("nope")).toBe("");
  });
});
