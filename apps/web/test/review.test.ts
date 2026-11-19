// PL3 owner review: the span proposal stored per entry, the exact public text, the list awaiting review, "Correct",
// owner-added replacements, and the verdict steps for contact choices and calendar decisions. PGlite and
// FakeProvider only; synthetic names and text.
import type { PGlite } from "@electric-sql/pglite";
import { FakeProvider } from "@kcw/core/models";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pieces } from "../src/app/(owner)/hub/public-pieces";
import { addSuggestionToCalendar, dismissSuggestion } from "../src/server/calendar";
import { saveEntry } from "../src/server/capture";
import { createContact, resolveCrmNote } from "../src/server/contacts";
import { runAs } from "../src/server/db";
import { addOwnerTerm, confirmEntry, countAwaitingReview, listAwaitingReview, prepareSpans, publicPreview } from "../src/server/review";
import { reassignEntryDerived, routeEntry, type DbRun } from "../src/server/router";
import { listSteps } from "../src/server/steps";
import { freshDb, pglitePool } from "./pglite";

const spans = (people: string[], places: string[] = [], privateOther = false) =>
  new FakeProvider({ complete: { text: JSON.stringify({ people, places, private_other: privateOther }) } });
const routeAs = (label: string, confidence = 0.95) => new FakeProvider({ classify: { label, confidence } });

