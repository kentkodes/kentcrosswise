import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getContact, isContactId, listContacts, listCrmNotes, type ContactRow, type NoteRow } from "@/server/contacts";
import { DbNotConfiguredError, dbErrorLabel, withDb } from "@/server/db";
import { requireOwner } from "@/server/owner";
import { formatUtc } from "../../format";
import { OwnerFrame } from "../../owner-frame";
import { Notice, Region } from "../../owner-ui";
import s from "../../owner.module.css";
import { deleteContactAction, updateContactAction } from "../actions";
import { ContactForm } from "../contact-form";
import c from "../contacts.module.css";
import { NotePicker } from "../note-picker";
import { contactNotice } from "../notices";

export const metadata: Metadata = { title: "Contact | Kentcrosswise" };

interface Loaded {
  contact?: ContactRow | null;
  notes?: NoteRow[];
  options?: { id: string; name: string }[];
  problem?: string;
}

async function load(id: string): Promise<Loaded> {
  try {
    return await withDb(
      "web_rw",
      async (db) => {
        const contact = await getContact(db, id);
        if (!contact) return { contact };
        const notes = await listCrmNotes(db, { contactId: id });
        const options = (await listContacts(db)).map((x) => ({ id: x.id, name: x.name }));
        return { contact, notes, options };
      },
      { readOnly: true },
    );
  } catch (err) {
    if (err instanceof DbNotConfiguredError) return { problem: "The database is not connected yet." };
    console.error(`[contacts] ${dbErrorLabel(err)}`);
    return { problem: "The database is unavailable right now." };
  }
}

export default async function ContactPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOwner();
  const { id } = await params;
  if (!isContactId(id)) notFound();
  const notice = contactNotice((await searchParams).n);
  const { contact, notes, options, problem } = await load(id);
  if (contact === null) notFound();

  return (
    <OwnerFrame
      title={contact ? contact.name : "Contact"}
      current="/contacts"
      actions={
        <Link className={s.button} href="/contacts">
          All contacts
        </Link>
      }
    >
      {notice ? (
        <Notice role={notice.ok ? "status" : "alert"} tone={notice.ok ? "ok" : "warn"}>
          {notice.text}
        </Notice>
      ) : null}
      {problem || !contact ? (
        <Notice role="alert" tone="warn">
          {problem ?? "The database is unavailable right now."}
        </Notice>
      ) : (
        <>
          <Region id="contact-edit" title="Details" testId="contact">
            <ContactForm action={updateContactAction} contact={contact} submitLabel="Save" />
          </Region>

          <Region id="contact-notes" title="Linked notes" testId="linked-notes" aside={<span className={s.count}>{notes?.length ?? 0}</span>}>
            {notes && notes.length > 0 ? (
              <ol className={s.list}>
                {notes.map((n) => (
                  <li key={n.id} data-note-id={n.id}>
                    <p className={c.noteBody}>{n.body}</p>
                    <p className={c.meta}>
                      <time className={s.mono} dateTime={n.createdAt}>
                        {formatUtc(n.createdAt)}
                      </time>
                    </p>
                    <NotePicker noteId={n.id} options={options ?? []} current={n.contactId} back="/contacts" />
                  </li>
                ))}
              </ol>
            ) : (
              <p className={`${s.note} ${s.pad}`}>No notes are linked to this contact.</p>
            )}
          </Region>

          <Region id="contact-delete" title="Delete">
            <div className={s.pad}>
              <details className={c.danger}>
                <summary>Delete this contact</summary>
                <form action={deleteContactAction} className={s.formRow}>
                  <input type="hidden" name="id" value={contact.id} />
                  <p className={s.note}>This removes the contact. Its notes stay and become unlinked.</p>
                  <button className={s.button} type="submit">
                    Confirm delete
                  </button>
                </form>
              </details>
            </div>
          </Region>
        </>
      )}
    </OwnerFrame>
  );
}
