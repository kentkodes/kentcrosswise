// Hub integration: a CRM note created by a route is linked to its contact in the same transaction (a failed link
// keeps the route and the note), and a diary row created by a route is scored after the commit, bounded to 6 s.
// The DB is real (PGlite) through a mocked withDb; the provider is a FakeProvider.
import type { PGlite } from "@electric-sql/pglite";
import { FakeProvider } from "@kcw/core/models";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ContactsModule from "../src/server/contacts";
import { runAs } from "../src/server/db";
import { freshDb, pglitePool } from "./pglite";

type Contacts = typeof ContactsModule;

const f = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  withDb: vi.fn(),
  redirect: vi.fn(),
  routerFromEnv: vi.fn(),
  link: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: f.redirect }));
vi.mock("@/server/owner", () => ({ requireOwner: f.requireOwner }));
vi.mock("@/server/db", async () => ({ ...(await import("../src/server/db")), withDb: f.withDb }));
vi.mock("../src/server/db", async () => ({ ...(await import("../src/server/db")), withDb: f.withDb }));
vi.mock("@/server/capture", async () => await import("../src/server/capture"));
vi.mock("@/server/mood", async () => await import("../src/server/mood"));
vi.mock("@/server/console", async () => await import("../src/server/console"));
vi.mock("@/server/orchestrator-queue", async () => await import("../src/server/orchestrator-queue"));
vi.mock("@/server/outbox", async () => await import("../src/server/outbox"));
vi.mock("@/server/router", async () => ({ ...(await import("../src/server/router")), routerFromEnv: f.routerFromEnv }));
vi.mock("../src/server/router", async () => ({ ...(await import("../src/server/router")), routerFromEnv: f.routerFromEnv }));
vi.mock("../src/server/contacts", async (orig) => ({ ...(await orig<Contacts>()), linkCrmNote: f.link }));

import { captureAction, reassignAction } from "../src/app/(owner)/hub/actions";
import { scoreCreated, SCORE_BOUND_MS } from "../src/app/(owner)/routing";

const GOOD = { energy: 0.6, stress: 0.2, happiness: 0.7, satisfaction: 0.5, sadness: 0.1, anger: 0, anxiety: 0.3, gratitude: 1, sentiment: -0.25 };
const model = (label: string) => new FakeProvider({ classify: { label, confidence: 0.95 }, complete: { text: JSON.stringify(GOOD), model: "m" } });

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

