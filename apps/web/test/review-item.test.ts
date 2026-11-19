// PL3 review row markup: the public text with tappable words (placeholders are not buttons), a withheld reason with
// "Find names again" only where a new check can help, "Correct", and the shared route picker. Synthetic text.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ReviewItem } from "../src/server/review";

vi.mock("@/server/capture", async () => await import("../src/server/capture"));
vi.mock("../src/app/(owner)/hub/actions", () => ({
  addTermAction: async () => undefined,
  changeContactAction: async () => undefined,
  confirmAction: async () => undefined,
  findNamesAction: async () => undefined,
  reassignAction: async () => undefined,
  routeAgainAction: async () => undefined,
}));

const { ReviewEntry } = await import("../src/app/(owner)/hub/review-item");

const base: Omit<ReviewItem, "preview"> = {
  id: "11111111-1111-4111-8111-111111111111",
  createdAt: "2026-11-18T09:00:00.000Z",
  rawText: "Tea with Quinn at Mill Lane",
  routeKind: "crm_note",
};
const render = (preview: ReviewItem["preview"], routing = true) =>
  renderToStaticMarkup(createElement(ReviewEntry, { e: { ...base, preview }, routing }));

describe("ReviewEntry", () => {
  it("a contact note shows its contact, the picker with the current contact selected, and what Correct confirms", () => {
    const link = { noteId: "22222222-2222-4222-8222-222222222222", contactId: "33333333-3333-4333-8333-333333333333", contactName: "Quinn Ash", status: "linked" as const, confirmsLink: true };
    const contacts = [{ id: link.contactId, name: "Quinn Ash" }, { id: "44444444-4444-4444-8444-444444444444", name: "Rhea Moss" }];
    const html = renderToStaticMarkup(createElement(ReviewEntry, { e: { ...base, preview: { state: "pending" }, link }, routing: true, contacts }));
    expect(html).toContain("Contact: Quinn Ash Correct also confirms this contact.");
    expect(html).toContain(`<option value="${link.contactId}" selected="">Quinn Ash</option>`);
    expect(html).toContain('<option value="">No contact</option>');
    expect(html).toContain(">Change contact</button>");
    const unlinked = renderToStaticMarkup(
      createElement(ReviewEntry, { e: { ...base, preview: { state: "pending" }, link: { ...link, contactId: null, contactName: null, status: "none", confirmsLink: false } }, routing: true, contacts }),
    );
    expect(unlinked).toContain("No contact linked.");
    expect(unlinked).not.toContain("Correct also confirms");
  });

  it("shows the public text with each word as a button and placeholders as plain text", () => {
    const html = render({ state: "ready", text: "Tea with [Person 1] at [place]" });
    expect(html).toContain('data-field="public-text"');
    expect(html).toMatch(/<button[^>]*>Tea<\/button>/);
    expect(html).not.toMatch(/<button[^>]*>\[Person 1\]<\/button>/);
    expect(html).toContain("[place]");
    expect(html).toContain("Tap a word to replace it.");
    expect(html).toContain(">Correct</button>");
    expect(html).toContain("CRM note");
    expect(html).toContain("Change route");
    expect(html).not.toContain("Find names again");
  });

  it("offers Find names again for a failed check, not for another person's private matters", () => {
    expect(render({ state: "withheld", reason: "timeout" })).toContain("Find names again");
    const priv = render({ state: "withheld", reason: "private-other" });
    expect(priv).toContain("stays private");
    expect(priv).not.toContain("Find names again");
    expect(render({ state: "pending" })).toContain("Names not checked yet.");
  });

  it("hides Find names again where no model is configured", () => {
    expect(render({ state: "pending" }, false)).not.toContain("Find names again");
  });

  it("escapes the text: nothing is rendered as HTML", () => {
    const html = render({ state: "ready", text: "<b>bold</b>" });
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;");
  });
});
