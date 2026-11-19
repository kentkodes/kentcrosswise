// PL5: the browser-side copy of the public log (D10: public pages cannot import server code). The parser keeps only
// the public shape, and every step line reads in plain words. Synthetic data only.
import { describe, expect, it } from "vitest";
import { hourLabel, isMine, isProblem, parsePublicLog, stepText, summary, type LogRecord, type LogStep } from "../src/app/(public)/_site/public-log";

const H = "2026-11-18T14:00:00.000Z";
const step = (s: string, extra: Record<string, string | number | boolean> = {}): LogStep => ({ step: s, hour: H, ...extra });
const record = (steps: LogStep[]): LogRecord => ({ id: "r1", capturedHour: H, kind: "todo", text: "t", steps });

describe("parsePublicLog", () => {
  const good = {
    available: true,
    label: "L",
    counts: { published: 1, withheld: 0, awaitingReview: 2 },
    records: [{ id: "a", capturedHour: H, kind: "idea", text: "x", steps: [{ step: "captured", hour: H }], extra: "dropped" }],
  };

  it("keeps the public shape and drops unknown fields", () => {
    const log = parsePublicLog(good);
    expect(log).toEqual({ available: true, label: "L", counts: { published: 1, withheld: 0, awaitingReview: 2 }, records: [{ id: "a", capturedHour: H, kind: "idea", text: "x", steps: [{ step: "captured", hour: H }] }] });
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
    expect(log?.available && log.records).toEqual([{ id: "c", capturedHour: H, kind: "todo", text: "x", steps: [{ step: "captured", hour: H }] }]);
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

describe("hourLabel", () => {
  it("formats the rounded hour in UTC", () => {
    expect(hourLabel(H)).toBe("18 Nov 2026, 14:00 UTC");
    expect(hourLabel("nope")).toBe("");
  });
});
