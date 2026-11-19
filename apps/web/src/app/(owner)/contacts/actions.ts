"use server";
// Contacts actions. Each checks the owner first (server actions are POST endpoints of their own) and ends in a
// redirect with a fixed notice code, never contact or note text.
import { redirect } from "next/navigation";
import {
  createContact,
  deleteContact,
  isContactId,
  parseContact,
  resolveCrmNote,
  updateContact,
} from "@/server/contacts";
import { withDb } from "@/server/db";
// Relative on purpose: the action tests mock the "@/server/*" modules one by one and do not resolve the alias.
import { entryOf, publishNow } from "../../../server/publish";

import { requireOwner } from "@/server/owner";
import { contactFailure, type ContactNoticeCode } from "./notices";

export async function createContactAction(formData: FormData): Promise<void> {
  await requireOwner();
  const parsed = parseContact(formData);
  if (!parsed.ok) redirect(`/contacts/new?n=${parsed.error}`);
  let target: string;
  try {
    const id = await withDb("web_rw", (db) => createContact(db, parsed.value));
    target = `/contacts/${id}?n=created`;
  } catch (err) {
    target = `/contacts/new?n=${contactFailure(err)}`;
  }
  redirect(target);
}

export async function updateContactAction(formData: FormData): Promise<void> {
  await requireOwner();
  const id = formData.get("id");
  if (!isContactId(id)) redirect("/contacts?n=invalid");
  const parsed = parseContact(formData);
  if (!parsed.ok) redirect(`/contacts/${id}?n=${parsed.error}`);
  let target: string;
  try {
    const found = await withDb("web_rw", (db) => updateContact(db, id, parsed.value));
    target = found ? `/contacts/${id}?n=saved` : "/contacts?n=not-found";
  } catch (err) {
    target = `/contacts/${id}?n=${contactFailure(err)}`;
  }
  redirect(target);
}

export async function deleteContactAction(formData: FormData): Promise<void> {
  await requireOwner();
  const id = formData.get("id");
  if (!isContactId(id)) redirect("/contacts?n=invalid");
  let notice: ContactNoticeCode;
  try {
    notice = (await withDb("web_rw", (db) => deleteContact(db, id))) ? "deleted" : "not-found";
  } catch (err) {
    notice = contactFailure(err);
  }
  redirect(`/contacts?n=${notice}`);
}

// Where a note form returns to: the contacts page, or the inbox (the inbox region passes back=/inbox).
const BACK = new Set(["/contacts", "/inbox"]);

/** The owner's choice for a note: contact_id a contact, or empty for no contact. */
export async function resolveNoteAction(formData: FormData): Promise<void> {
  await requireOwner();
  const rawBack = formData.get("back");
  const back = typeof rawBack === "string" && BACK.has(rawBack) ? rawBack : "/contacts";
  const noteId = formData.get("note_id");
  const raw = formData.get("contact_id");
  const contactId = raw === "" || raw === null ? null : raw;
  if (!isContactId(noteId) || (contactId !== null && !isContactId(contactId))) redirect(`${back}?n=invalid`);
  let notice: ContactNoticeCode;
  try {
    const res = await withDb("web_rw", (db) => resolveCrmNote(db, noteId, contactId));
    notice = res === "ok" ? (contactId === null ? "note-unlinked" : "note-linked") : res === "note-not-found" ? "note-not-found" : "not-found";
    if (res === "ok") await publishNow(await entryOf("crm_note", noteId)); // the contact choice updates a published record
  } catch (err) {
    notice = contactFailure(err);
  }
  redirect(`${back}?n=${notice}`);
}