describe("routing links notes and scores diary rows", () => {
  let pg: PGlite;
  const q = async <T extends object>(sql: string, params?: unknown[]) => (await pg.query<T>(sql, params)).rows;

  beforeAll(async () => {
    pg = await freshDb();
    await pg.query("INSERT INTO contacts (name) VALUES ('Zelda Integ'), ('Quinn Integ'), ('Quinn Other')");
  });
  afterAll(async () => {
    await pg.close();
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    f.link.mockImplementation((await vi.importActual<Contacts>("../src/server/contacts")).linkCrmNote);
    f.requireOwner.mockResolvedValue(undefined);
    f.withDb.mockImplementation((role: "web_rw" | "web_public", fn: never) => runAs(pglitePool(pg), role, fn));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const entryId = async () => (await q<{ id: string }>("SELECT id FROM entries ORDER BY created_at DESC, id DESC LIMIT 1"))[0]!.id;
  const note = async (id: string) =>
    (await q<{ id: string; link_status: string; contact: string | null }>(
      "SELECT n.id, n.link_status, c.name AS contact FROM crm_notes n LEFT JOIN contacts c ON c.id = n.contact_id WHERE n.entry_id = $1",
      [id],
    ))[0];
  const scores = async (entry: string) =>
    (await q<{ n: string }>(
      "SELECT count(*)::text AS n FROM mood_scores m JOIN diary_entries d ON d.id = m.diary_entry_id WHERE d.entry_id = $1",
      [entry],
    ))[0]!.n;

  it("a model-routed CRM note is linked to the one contact it names", async () => {
    f.routerFromEnv.mockResolvedValue(model("crm_note"));
    await captureAction(form({ raw_text: "Lunch with Zelda Integ on Friday" }));
    expect(await note(await entryId())).toMatchObject({ link_status: "linked", contact: "Zelda Integ" });
  });

  it("two matching contacts make the note ambiguous with one open inbox item", async () => {
    f.routerFromEnv.mockResolvedValue(model("crm_note"));
    await captureAction(form({ raw_text: "Quinn Integ and Quinn Other came by" }));
    const n = await note(await entryId());
    expect(n).toMatchObject({ link_status: "ambiguous", contact: null });
    const items = await q("SELECT 1 FROM inbox_items WHERE kind = 'contact_match' AND ref_id = $1 AND status = 'open'", [n!.id]);
    expect(items).toHaveLength(1);
  });

  it("reassigning a linked note to another kind and back relinks it", async () => {
    f.routerFromEnv.mockResolvedValue(model("crm_note"));
    await captureAction(form({ raw_text: "Call Zelda Integ about the trip" }));
    const id = await entryId();
    await reassignAction(form({ entry_id: id, to: "todo" }));
    expect(await note(id)).toBeUndefined();
    expect(await q("SELECT 1 FROM todos WHERE entry_id = $1", [id])).toHaveLength(1);
    await reassignAction(form({ entry_id: id, to: "crm_note" }));
    expect(await note(id)).toMatchObject({ link_status: "linked", contact: "Zelda Integ" });
  });

  it("a failing link step keeps the route and the note, unlinked, and logs only the class", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    f.link.mockRejectedValueOnce(new Error("secret text Zelda Integ"));
    f.routerFromEnv.mockResolvedValue(model("crm_note"));
    await captureAction(form({ raw_text: "Zelda Integ failing link" }));
    const id = await entryId();
    expect(f.redirect).toHaveBeenLastCalledWith("/hub?n=captured-routed-crm_note");
    expect(await q("SELECT route_kind, status FROM entries WHERE id = $1", [id])).toEqual([{ route_kind: "crm_note", status: "routed" }]);
    expect(await note(id)).toMatchObject({ link_status: "none", contact: null });
    expect(log).toHaveBeenCalledWith("[router] link-Error");
    expect(JSON.stringify(log.mock.calls)).not.toContain("Zelda");
  });

  it("a failing link step in a reassignment keeps the new route", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    f.routerFromEnv.mockResolvedValue(model("todo"));
    await captureAction(form({ raw_text: "Zelda Integ reassign failing link" }));
    const id = await entryId();
    f.link.mockRejectedValueOnce(new Error("boom"));
    await reassignAction(form({ entry_id: id, to: "crm_note" }));
    expect(f.redirect).toHaveBeenLastCalledWith("/hub?n=routed-crm_note");
    expect(await note(id)).toMatchObject({ link_status: "none" });
    expect(await q("SELECT 1 FROM todos WHERE entry_id = $1", [id])).toHaveLength(0);
  });

  it("a model-routed diary row is scored after the commit, with the capture notice unchanged", async () => {
    f.routerFromEnv.mockResolvedValue(model("diary"));
    await captureAction(form({ raw_text: "A quiet day, scored on capture" }));
    expect(f.redirect).toHaveBeenLastCalledWith("/hub?n=captured-routed-diary");
    expect(await scores(await entryId())).toBe("1");
  });

  it("a diary row created by a reassignment is scored", async () => {
    f.routerFromEnv.mockResolvedValue(model("todo"));
    await captureAction(form({ raw_text: "Reassigned into the diary" }));
    const id = await entryId();
    expect(await scores(id)).toBe("0");
    await reassignAction(form({ entry_id: id, to: "diary" }));
    expect(f.redirect).toHaveBeenLastCalledWith("/hub?n=routed-diary");
    expect(await scores(id)).toBe("1");
  });

  it("a scoring failure leaves the entry unscored and the capture intact", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    f.routerFromEnv.mockResolvedValueOnce(model("todo"));
    await captureAction(form({ raw_text: "Scoring will fail" }));
    const id = await entryId();
    f.routerFromEnv.mockResolvedValue(new FakeProvider({ complete: new Error("down") }));
    await reassignAction(form({ entry_id: id, to: "diary" }));
    expect(f.redirect).toHaveBeenLastCalledWith("/hub?n=routed-diary");
    expect(await scores(id)).toBe("0");
    expect(await q("SELECT 1 FROM diary_entries WHERE entry_id = $1", [id])).toHaveLength(1);
  });

  it("scoring is bounded to 6 seconds: a hanging model does not hold the capture", async () => {
    await pg.query("INSERT INTO entries (source, raw_text) VALUES ('web', 'Hanging score')");
    const e = await entryId();
    const d = (await q<{ id: string }>("INSERT INTO diary_entries (entry_id, body) VALUES ($1, 'Hanging score') RETURNING id", [e]))[0]!.id;
    f.routerFromEnv.mockResolvedValue({ complete: () => new Promise(() => undefined) });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let done = false;
    const p = scoreCreated({ kind: "diary", id: d }).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(SCORE_BOUND_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
    expect(SCORE_BOUND_MS).toBe(6000);
    expect(await scores(e)).toBe("0");
  });

  it("only a diary row is scored", async () => {
    await scoreCreated({ kind: "todo", id: "x" });
    await scoreCreated(null);
    expect(f.routerFromEnv).not.toHaveBeenCalled();
  });
});
