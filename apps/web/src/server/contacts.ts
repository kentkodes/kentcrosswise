// Contacts (H4): people the owner knows, and the link from CRM notes to them by name match. Owner pages only;
// runs as web_rw. Contact data is private: nothing here logs names, aliases or note text.
// `orch_rw` reads contacts.name and contacts.aliases for the public-title sanitizer, so those columns keep their meaning.
import type { Queryable } from "./db";

export const MAX_NAME_CHARS = 200;
export const MAX_FIELD_CHARS = 2000;
export const MAX_NOTES_CHARS = 10000;
export const MAX_LIST_ITEMS = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isContactId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

// ---------------------------------------------------------------- parsing

/** Comma-separated text to a list: trimmed, empty items dropped, duplicates removed case-insensitively (first spelling wins). */
export function parseList(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const item = part.trim().replace(/\s+/g, " ");
    const key = item.toLowerCase();
    if (item === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export interface ContactInput {
  name: string;
  aliases: string[];
  howKnown: string | null;
  /** YYYY-MM-DD */
  birthday: string | null;
  notes: string | null;
  tags: string[];
}

export type ContactError = "name-required" | "too-long" | "bad-birthday";
export type ContactParse = { ok: true; value: ContactInput } | { ok: false; error: ContactError };

function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const text = (v: FormDataEntryValue | null | undefined): string => (typeof v === "string" ? v.replaceAll("\r\n", "\n").trim() : "");

/** Reads the contact form (name, aliases, how_known, birthday, notes, tags). Empty optional fields become NULL. */
export function parseContact(form: { get(name: string): FormDataEntryValue | null }): ContactParse {
  const name = text(form.get("name")).replace(/\s+/g, " ");
  if (name === "") return { ok: false, error: "name-required" };
  const aliases = parseList(form.get("aliases"));
  const tags = parseList(form.get("tags"));
  const howKnown = text(form.get("how_known"));
  const birthday = text(form.get("birthday"));
  const notes = text(form.get("notes"));
  if (
    name.length > MAX_NAME_CHARS ||
    howKnown.length > MAX_FIELD_CHARS ||
    notes.length > MAX_NOTES_CHARS ||
    aliases.length > MAX_LIST_ITEMS ||
    tags.length > MAX_LIST_ITEMS ||
    [...aliases, ...tags].some((x) => x.length > MAX_NAME_CHARS)
  ) {
    return { ok: false, error: "too-long" };
  }
  if (birthday !== "" && !validDate(birthday)) return { ok: false, error: "bad-birthday" };
  return {
    ok: true,
    value: { name, aliases, howKnown: howKnown || null, birthday: birthday || null, notes: notes || null, tags },
  };
}

// ---------------------------------------------------------------- contact CRUD

export interface ContactRow extends ContactInput {
  id: string;
}

const COLS = "id, name, aliases, how_known, birthday::text AS birthday, notes, tags";

interface DbContact {
  id: string;
  name: string;
  aliases: string[];
  how_known: string | null;
  birthday: string | null;
  notes: string | null;
  tags: string[];
}

const toContact = (r: DbContact): ContactRow => ({
  id: r.id,
  name: r.name,
  aliases: r.aliases,
  howKnown: r.how_known,
  birthday: r.birthday,
  notes: r.notes,
  tags: r.tags,
});

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Contacts by name; `q` keeps those whose name, an alias or a tag contains it (case-insensitive). */
export async function listContacts(db: Queryable, q = "", limit = 500): Promise<ContactRow[]> {
  const term = q.trim();
  const params: unknown[] = [limit];
  let where = "";
  if (term !== "") {
    params.push(`%${likeEscape(term)}%`);
    where = `WHERE name ILIKE $2
        OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE a ILIKE $2)
        OR EXISTS (SELECT 1 FROM unnest(tags) t WHERE t ILIKE $2)`;
  }
  const { rows } = await db.query<DbContact>(`SELECT ${COLS} FROM contacts ${where} ORDER BY lower(name), id LIMIT $1`, params);
  return rows.map(toContact);
}

export async function getContact(db: Queryable, id: string): Promise<ContactRow | null> {
  const { rows } = await db.query<DbContact>(`SELECT ${COLS} FROM contacts WHERE id = $1`, [id]);
  return rows[0] ? toContact(rows[0]) : null;
}

export async function createContact(db: Queryable, c: ContactInput): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO contacts (name, aliases, how_known, birthday, notes, tags) VALUES ($1, $2::text[], $3, $4::date, $5, $6::text[]) RETURNING id",
    [c.name, c.aliases, c.howKnown, c.birthday, c.notes, c.tags],
  );
  return rows[0]!.id;
}

