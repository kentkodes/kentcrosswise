// PL2 router step rows: which steps a capture, a route, a failure, the owner's choice or correction, mood scoring
// and a calendar suggestion write; that details hold codes and ids, never text; and that a failing step write never
// fails the capture. PGlite and FakeProvider only; no model is called for real.
import type { PGlite } from "@electric-sql/pglite";
import { FakeProvider } from "@kcw/core/models";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { saveEntry } from "../src/server/capture";
import { createContact } from "../src/server/contacts";
import { runAs } from "../src/server/db";
import { scoreDiaryEntry } from "../src/server/mood";
import { reassignEntryDerived, routeEntry, type DbRun } from "../src/server/router";
import { listSteps, recordStep } from "../src/server/steps";
import { freshDb, pglitePool } from "./pglite";

const NO_PLAN = JSON.stringify({ plan: false, title: "", date: "", time: "", duration_minutes: 0 });
const MOOD = JSON.stringify({ energy: 0.5, stress: 0.2, happiness: 0.6, satisfaction: 0.5, sadness: 0.1, anger: 0, anxiety: 0.2, gratitude: 0.7, sentiment: 0.3 });

describe("router step rows (web_rw on PGlite)", () => {
  let pg: PGlite;
  const run: DbRun = (fn) => runAs(pglitePool(pg), "web_rw", fn);
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const steps = async (entryId: string) => (await run((db) => listSteps(db, entryId))).map((s) => [s.step, s.detail] as const);
  const types = async (entryId: string) => (await steps(entryId)).map(([t]) => t);
  const capture = (text: string) => run((db) => saveEntry(db, text));

  beforeAll(async () => {
    pg = await freshDb();
    await run((db) =>
      createContact(db, { name: "Mara Quill", aliases: [], howKnown: null, birthday: null, notes: null, tags: [] }),
    );
  });
  afterAll(async () => {
    await pg.close();
  });
  afterEach(() => log.mockClear());

  it("a capture writes captured", async () => {
    const id = await capture("Synthetic capture");
    expect(await steps(id)).toEqual([["captured", { source: "web" }]]);
  });

  it("a confident CRM route writes routed, derived, the link outcome and the calendar outcome, with no text", async () => {
    const text = "Coffee with Mara Quill, secret synthetic words";
    const id = await capture(text);
    const p = new FakeProvider({ classify: { label: "crm_note", confidence: 0.9 }, complete: { text: NO_PLAN }, model: "m-route" });
    await expect(routeEntry(run, id, p)).resolves.toMatchObject({ code: "routed", kind: "crm_note" });
    const s = await steps(id);
    expect(s.map(([t]) => t)).toEqual(["captured", "routed", "derived", "contact_linked", "calendar_suggested"]);
    expect(s[1]![1]).toEqual({ kind: "crm_note", by: "model", confidence: 0.9, model: "m-route" });
    expect(s[2]![1]).toMatchObject({ kind: "crm_note", row_id: expect.any(String), moved_from: null });
    expect(s[3]![1]).toMatchObject({ outcome: "linked", note_id: s[2]![1].row_id });
    // no time zone on this entry, so no suggestion is made
    expect(s[4]![1]).toEqual({ outcome: "no-zone", note_id: s[2]![1].row_id });
    expect(JSON.stringify(s)).not.toMatch(/secret|Mara|Quill|Coffee/);
  });

  it("a CRM route with a zone records the model's no-plan answer", async () => {
    const id = await capture("Note about nothing in particular");
    await pg.query("UPDATE entries SET time_zone = 'America/New_York' WHERE id = $1", [id]);
    const p = new FakeProvider({ classify: { label: "crm_note", confidence: 0.9 }, complete: { text: NO_PLAN } });
    await routeEntry(run, id, p);
    const s = await steps(id);
    expect(s.at(-1)).toEqual(["calendar_suggested", { outcome: "none", note_id: expect.any(String) }]);
    expect(s.find(([t]) => t === "contact_linked")?.[1]).toMatchObject({ outcome: "none" });
  });

  it("a low-confidence route writes needs_owner; the owner's choice writes routed by owner with the guess", async () => {
    const id = await capture("Maybe a todo");
    await routeEntry(run, id, new FakeProvider({ classify: { label: "idea", confidence: 0.3 } }));
    expect(await types(id)).toEqual(["captured", "needs_owner"]);
    await run((db) => reassignEntryDerived(db, id, "todo"));
    const s = await steps(id);
    expect(s.map(([t]) => t)).toEqual(["captured", "needs_owner", "routed", "derived"]);
    expect(s[2]![1]).toEqual({ kind: "todo", by: "owner", guess: "idea" });
  });

  it("moving a routed entry writes corrected and the moved row; saving the same kind writes nothing", async () => {
    const id = await capture("An idea, then a todo");
    await routeEntry(run, id, new FakeProvider({ classify: { label: "idea", confidence: 0.95 } }));
    await run((db) => reassignEntryDerived(db, id, "todo"));
    await run((db) => reassignEntryDerived(db, id, "todo"));
    const s = await steps(id);
    expect(s.map(([t]) => t)).toEqual(["captured", "routed", "derived", "corrected", "derived"]);
    expect(s[3]![1]).toEqual({ from: "idea", to: "todo" });
    expect(s[4]![1]).toMatchObject({ kind: "todo", moved_from: "idea" });
  });

  it("moving a routed entry to an agent request writes corrected and no derived row", async () => {
    const id = await capture("Becomes a request");
    await routeEntry(run, id, new FakeProvider({ classify: { label: "todo", confidence: 0.95 } }));
    await run((db) => reassignEntryDerived(db, id, "agent_request"));
    expect(await types(id)).toEqual(["captured", "routed", "derived", "corrected"]);
  });

  it("a provider error writes route_failed with the attempt; Route again then writes routed (the recovery)", async () => {
    const id = await capture("Fails once");
    await routeEntry(run, id, new FakeProvider({ classify: new TypeError("boom") }));
    await routeEntry(run, id, new FakeProvider({ classify: { label: "idea", confidence: 0.9 } }));
    const s = await steps(id);
    expect(s.map(([t]) => t)).toEqual(["captured", "route_failed", "routed", "derived"]);
    expect(s[1]![1]).toEqual({ code: "provider_error", attempt: 1 });
  });

  it("a label outside the set writes route_failed invalid_label", async () => {
    const id = await capture("Odd label");
    await routeEntry(run, id, new FakeProvider({ classify: { label: "nonsense", confidence: 0.9 } }));
    expect((await steps(id)).at(-1)).toEqual(["route_failed", { code: "invalid_label", attempt: 1 }]);
  });

  it("the spend cap writes route_failed spend_cap", async () => {
    await pg.query(
      "INSERT INTO usage_events (kind, agent, provider, model, input_tokens, output_tokens, cost_usd) VALUES ('model', 'orchestrator', 'deepseek', 'deepseek-flash', 1, 1, 50)",
    );
    try {
      const id = await capture("Capped");
      await routeEntry(run, id, new FakeProvider({ classify: { label: "idea", confidence: 0.9 } }));
      expect((await steps(id)).at(-1)).toEqual(["route_failed", { code: "spend_cap", attempt: 1 }]);
    } finally {
      await pg.query("DELETE FROM usage_events WHERE agent = 'orchestrator'");
    }
  });

  it("scoring a diary row from a capture writes mood_scored; a failed score writes its outcome", async () => {
    const id = await capture("A diary day");
    const out = await routeEntry(run, id, new FakeProvider({ classify: { label: "diary", confidence: 0.9 } }));
    const diaryId = out.code === "routed" ? out.derived!.id : "";
    await scoreDiaryEntry(run, diaryId, new FakeProvider({ complete: { text: "not json" } }));
    await scoreDiaryEntry(run, diaryId, new FakeProvider({ complete: { text: MOOD }, model: "m-mood" }));
    const s = await steps(id);
    expect(s.map(([t]) => t)).toEqual(["captured", "routed", "derived", "mood_scored", "mood_scored"]);
    expect(s[3]![1]).toEqual({ outcome: "failed", diary_entry_id: diaryId });
    expect(s[4]![1]).toEqual({ outcome: "scored", diary_entry_id: diaryId, model: "m-mood" });
  });

  it("a diary entry written on the diary page (no capture) writes no step", async () => {
    const before = Number((await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM agent_events")).rows[0]!.n);
    const diaryId = (await pg.query<{ id: string }>("INSERT INTO diary_entries (body) VALUES ('page entry') RETURNING id")).rows[0]!.id;
    await scoreDiaryEntry(run, diaryId, new FakeProvider({ complete: { text: MOOD } }));
    expect(Number((await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM agent_events")).rows[0]!.n)).toBe(before);
  });

  it("a failing step write is rolled back alone: the capture's transaction still commits", async () => {
    const id = await run(async (db) => {
      const saved = await saveEntry(db, "Survives a bad step");
      // an unknown entry id violates the foreign key: only the step is rolled back
      await recordStep(db, "00000000-0000-4000-8000-00000000dead", "routed", { kind: "idea", by: "model" });
      await db.query("UPDATE entries SET raw_text = raw_text WHERE id = $1", [saved]);
      return saved;
    });
    expect(await types(id)).toEqual(["captured"]);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain("[steps] routed-");
    expect(logged).not.toContain("Survives");
  });
});