describe("owner review (web_rw on PGlite)", () => {
  let pg: PGlite;
  const run: DbRun = (fn) => runAs(pglitePool(pg), "web_rw", fn);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const capture = (text: string) => run((db) => saveEntry(db, text));
  const awaiting = async () => (await run((db) => listAwaitingReview(db))).map((r) => r.id);
  const item = async (id: string) => (await run((db) => listAwaitingReview(db))).find((r) => r.id === id);
  const types = async (id: string) => (await run((db) => listSteps(db, id))).map((s) => s.step);
  /** A captured entry routed by the model to `kind`, with a stored span proposal. */
  const routed = async (text: string, kind = "idea", provider = spans([])) => {
    const id = await capture(text);
    await routeEntry(run, id, routeAs(kind));
    await prepareSpans(run, id, provider);
    return id;
  };

  beforeAll(async () => {
    pg = await freshDb();
    await run((db) => createContact(db, { name: "Orla Brine", aliases: ["Orlie"], howKnown: null, birthday: null, notes: null, tags: [] }));
  });
  afterAll(async () => {
    await pg.close();
  });

  it("stores the proposal and shows the public text: contacts, proposed people and places replaced", async () => {
    const id = await routed("Lunch with Orla Brine and Tamsin at Cafe Lune, mail me at a@b.example", "idea", spans(["Tamsin"], ["Cafe Lune"]));
    const r = await item(id);
    expect(r?.preview).toEqual({ state: "ready", text: "Lunch with [Person 1] and [Person 2] at [place], mail me at [email]" });
  });

  it("keeps a valid proposal (no second call) and replaces a failed one, keeping the owner's terms", async () => {
    const id = await routed("Note about Tamsin", "idea", new FakeProvider({ complete: new TypeError("down") }));
    expect((await item(id))?.preview).toEqual({ state: "withheld", reason: "failed" });
    await expect(run((db) => addOwnerTerm(db, id, "Note", "person"))).resolves.toBe("not-ready");
    await expect(prepareSpans(run, id, spans(["Tamsin"]))).resolves.toBe("ok");
    await expect(run((db) => addOwnerTerm(db, id, "Note", "place"))).resolves.toBe("ok");
    const again = new FakeProvider({ complete: { text: "{}" } });
    await expect(prepareSpans(run, id, again)).resolves.toBe("kept");
    expect((await item(id))?.preview).toEqual({ state: "ready", text: "[place] about [Person 1]" });
  });

  it("withholds another person's private matters and an unusable reply", async () => {
    const a = await routed("Synthetic private matter", "idea", spans([], [], true));
    const b = await routed("Synthetic odd reply", "idea", new FakeProvider({ complete: { text: "not json" } }));
    expect((await item(a))?.preview).toEqual({ state: "withheld", reason: "private-other" });
    expect((await item(b))?.preview).toEqual({ state: "withheld", reason: "invalid" });
  });

  it("shows an entry without a proposal as pending", () => {
    expect(publicPreview("text", null, [])).toEqual({ state: "pending" });
  });

  it("lists only routed entries captured with steps that the owner has not reviewed", async () => {
    const model = await routed("Awaits review");
    const asked = await capture("Low confidence");
    await routeEntry(run, asked, routeAs("idea", 0.2));
    const old = (await pg.query<{ id: string }>("INSERT INTO entries (source, raw_text, route_kind, status, routed_by) VALUES ('web', 'before the log', 'idea', 'routed', 'model') RETURNING id")).rows[0]!.id;
    const ids = await awaiting();
    expect(ids).toContain(model);
    expect(ids).not.toContain(asked); // needs_owner: the inbox asks first
    expect(ids).not.toContain(old); // older than the public log (no captured step)
    await run((db) => reassignEntryDerived(db, asked, "todo")); // the owner's choice is a review
    expect(await awaiting()).not.toContain(asked);
  });

  it("Correct writes one confirmed step; a second Correct is 'already'; a correction also counts as reviewed", async () => {
    const id = await routed("Confirm me");
    const before = await run((db) => countAwaitingReview(db));
    await expect(run((db) => confirmEntry(db, id))).resolves.toBe("ok");
    await expect(run((db) => confirmEntry(db, id))).resolves.toBe("already");
    expect((await run((db) => listSteps(db, id))).at(-1)).toMatchObject({ step: "confirmed", detail: { kind: "idea" } });
    expect(await run((db) => countAwaitingReview(db))).toBe(before - 1);
    expect(await awaiting()).not.toContain(id);

    const moved = await routed("Move me");
    await run((db) => reassignEntryDerived(db, moved, "todo"));
    expect(await awaiting()).not.toContain(moved);
    await expect(run((db) => confirmEntry(db, moved))).resolves.toBe("already");
  });

  it("Correct refuses an entry that is not awaiting review", async () => {
    const asked = await capture("Needs the owner");
    await routeEntry(run, asked, routeAs("idea", 0.2));
    await expect(run((db) => confirmEntry(db, asked))).resolves.toBe("not-found");
    await expect(run((db) => confirmEntry(db, "00000000-0000-4000-8000-000000000000"))).resolves.toBe("not-found");
  });

  it("adds only words that occur in the entry, once, up to the limit", async () => {
    const id = await routed("Walked past Wendle Square");
    await expect(run((db) => addOwnerTerm(db, id, "Wendle Square", "place"))).resolves.toBe("ok");
    await expect(run((db) => addOwnerTerm(db, id, "wendle square", "place"))).resolves.toBe("exists");
    await expect(run((db) => addOwnerTerm(db, id, "Elsewhere", "person"))).resolves.toBe("invalid");
    await expect(run((db) => addOwnerTerm(db, id, "Wend", "person"))).resolves.toBe("invalid"); // not a whole word
    await expect(run((db) => addOwnerTerm(db, id, "  ", "person"))).resolves.toBe("invalid");
    await expect(run((db) => addOwnerTerm(db, id, 7, "person"))).resolves.toBe("invalid");
    expect((await item(id))?.preview).toEqual({ state: "ready", text: "Walked past [place]" });
    await pg.query("UPDATE entry_public SET owner_people = array_fill('x'::text, ARRAY[50]) WHERE entry_id = $1", [id]);
    await expect(run((db) => addOwnerTerm(db, id, "Walked", "person"))).resolves.toBe("full");
  });

  it("records the contact choice and the calendar decisions as verdict steps on the entry", async () => {
    const id = await capture("Saw Orla Brine and Orlie Gant");
    await routeEntry(run, id, new FakeProvider({ classify: { label: "crm_note", confidence: 0.95 } }));
    const note = (await pg.query<{ id: string }>("SELECT id FROM crm_notes WHERE entry_id = $1", [id])).rows[0]!.id;
    await expect(run((db) => resolveCrmNote(db, note, null))).resolves.toBe("ok");

    const sug = async () =>
      (await pg.query<{ id: string }>("INSERT INTO calendar_suggestions (title, start_at, crm_note_id) VALUES ('t', now() + interval '1 day', $1) ON CONFLICT (crm_note_id) WHERE crm_note_id IS NOT NULL DO UPDATE SET status = 'pending' RETURNING id", [note])).rows[0]!.id;
    const dismissed = await sug();
    await expect(run((db) => dismissSuggestion(db, dismissed))).resolves.toBe(true);
    await expect(run((db) => dismissSuggestion(db, dismissed))).resolves.toBe(false); // no second verdict
    const added = await sug();
    const deps = { accessToken: async () => "token", fetch: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch };
    await expect(addSuggestionToCalendar(run, added, deps)).resolves.toBe("added");

    const steps = await run((db) => listSteps(db, id));
    const verdicts = steps.filter((s) => ["contact_chosen", "calendar_dismissed", "calendar_added"].includes(s.step));
    expect(verdicts.map((s) => [s.step, s.detail])).toEqual([
      ["contact_chosen", { note_id: note, linked: false, kept: false }],
      ["calendar_dismissed", { suggestion_id: dismissed }],
      ["calendar_added", { suggestion_id: added }],
    ]);
    expect(await types(id)).toContain("routed");
  });
});