/** Returns false when the contact does not exist. */
export async function updateContact(db: Queryable, id: string, c: ContactInput): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE contacts SET name = $2, aliases = $3::text[], how_known = $4, birthday = $5::date, notes = $6, tags = $7::text[],
            updated_at = now()
      WHERE id = $1 RETURNING id`,
    [id, c.name, c.aliases, c.howKnown, c.birthday, c.notes, c.tags],
  );
  return rows.length > 0;
}

/**
 * Deletes a contact. The foreign key sets its notes' contact_id to NULL; their link_status becomes 'none' in the
 * same transaction. Returns false when the contact does not exist.
 */
export async function deleteContact(db: Queryable, id: string): Promise<boolean> {
  await db.query("UPDATE crm_notes SET link_status = 'none' WHERE contact_id = $1", [id]);
  const { rows } = await db.query("DELETE FROM contacts WHERE id = $1 RETURNING id", [id]);
  return rows.length > 0;
}

// ---------------------------------------------------------------- matching

export interface MatchContact {
  id: string;
  name: string;
  aliases: string[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when `term` occurs in `body` as a whole word (letters, digits and underscore do not touch it), ignoring case. */
export function containsWord(body: string, term: string): boolean {
  const t = term.trim();
  if (t === "") return false;
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(t)}(?![\\p{L}\\p{N}_])`, "iu").test(body);
}

/** The contacts whose name or an alias occurs in the body as a whole word, in the given order. */
export function matchContacts(body: string, contacts: readonly MatchContact[]): MatchContact[] {
  return contacts.filter((c) => [c.name, ...c.aliases].some((t) => containsWord(body, t)));
}

// ---------------------------------------------------------------- note links

export type LinkStatus = "linked" | "ambiguous" | "none";
export type LinkOutcome = LinkStatus | "not-found";

/** "Which contact: " plus the first 60 characters of the note on one line (an ellipsis only when cut). */
export function contactMatchTitle(body: string): string {
  const line = body.replace(/\s+/g, " ").trim();
  return `Which contact: ${line.length > 60 ? `${line.slice(0, 60)}…` : line}`;
}

const CLOSE_MATCH_ITEM =
  "UPDATE inbox_items SET status = 'done', resolved_at = now() WHERE kind = 'contact_match' AND ref_table = 'crm_notes' AND ref_id = $1 AND status = 'open'";

/**
 * Links a CRM note to a contact by name match. Exactly one contact matches: linked. More than one: ambiguous, with
 * one open contact_match inbox item (calling again adds no second). None: none. A result other than ambiguous
 * closes an open item left from before. Call it inside one transaction (withDb does).
 */
