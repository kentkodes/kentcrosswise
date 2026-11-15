// resolveNoteAction: the owner's choice for a CRM note. The owner check runs first; bad ids never reach the DB; the
// `back` field only accepts /contacts and /inbox. The DB is real (PGlite) through a mocked withDb, and redirect
// throws like Next's does, so the last redirect is the action's result.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runAs } from "../src/server/db";
import { freshDb, pglitePool } from "./pglite";

const f = vi.hoisted(() => ({ requireOwner: vi.fn(), withDb: vi.fn(), redirect: vi.fn() }));

vi.mock("next/navigation", () => ({ redirect: f.redirect }));
vi.mock("@/server/owner", () => ({ requireOwner: f.requireOwner }));
vi.mock("@/server/db", async () => ({ ...(await import("../src/server/db")), withDb: f.withDb }));
vi.mock("../src/server/db", async () => ({ ...(await import("../src/server/db")), withDb: f.withDb }));
vi.mock("@/server/contacts", async () => await import("../src/server/contacts"));

import { resolveNoteAction } from "../src/app/(owner)/contacts/actions";

const GHOST = "8f14e45f-ceea-4671-9d3f-0b1f5c1e2a3b";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

/** Runs the action and returns the redirect target (the mocked redirect throws, as Next's does). */
async function run(fields: Record<string, string>): Promise<string> {
  await expect(resolveNoteAction(form(fields))).rejects.toThrow("NEXT_REDIRECT");
  return f.redirect.mock.lastCall![0] as string;
}

describe("resolveNoteAction", () => {
  let pg: PGlite;
  let sam: string;
  let ana: string;
  let noteId: string;

  beforeAll(async () => {
    pg = await freshDb();
  }, 120000);
  afterAll(async () => {
    await pg.close();
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    f.requireOwner.mockResolvedValue(undefined);
    f.redirect.mockImplementation((url: string) => {
      throw new Error(`NEXT_REDIRECT ${url}`);
    });
    f.withDb.mockImplementation((role: string, fn: never) => runAs(pglitePool(pg), role as "web_rw", fn));
    await pg.query("DELETE FROM inbox_items");
    await pg.query("DELETE FROM crm_notes");
    await pg.query("DELETE FROM contacts");
    sam = (await pg.query<{ id: string }>("INSERT INTO contacts (name) VALUES ('Sam') RETURNING id")).rows[0]!.id;
    ana = (await pg.query<{ id: string }>("INSERT INTO contacts (name) VALUES ('Ana') RETURNING id")).rows[0]!.id;
    noteId = (await pg.query<{ id: string }>("INSERT INTO crm_notes (body, link_status) VALUES ('Sam and Ana', 'ambiguous') RETURNING id")).rows[0]!.id;
    await pg.query(
      "INSERT INTO inbox_items (kind, ref_table, ref_id, title) VALUES ('contact_match', 'crm_notes', $1, 'Which contact: Sam and Ana')",
      [noteId],
    );
  });

  const state = async () =>
    (await pg.query<{ contact_id: string | null; link_status: string; open: number }>(
      `SELECT contact_id, link_status,
              (SELECT count(*)::int FROM inbox_items WHERE kind = 'contact_match' AND ref_id = crm_notes.id::text AND status = 'open') AS open
         FROM crm_notes WHERE id = $1`,
      [noteId],
    )).rows[0]!;

  it("stops before the DB for a non-owner", async () => {
    f.requireOwner.mockRejectedValue(new Error("NEXT_REDIRECT /api/auth/signin"));
    await expect(resolveNoteAction(form({ note_id: noteId, contact_id: sam }))).rejects.toThrow("NEXT_REDIRECT /api/auth/signin");
    expect(f.withDb).not.toHaveBeenCalled();
    expect(await state()).toMatchObject({ link_status: "ambiguous", open: 1 });
  });

  it("links a note, closes the open item, then relinks and unlinks it", async () => {
    expect(await run({ note_id: noteId, contact_id: sam, back: "/inbox" })).toBe("/inbox?n=note-linked");
    expect(await state()).toEqual({ contact_id: sam, link_status: "linked", open: 0 });
    expect(await run({ note_id: noteId, contact_id: ana, back: "/contacts" })).toBe("/contacts?n=note-linked");
    expect(await state()).toMatchObject({ contact_id: ana, link_status: "linked" });
    expect(await run({ note_id: noteId, contact_id: "", back: "/contacts" })).toBe("/contacts?n=note-unlinked");
    expect(await state()).toEqual({ contact_id: null, link_status: "none", open: 0 });
  });

  it("choosing No contact closes the open item", async () => {
    expect(await run({ note_id: noteId, contact_id: "", back: "/inbox" })).toBe("/inbox?n=note-unlinked");
    expect(await state()).toEqual({ contact_id: null, link_status: "none", open: 0 });
  });

  it("accepts only /contacts and /inbox as back, and falls back to /contacts", async () => {
    for (const back of ["https://example.invalid/x", "//example.invalid", "/hub", "/contacts/../x", "/inbox?x=1", ""]) {
      expect(await run({ note_id: noteId, contact_id: sam, back })).toBe("/contacts?n=note-linked");
    }
    expect(await run({ note_id: noteId, contact_id: sam })).toBe("/contacts?n=note-linked");
    expect(await run({ note_id: noteId, contact_id: sam, back: "/inbox" })).toBe("/inbox?n=note-linked");
  });

  it("gives the invalid notice for bad ids without touching the DB", async () => {
    expect(await run({ note_id: "not-a-uuid", contact_id: sam, back: "/inbox" })).toBe("/inbox?n=invalid");
    expect(await run({ note_id: noteId, contact_id: "not-a-uuid" })).toBe("/contacts?n=invalid");
    expect(await run({ contact_id: sam })).toBe("/contacts?n=invalid");
    expect(f.withDb).not.toHaveBeenCalled();
    expect(await state()).toMatchObject({ link_status: "ambiguous", open: 1 });
  });

  it("reports an unknown note or contact with its own notice", async () => {
    expect(await run({ note_id: GHOST, contact_id: sam })).toBe("/contacts?n=note-not-found");
    expect(await run({ note_id: noteId, contact_id: GHOST })).toBe("/contacts?n=not-found");
    expect(await state()).toMatchObject({ link_status: "ambiguous", open: 1 });
  });
});
