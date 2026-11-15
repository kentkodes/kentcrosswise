// H4 contacts: form parsing, whole-word and alias matching, linking (linked, ambiguous, none, idempotent inbox
// item), owner resolution, deletion. PGlite only; synthetic names.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  containsWord,
  contactMatchTitle,
  createContact,
  deleteContact,
  getContact,
  linkCrmNote,
  listContacts,
  listCrmNotes,
  listOpenContactMatches,
  parseContact,
  parseList,
  resolveCrmNote,
  updateContact,
  type ContactInput,
} from "../src/server/contacts";
import { runAs, type Queryable } from "../src/server/db";
import { freshDb, pglitePool } from "./pglite";

const form = (o: Record<string, string>) => ({ get: (k: string) => (k in o ? o[k]! : null) });

describe("parseList", () => {
  it("trims, drops empties and de-duplicates case-insensitively keeping the first spelling", () => {
    expect(parseList(" Bob , bob,, BOB ,Rob  Ray ,rob ray")).toEqual(["Bob", "Rob Ray"]);
    expect(parseList("")).toEqual([]);
    expect(parseList(null)).toEqual([]);
  });
});

describe("parseContact", () => {
  it("requires a name", () => {
    expect(parseContact(form({ name: "  " }))).toEqual({ ok: false, error: "name-required" });
    expect(parseContact(form({}))).toEqual({ ok: false, error: "name-required" });
  });

  it("parses every field, with empty optional fields as null", () => {
    expect(
      parseContact(form({ name: " Ada  Test ", aliases: "Ad, ad, A.T.", how_known: "", birthday: "1990-02-28", notes: "x\r\ny", tags: "a,B,b" })),
    ).toEqual({
      ok: true,
      value: { name: "Ada Test", aliases: ["Ad", "A.T."], howKnown: null, birthday: "1990-02-28", notes: "x\ny", tags: ["a", "B"] },
    });
    const bare = parseContact(form({ name: "Sam" }));
    expect(bare).toEqual({ ok: true, value: { name: "Sam", aliases: [], howKnown: null, birthday: null, notes: null, tags: [] } });
  });

  it("rejects an impossible birthday and over-long fields", () => {
    expect(parseContact(form({ name: "Sam", birthday: "2023-02-30" }))).toEqual({ ok: false, error: "bad-birthday" });
    expect(parseContact(form({ name: "Sam", birthday: "02/03/1990" }))).toEqual({ ok: false, error: "bad-birthday" });
    expect(parseContact(form({ name: "x".repeat(201) }))).toEqual({ ok: false, error: "too-long" });
    expect(parseContact(form({ name: "Sam", notes: "n".repeat(10001) }))).toEqual({ ok: false, error: "too-long" });
  });
});

describe("containsWord", () => {
  it("matches whole words case-insensitively and not inside longer words", () => {
    expect(containsWord("Lunch with sam today", "Sam")).toBe(true);
    expect(containsWord("Samuel called", "Sam")).toBe(false);
    expect(containsWord("Ask Sam.", "Sam")).toBe(true);
    expect(containsWord("Sam's idea", "Sam")).toBe(true);
    expect(containsWord("Met Ana Lee at noon", "ana lee")).toBe(true);
    expect(containsWord("Hi (A.T.) there", "A.T.")).toBe(true);
    expect(containsWord("text", "")).toBe(false);
  });

  it("compares in NFC: a decomposed accent matches a composed one, either way", () => {
    expect(containsWord("Met José today", "José")).toBe(true);
    expect(containsWord("Met José today", "José")).toBe(true);
    expect(containsWord("Met Josés today", "José")).toBe(false);
  });

  it("lets whitespace inside a name match any whitespace run", () => {
    expect(containsWord("Ask Smith\nJohn about it", "Smith John")).toBe(true);
    expect(containsWord("Ask Smith \t  John about it", "Smith John")).toBe(true);
    expect(containsWord("Ask Smith John about it", "Smith  John")).toBe(true);
    expect(containsWord("Ask SmithJohn about it", "Smith John")).toBe(false);
  });
});

describe("contactMatchTitle", () => {
  it("is one line with the first 60 characters, and an ellipsis only when cut", () => {
    expect(contactMatchTitle("Sam\n\n  and   Ana ")).toBe("Which contact: Sam and Ana");
    expect(contactMatchTitle("x".repeat(60))).toBe(`Which contact: ${"x".repeat(60)}`);
    expect(contactMatchTitle("y".repeat(61))).toBe(`Which contact: ${"y".repeat(60)}…`);
  });
});