export async function linkCrmNote(db: Queryable, noteId: string): Promise<LinkOutcome> {
  const note = await db.query<{ body: string }>("SELECT body FROM crm_notes WHERE id = $1", [noteId]);
  if (!note.rows[0]) return "not-found";
  const body = note.rows[0].body;
  const all = await db.query<MatchContact>("SELECT id, name, aliases FROM contacts");
  const hits = matchContacts(body, all.rows);

  if (hits.length === 1) {
    await db.query("UPDATE crm_notes SET contact_id = $2, link_status = 'linked' WHERE id = $1", [noteId, hits[0]!.id]);
    await db.query(CLOSE_MATCH_ITEM, [noteId]);
    return "linked";
  }
  await db.query("UPDATE crm_notes SET contact_id = NULL, link_status = $2 WHERE id = $1", [
    noteId,
    hits.length > 1 ? "ambiguous" : "none",
  ]);
  if (hits.length === 0) {
    await db.query(CLOSE_MATCH_ITEM, [noteId]);
    return "none";
  }
  await db.query(
    `INSERT INTO inbox_items (kind, ref_table, ref_id, title)
     SELECT 'contact_match', 'crm_notes', $1::text, $2
      WHERE NOT EXISTS (SELECT 1 FROM inbox_items WHERE kind = 'contact_match' AND ref_table = 'crm_notes' AND ref_id = $1::text AND status = 'open')`,
    [noteId, contactMatchTitle(body)],
  );
  return "ambiguous";
}

export type ResolveOutcome = "ok" | "note-not-found" | "contact-not-found";

/** The owner's choice: a contact (link) or null (no contact). Closes the note's open contact_match item. */
export async function resolveCrmNote(db: Queryable, noteId: string, contactId: string | null): Promise<ResolveOutcome> {
  if (contactId !== null) {
    const c = await db.query("SELECT 1 FROM contacts WHERE id = $1", [contactId]);
    if (c.rows.length === 0) return "contact-not-found";
  }
  const { rows } = await db.query(
    "UPDATE crm_notes SET contact_id = $2, link_status = $3 WHERE id = $1 RETURNING id",
    [noteId, contactId, contactId === null ? "none" : "linked"],
  );
  if (rows.length === 0) return "note-not-found";
  await db.query(CLOSE_MATCH_ITEM, [noteId]);
  return "ok";
}

export interface NoteRow {
  id: string;
  body: string;
  createdAt: string;
  linkStatus: LinkStatus;
  contactId: string | null;
  contactName: string | null;
}

/** CRM notes, newest first; `contactId` keeps one contact's notes. */
export async function listCrmNotes(db: Queryable, opts: { contactId?: string; limit?: number } = {}): Promise<NoteRow[]> {
  const params: unknown[] = [opts.limit ?? 100];
  let where = "";
  if (opts.contactId) {
    params.push(opts.contactId);
    where = "WHERE n.contact_id = $2";
  }
  const { rows } = await db.query<{
    id: string;
    body: string;
    created_at: Date | string;
    link_status: LinkStatus;
    contact_id: string | null;
    contact_name: string | null;
  }>(
    `SELECT n.id, n.body, n.created_at, n.link_status, n.contact_id, c.name AS contact_name
       FROM crm_notes n LEFT JOIN contacts c ON c.id = n.contact_id
      ${where}
      ORDER BY n.created_at DESC, n.id DESC LIMIT $1`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    body: r.body,
    createdAt: new Date(r.created_at).toISOString(),
    linkStatus: r.link_status,
    contactId: r.contact_id,
    contactName: r.contact_name,
  }));
}

export interface ContactMatch {
  noteId: string;
  body: string;
  createdAt: string;
  /** The contacts whose name or alias is in the note. */
  candidates: { id: string; name: string }[];
}

/** Notes with an open contact_match inbox item (oldest item first), each with the contacts that matched. */
export async function listOpenContactMatches(db: Queryable): Promise<ContactMatch[]> {
  const items = await db.query<{ id: string; body: string; created_at: Date | string }>(
    `SELECT n.id, n.body, n.created_at
       FROM inbox_items i JOIN crm_notes n ON n.id::text = i.ref_id
      WHERE i.kind = 'contact_match' AND i.ref_table = 'crm_notes' AND i.status = 'open'
      ORDER BY i.created_at, i.id`,
  );
  if (items.rows.length === 0) return [];
  const all = await db.query<MatchContact>("SELECT id, name, aliases FROM contacts ORDER BY lower(name), id");
  return items.rows.map((r) => ({
    noteId: r.id,
    body: r.body,
    createdAt: new Date(r.created_at).toISOString(),
    candidates: matchContacts(r.body, all.rows).map((c) => ({ id: c.id, name: c.name })),
  }));
}