describe("contact-link verdicts (PL6b)", () => {
  let pg: PGlite;
  const run: DbRun = (fn) => runAs(pglitePool(pg), "web_rw", fn);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const contactId = async (name: string) => (await pg.query<{ id: string }>("SELECT id FROM contacts WHERE name = $1", [name])).rows[0]!.id;
  const noteOf = async (entry: string) => (await pg.query<{ id: string }>("SELECT id FROM crm_notes WHERE entry_id = $1", [entry])).rows[0]!.id;
  const chosen = async (entry: string) =>
    (await run((db) => listSteps(db, entry))).filter((s) => s.step === "contact_chosen").map((s) => s.detail);
  const note = async (text: string) => {
    const id = await run((db) => saveEntry(db, text));
    await routeEntry(run, id, routeAs("crm_note"));
    await prepareSpans(run, id, spans([]));
    return id;
  };
  const item = async (id: string) => (await run((db) => listAwaitingReview(db))).find((r) => r.id === id);

  beforeAll(async () => {
    pg = await freshDb();
    for (const name of ["Bram Tull", "Cleo Varn"]) {
      await run((db) => createContact(db, { name, aliases: [], howKnown: null, birthday: null, notes: null, tags: [] }));
    }
  });
  afterAll(async () => {
    await pg.close();
  });

  it("the review row shows an automatic link, and Correct confirms it as a kept contact", async () => {
    const id = await note("Coffee with Bram Tull");
    expect((await item(id))!.link).toEqual({ noteId: await noteOf(id), contactId: await contactId("Bram Tull"), contactName: "Bram Tull", status: "linked", confirmsLink: true });
    await run((db) => confirmEntry(db, id));
    expect(await chosen(id)).toEqual([{ note_id: await noteOf(id), linked: true, kept: true }]);
  });

  it("changing the contact first is a changed verdict, and Correct then adds no second one", async () => {
    const id = await note("Walk with Bram Tull");
    const [n1, cleo] = [await noteOf(id), await contactId("Cleo Varn")];
    await run((db) => resolveCrmNote(db, n1, cleo));
    expect((await item(id))!.link).toMatchObject({ contactName: "Cleo Varn", confirmsLink: false });
    await run((db) => confirmEntry(db, id));
    expect(await chosen(id)).toEqual([{ note_id: await noteOf(id), linked: true, kept: false }]);
  });

  it("keeping the same contact in the picker counts as kept; a note with no link gets no verdict from Correct", async () => {
    const kept = await note("Lunch with Bram Tull");
    const [n2, bram] = [await noteOf(kept), await contactId("Bram Tull")];
    await run((db) => resolveCrmNote(db, n2, bram));
    expect(await chosen(kept)).toEqual([{ note_id: await noteOf(kept), linked: true, kept: true }]);

    const none = await note("Lunch with nobody known");
    expect((await item(none))!.link).toMatchObject({ status: "none", contactId: null, confirmsLink: false });
    await run((db) => confirmEntry(db, none));
    expect(await chosen(none)).toEqual([]);
  });

  it("only contact notes carry link info", async () => {
    const id = await run((db) => saveEntry(db, "Synthetic idea"));
    await routeEntry(run, id, routeAs("idea"));
    expect(await item(id)).not.toHaveProperty("link");
  });
});

describe("public text pieces", () => {
  it("splits words, placeholders and the rest; placeholders are not words", () => {
    expect(pieces("Hi [Person 1], it's at [place]!")).toEqual([
      { kind: "word", value: "Hi" },
      { kind: "text", value: " " },
      { kind: "placeholder", value: "[Person 1]" },
      { kind: "text", value: ", " },
      { kind: "word", value: "it's" },
      { kind: "text", value: " " },
      { kind: "word", value: "at" },
      { kind: "text", value: " " },
      { kind: "placeholder", value: "[place]" },
      { kind: "text", value: "!" },
    ]);
  });
});