describe("contacts in the database as web_rw", () => {
  let pg: PGlite;
  const asRw = <T>(fn: (db: Queryable) => Promise<T>) => runAs(pglitePool(pg), "web_rw", fn);
  const input = (o: Partial<ContactInput> & { name: string }): ContactInput => ({
    aliases: [],
    howKnown: null,
    birthday: null,
    notes: null,
    tags: [],
    ...o,
  });
  const note = async (body: string) =>
    (await pg.query<{ id: string }>("INSERT INTO crm_notes (body) VALUES ($1) RETURNING id", [body])).rows[0]!.id;
  const openItems = async (noteId: string) =>
    (await pg.query<{ title: string; ref_table: string }>(
      "SELECT title, ref_table FROM inbox_items WHERE kind = 'contact_match' AND ref_id = $1 AND status = 'open'",
      [noteId],
    )).rows;

  beforeAll(async () => {
    pg = await freshDb();
  }, 120000);
  afterAll(async () => {
    await pg.close();
  });
  beforeEach(async () => {
    await pg.query("DELETE FROM inbox_items");
    await pg.query("DELETE FROM crm_notes");
    await pg.query("DELETE FROM contacts");
  });

  it("creates, reads, updates and filters contacts", async () => {
    const id = await asRw((db) =>
      createContact(db, input({ name: "Ada Test", aliases: ["Ad"], howKnown: "Work", birthday: "1990-02-28", notes: "n", tags: ["friend"] })),
    );
    await asRw((db) => createContact(db, input({ name: "bob Test", tags: ["Club"] })));
    const got = await asRw((db) => getContact(db, id));
    expect(got).toEqual({ id, name: "Ada Test", aliases: ["Ad"], howKnown: "Work", birthday: "1990-02-28", notes: "n", tags: ["friend"] });

    expect((await asRw((db) => listContacts(db))).map((c) => c.name)).toEqual(["Ada Test", "bob Test"]);
    expect((await asRw((db) => listContacts(db, "AD"))).map((c) => c.name)).toEqual(["Ada Test"]);
    expect((await asRw((db) => listContacts(db, "club"))).map((c) => c.name)).toEqual(["bob Test"]);
    expect((await asRw((db) => listContacts(db, "nobody"))).length).toBe(0);
    expect((await asRw((db) => listContacts(db, "%"))).length).toBe(0); // LIKE wildcards are literal

    expect(await asRw((db) => updateContact(db, id, input({ name: "Ada Renamed", birthday: null })))).toBe(true);
    expect((await asRw((db) => getContact(db, id)))?.name).toBe("Ada Renamed");
    expect(await asRw((db) => updateContact(db, "8f14e45f-ceea-4671-9d3f-0b1f5c1e2a3b", input({ name: "x" })))).toBe(false);
  });

  it("links a note to the one contact whose name or alias is a whole word", async () => {
    const ada = await asRw((db) => createContact(db, input({ name: "Ada Test", aliases: ["Addie"] })));
    await asRw((db) => createContact(db, input({ name: "Sam" })));
    const byName = await note("Lunch with ada test on Friday");
    const byAlias = await note("addie sent the file");
    const wordOnly = await note("Samuel is not Sam"); // Sam matches as a whole word once
    expect(await asRw((db) => linkCrmNote(db, byName))).toBe("linked");
    expect(await asRw((db) => linkCrmNote(db, byAlias))).toBe("linked");
    expect(await asRw((db) => linkCrmNote(db, wordOnly))).toBe("linked");
    const notes = await asRw((db) => listCrmNotes(db));
    expect(notes.find((n) => n.id === byName)).toMatchObject({ linkStatus: "linked", contactId: ada, contactName: "Ada Test" });
    expect(notes.find((n) => n.id === byAlias)?.contactId).toBe(ada);
    expect(notes.find((n) => n.id === wordOnly)?.contactName).toBe("Sam");
  });

  it("does not match inside longer words, and sets none when nothing matches", async () => {
    await asRw((db) => createContact(db, input({ name: "Sam" })));
    const id = await note("Samuel and Samson went out");
    expect(await asRw((db) => linkCrmNote(db, id))).toBe("none");
    expect((await asRw((db) => listCrmNotes(db)))[0]).toMatchObject({ linkStatus: "none", contactId: null });
    expect(await openItems(id)).toEqual([]);
  });

  it("is ambiguous with one open contact_match item when several match, and calling again adds no second", async () => {
    await asRw((db) => createContact(db, input({ name: "Sam" })));
    await asRw((db) => createContact(db, input({ name: "Ana", aliases: ["Annie"] })));
    const id = await note("Sam and annie met\nover coffee");
    expect(await asRw((db) => linkCrmNote(db, id))).toBe("ambiguous");
    expect(await asRw((db) => linkCrmNote(db, id))).toBe("ambiguous");
    const items = await openItems(id);
    expect(items).toEqual([{ title: "Which contact: Sam and annie met over coffee", ref_table: "crm_notes" }]);
    expect((await asRw((db) => listCrmNotes(db)))[0]).toMatchObject({ linkStatus: "ambiguous", contactId: null });

    const matches = await asRw((db) => listOpenContactMatches(db));
    expect(matches).toHaveLength(1);
    expect(matches[0]!.noteId).toBe(id);
    expect(matches[0]!.candidates.map((c) => c.name)).toEqual(["Ana", "Sam"]);
  });

  it("closes a stale open item when a later call no longer finds an ambiguity", async () => {
    const a = await asRw((db) => createContact(db, input({ name: "Sam" })));
    const b = await asRw((db) => createContact(db, input({ name: "Ana" })));
    const id = await note("Sam and Ana");
    await asRw((db) => linkCrmNote(db, id));
    await asRw((db) => deleteContact(db, b));
    expect(await asRw((db) => linkCrmNote(db, id))).toBe("linked");
    expect(await openItems(id)).toEqual([]);
    expect((await asRw((db) => listCrmNotes(db)))[0]?.contactId).toBe(a);
  });

  it("returns not-found for an unknown note", async () => {
    expect(await asRw((db) => linkCrmNote(db, "8f14e45f-ceea-4671-9d3f-0b1f5c1e2a3b"))).toBe("not-found");
  });

  it("the owner's choice links, relinks or unlinks a note and closes the open item", async () => {
    const sam = await asRw((db) => createContact(db, input({ name: "Sam" })));
    const ana = await asRw((db) => createContact(db, input({ name: "Ana" })));
    const id = await note("Sam and Ana");
    await asRw((db) => linkCrmNote(db, id));
    expect(await openItems(id)).toHaveLength(1);

    expect(await asRw((db) => resolveCrmNote(db, id, ana))).toBe("ok");
    expect(await openItems(id)).toEqual([]);
    expect((await asRw((db) => listCrmNotes(db)))[0]).toMatchObject({ linkStatus: "linked", contactId: ana });
    const done = await pg.query<{ resolved_at: Date | null }>("SELECT resolved_at FROM inbox_items WHERE ref_id = $1", [id]);
    expect(done.rows[0]!.resolved_at).not.toBeNull();

    expect(await asRw((db) => resolveCrmNote(db, id, sam))).toBe("ok"); // relink
    expect((await asRw((db) => listCrmNotes(db)))[0]?.contactId).toBe(sam);
    expect(await asRw((db) => resolveCrmNote(db, id, null))).toBe("ok"); // unlink
    expect((await asRw((db) => listCrmNotes(db)))[0]).toMatchObject({ linkStatus: "none", contactId: null });

    expect(await asRw((db) => resolveCrmNote(db, id, "8f14e45f-ceea-4671-9d3f-0b1f5c1e2a3b"))).toBe("contact-not-found");
    expect(await asRw((db) => resolveCrmNote(db, "8f14e45f-ceea-4671-9d3f-0b1f5c1e2a3b", null))).toBe("note-not-found");
  });

  it("deleting a contact unlinks its notes (link_status none) and keeps the notes", async () => {
    const sam = await asRw((db) => createContact(db, input({ name: "Sam" })));
    const mine = await note("Sam said hi");
    await asRw((db) => linkCrmNote(db, mine));
    expect(await asRw((db) => deleteContact(db, sam))).toBe(true);
    expect(await asRw((db) => deleteContact(db, sam))).toBe(false);
    const rows = await asRw((db) => listCrmNotes(db));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: mine, linkStatus: "none", contactId: null, contactName: null });
  });

  it("a note saved before its contact existed links when the contact is created", async () => {
    const id = await note("Coffee with Zoe tomorrow");
    expect(await asRw((db) => linkCrmNote(db, id))).toBe("none");
    const zoe = await asRw((db) => createContact(db, input({ name: "Zoe" })));
    expect((await asRw((db) => listCrmNotes(db)))[0]).toMatchObject({ linkStatus: "linked", contactId: zoe });
  });

  it("a note that matches several contacts once one is created becomes ambiguous with one open item", async () => {
    const id = await note("Ivy and Kai");
    await pg.query("INSERT INTO contacts (name) VALUES ('Ivy'), ('Kai')"); // direct insert: no relinking
    expect(await openItems(id)).toEqual([]);
    await asRw((db) => createContact(db, input({ name: "Newcomer" })));
    expect(await openItems(id)).toHaveLength(1);
    expect((await asRw((db) => listCrmNotes(db)))[0]).toMatchObject({ linkStatus: "ambiguous", contactId: null });
    await asRw((db) => createContact(db, input({ name: "Another" })));
    expect(await openItems(id)).toHaveLength(1); // ambiguous notes are not re-checked
  });

  it("a renamed contact or a new alias picks up matching notes", async () => {
    const c = await asRw((db) => createContact(db, input({ name: "Placeholder" })));
    const a = await note("Dinner with Rowan");
    const b = await note("Call Ro about it");
    await asRw((db) => linkCrmNote(db, a));
    await asRw((db) => linkCrmNote(db, b));
    await asRw((db) => updateContact(db, c, input({ name: "Rowan" })));
    await asRw((db) => updateContact(db, c, input({ name: "Rowan", aliases: ["Ro"] })));
    const rows = await asRw((db) => listCrmNotes(db));
    expect(rows.find((n) => n.id === a)).toMatchObject({ linkStatus: "linked", contactId: c });
    expect(rows.find((n) => n.id === b)).toMatchObject({ linkStatus: "linked", contactId: c });
  });

  it("an edit that leaves name and aliases alone does not relink, and linked notes are never touched", async () => {
    const owner = await asRw((db) => createContact(db, input({ name: "Quinn" })));
    const mine = await note("Quinn and Zoe");
    await asRw((db) => linkCrmNote(db, mine)); // ambiguous? only Quinn exists: linked to Quinn
    const none = await note("Zoe only");
    await asRw((db) => linkCrmNote(db, none));
    await pg.query("INSERT INTO contacts (name) VALUES ('Zoe')");
    await asRw((db) => updateContact(db, owner, input({ name: "Quinn", howKnown: "Work" })));
    expect((await asRw((db) => listCrmNotes(db))).find((n) => n.id === none)?.linkStatus).toBe("none");
    // A name change now relinks the unlinked note, but the one linked to Quinn keeps its contact.
    await asRw((db) => updateContact(db, owner, input({ name: "Quinn Renamed", aliases: ["Quinn"] })));
    const rows = await asRw((db) => listCrmNotes(db));
    expect(rows.find((n) => n.id === none)?.linkStatus).toBe("linked");
    expect(rows.find((n) => n.id === mine)).toMatchObject({ linkStatus: "linked", contactId: owner });
  });

  it("re-checks at most the newest 500 unlinked notes", async () => {
    await pg.query(
      "INSERT INTO crm_notes (body, created_at) SELECT 'Mention of Zed ' || g, '2020-01-01'::timestamptz + g * interval '1 minute' FROM generate_series(1, 501) g",
    );
    await asRw((db) => createContact(db, input({ name: "Zed" })));
    const r = await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM crm_notes WHERE link_status = 'linked'");
    expect(r.rows[0]!.n).toBe(500);
    const left = await pg.query<{ body: string }>("SELECT body FROM crm_notes WHERE link_status = 'none'");
    expect(left.rows).toEqual([{ body: "Mention of Zed 1" }]);
  });

  it("lists one contact's notes newest first", async () => {
    const sam = await asRw((db) => createContact(db, input({ name: "Sam" })));
    await pg.query("INSERT INTO crm_notes (body, contact_id, link_status, created_at) VALUES ('old', $1, 'linked', '2021-01-01')", [sam]);
    await pg.query("INSERT INTO crm_notes (body, contact_id, link_status, created_at) VALUES ('new', $1, 'linked', '2021-02-01')", [sam]);
    await pg.query("INSERT INTO crm_notes (body) VALUES ('other')");
    expect((await asRw((db) => listCrmNotes(db, { contactId: sam }))).map((n) => n.body)).toEqual(["new", "old"]);
  });
});
