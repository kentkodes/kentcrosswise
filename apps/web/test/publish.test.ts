// PL4 publication: a record is published only after review, with sanitized text and code-only step lines; anything
// unsafe withholds it; later owner actions replace the snapshot; the web_public reader sees only the views and
// rebuilds every step line from the allowlist. PGlite and FakeProvider only; synthetic names and text.
import type { PGlite } from "@electric-sql/pglite";
import { FakeProvider } from "@kcw/core/models";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { saveEntry } from "../src/server/capture";
import { createContact, resolveCrmNote } from "../src/server/contacts";
import { runAs } from "../src/server/db";
import { LOG_LABEL, loadPublicLog, publicStep, queryPublicLog } from "../src/server/public-log";
import { listWithheldRetry, publishEntry } from "../src/server/publish";
import { addOwnerTerm, confirmEntry, prepareSpans } from "../src/server/review";
import { reassignEntryDerived, routeEntry, type DbRun } from "../src/server/router";
import { freshDb, pglitePool } from "./pglite";

const spans = (people: string[], places: string[] = [], privateOther = false) =>
  new FakeProvider({ complete: { text: JSON.stringify({ people, places, private_other: privateOther }) } });
const HOUR = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/;

describe("publication (web_rw writes, web_public reads)", () => {
  let pg: PGlite;
  const run: DbRun = (fn) => runAs(pglitePool(pg), "web_rw", fn);
  const pub: DbRun = (fn) => runAs(pglitePool(pg), "web_public", fn);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const publish = (id: string) => run((db) => publishEntry(db, id));
  const stored = async (id: string) =>
    (await pg.query<{ state: string; withheld_reason: string | null; body: string | null; steps: unknown[]; public_id: string }>(
      "SELECT state, withheld_reason, body, steps, public_id FROM public_records WHERE entry_id = $1",
      [id],
    )).rows[0];
  const routed = async (text: string, label = "idea", proposal = spans([])) => {
    const id = await run((db) => saveEntry(db, text));
    await routeEntry(run, id, new FakeProvider({ classify: { label, confidence: 0.91 }, model: "deepseek-flash" }));
    await prepareSpans(run, id, proposal);
    return id;
  };

  beforeAll(async () => {
    pg = await freshDb();
    await run((db) => createContact(db, { name: "Pell Rook", aliases: [], howKnown: null, birthday: null, notes: null, tags: [] }));
  });
  afterAll(async () => {
    await pg.close();
  });

  it("does nothing before review; Correct then publishes sanitized text and code-only steps", async () => {
    const id = await routed("Idea from Pell Rook at Gull Pier, ring 555 0100 200", "idea", spans([], ["Gull Pier"]));
    await expect(publish(id)).resolves.toBe("not-reviewed");
    expect(await stored(id)).toBeUndefined();

    await run((db) => confirmEntry(db, id));
    await expect(publish(id)).resolves.toBe("published");
    const r = (await stored(id))!;
    expect(r.body).toBe("Idea from [Person 1] at [place], ring [phone]");
    expect(r.steps.map((s) => (s as { step: string }).step)).toEqual(["captured", "routed", "derived", "confirmed"]);
    expect(r.steps[1]).toEqual({ step: "routed", hour: expect.stringMatching(HOUR), kind: "idea", by: "model", confidence: 0.91, model: "deepseek-flash" });
    expect(r.steps[2]).toEqual({ step: "derived", hour: expect.stringMatching(HOUR), kind: "idea" }); // no row id
    const json = JSON.stringify(r.steps);
    expect(json).not.toMatch(/Pell|Rook|Gull|555|row_id|note_id|[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it("a correction publishes with corrected from and to; the reader shows it through web_public", async () => {
    const id = await routed("Synthetic correction text");
    await run((db) => reassignEntryDerived(db, id, "todo"));
    await publish(id);
    const log = await pub((db) => queryPublicLog(db));
    const pid = (await stored(id))!.public_id;
    const rec = log.records.find((x) => x.id === pid);
    expect(rec).toMatchObject({ kind: "todo", text: "Synthetic correction text", capturedHour: expect.stringMatching(HOUR) });
    expect(rec!.steps.find((s) => s.step === "corrected")).toMatchObject({ from: "idea", to: "todo" });
    expect(Object.keys(rec!)).toEqual(["id", "capturedHour", "kind", "text", "steps"]);
  });

  it("withholds another person's private matters and a failed name check; a new check then publishes", async () => {
    const priv = await routed("Synthetic private matter", "idea", spans([], [], true));
    await run((db) => confirmEntry(db, priv));
    await expect(publish(priv)).resolves.toBe("withheld");
    expect(await stored(priv)).toMatchObject({ state: "withheld", withheld_reason: "private-other", body: null, steps: [] });

    const failed = await routed("Synthetic flaky check", "idea", new FakeProvider({ complete: new TypeError("down") }));
    await run((db) => confirmEntry(db, failed));
    await expect(publish(failed)).resolves.toBe("withheld");
    expect((await run((db) => listWithheldRetry(db))).map((w) => [w.id, w.reason])).toContainEqual([failed, "failed"]);
    expect((await run((db) => listWithheldRetry(db))).map((w) => w.id)).not.toContain(priv); // a new check cannot help
    await prepareSpans(run, failed, spans([]));
    await expect(publish(failed)).resolves.toBe("published");
    expect((await run((db) => listWithheldRetry(db))).map((w) => w.id)).not.toContain(failed);
  });

  it("an added replacement and a contact choice replace the snapshot, keeping the public id", async () => {
    const id = await routed("Met Pell Rook near Brack Hall", "crm_note");
    await run((db) => confirmEntry(db, id));
    await publish(id);
    const first = (await stored(id))!;
    expect(first.body).toBe("Met [Person 1] near Brack Hall");
    await run((db) => addOwnerTerm(db, id, "Brack Hall", "place"));
    const note = (await pg.query<{ id: string }>("SELECT id FROM crm_notes WHERE entry_id = $1", [id])).rows[0]!.id;
    await run((db) => resolveCrmNote(db, note, null));
    await publish(id);
    const second = (await stored(id))!;
    expect(second.public_id).toBe(first.public_id);
    expect(second.body).toBe("Met [Person 1] near [place]");
    expect(second.steps.at(-1)).toEqual({ step: "contact_chosen", hour: expect.stringMatching(HOUR), linked: false });
  });

  it("withholds a record with a step that does not map to an allowed line", async () => {
    const id = await routed("Synthetic odd step");
    await run((db) => confirmEntry(db, id));
    await pg.query("INSERT INTO agent_events (agent, event_type, entry_id, detail) VALUES ('router', 'route_failed', $1, '{\"code\":\"leaked text\",\"attempt\":1}')", [id]);
    await expect(publish(id)).resolves.toBe("withheld");
    expect(await stored(id)).toMatchObject({ withheld_reason: "step" });
  });

  it("the reader reports counts and the label, and skips a stored line that fails the allowlist", async () => {
    const id = await routed("Synthetic tampered row");
    await run((db) => confirmEntry(db, id));
    await publish(id);
    await pg.query(`UPDATE public_records SET steps = '[{"step":"captured","hour":"2026-11-18T09:00:00.000Z","extra":"secret"}]' WHERE entry_id = $1`, [id]);
    const log = await loadPublicLog(pub, false);
    expect(log.available).toBe(true);
    if (!log.available) return;
    expect(log.label).toBe(LOG_LABEL);
    expect(log.counts.published).toBeGreaterThanOrEqual(4);
    expect(log.counts.withheld).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(log)).not.toContain("secret");
    await pg.query(`UPDATE public_records SET steps = '[{"step":"routed","hour":"2026-11-18T09:00:00.000Z","kind":"nope","by":"model"}]' WHERE entry_id = $1`, [id]);
    const pid = (await stored(id))!.public_id;
    const again = await loadPublicLog(pub, false);
    expect(again.available && again.records.some((r) => r.id === pid)).toBe(false);
  });

  it("reports the log unavailable without leaking the error", async () => {
    const log = await loadPublicLog(async () => {
      throw new Error("host db.internal password=x");
    }, false);
    expect(log).toEqual({ available: false, label: LOG_LABEL, note: "The public log is unavailable right now." });
  });
});

describe("publicStep allowlist", () => {
  const ts = "2026-11-18T09:41:12.000Z";
  it("keeps only allowed fields and rounds the hour", () => {
    expect(publicStep("routed", ts, { kind: "idea", by: "model", confidence: 0.876, model: "deepseek-flash", note: "x" })).toEqual({
      step: "routed",
      hour: "2026-11-18T09:00:00.000Z",
      kind: "idea",
      by: "model",
      confidence: 0.88,
      model: "deepseek-flash",
    });
    expect(publicStep("routed", ts, { kind: "todo", by: "owner", guess: "idea" })).toMatchObject({ by: "owner", guess: "idea" });
    expect(publicStep("calendar_added", ts, { suggestion_id: "abc" })).toEqual({ step: "calendar_added", hour: "2026-11-18T09:00:00.000Z" });
    expect(publicStep("mood_scored", ts, { outcome: "scored", diary_entry_id: "abc", model: "m" })).toEqual({
      step: "mood_scored",
      hour: "2026-11-18T09:00:00.000Z",
      outcome: "scored",
    });
  });

  it("drops a model name that is not a plain identifier", () => {
    expect(publicStep("needs_owner", ts, { kind: "idea", confidence: 0.3, model: "Bob's model" })).not.toHaveProperty("model");
  });

  it.each([
    ["an unknown step", "merged", {}],
    ["a bad time", "captured", {}, "not a time"],
    ["an unknown kind", "derived", { kind: "secret" }],
    ["an unknown outcome", "contact_linked", { outcome: "linked to Pell" }],
    ["a non-integer attempt", "route_failed", { code: "spend_cap", attempt: 1.5 }],
    ["a non-boolean link", "contact_chosen", { linked: "yes" }],
    ["a missing correction side", "corrected", { from: "idea" }],
  ])("rejects %s", (_name, step, detail, at = ts) => {
    expect(publicStep(step, at, detail)).toBeNull();
  });
});
