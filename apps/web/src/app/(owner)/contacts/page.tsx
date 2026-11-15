import type { Metadata } from "next";
import Link from "next/link";
import { listContacts, listCrmNotes, type ContactRow, type NoteRow } from "@/server/contacts";
import { DbNotConfiguredError, dbErrorLabel, withDb } from "@/server/db";
import { requireOwner } from "@/server/owner";
import { formatUtc } from "../format";
import { OwnerFrame } from "../owner-frame";
import { Dot, Notice, Region } from "../owner-ui";
import s from "../owner.module.css";
import c from "./contacts.module.css";
import { NotePicker } from "./note-picker";
import { contactNotice } from "./notices";

export const metadata: Metadata = { title: "Contacts | Kentcrosswise" };

interface Loaded {
  contacts?: ContactRow[];
  notes?: NoteRow[];
  problem?: string;
}

async function load(q: string): Promise<Loaded> {
  try {
    return await withDb(
      "web_rw",
      async (db) => ({ contacts: await listContacts(db, q), notes: await listCrmNotes(db) }),
      { readOnly: true },
    );
  } catch (err) {
    if (err instanceof DbNotConfiguredError) return { problem: "The database is not connected yet." };
    console.error(`[contacts] ${dbErrorLabel(err)}`);
    return { problem: "The database is unavailable right now." };
  }
}

function linkState(n: NoteRow): { label: string; tone: "ok" | "warn" | "idle" } {
  if (n.linkStatus === "linked" && n.contactName !== null) return { label: `Linked to ${n.contactName}`, tone: "ok" };
  if (n.linkStatus === "ambiguous") return { label: "Choose a contact", tone: "warn" };
  return { label: "No contact", tone: "idle" };
}

export default async function ContactsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner();
  const sp = await searchParams;
  const notice = contactNotice(sp.n);
  const q = typeof sp.q === "string" ? sp.q.slice(0, 200) : "";
  const { contacts, notes, problem } = await load(q);
  const options = (contacts ?? []).map((x) => ({ id: x.id, name: x.name }));

  return (
    <OwnerFrame
      title="Contacts"
      current="/contacts"
      actions={
        <Link className={`${s.button} ${s.primary}`} href="/contacts/new">
          Add contact
        </Link>
      }
    >
      {notice ? (
        <Notice role={notice.ok ? "status" : "alert"} tone={notice.ok ? "ok" : "warn"}>
          {notice.text}
        </Notice>
      ) : null}

      <Region id="contact-list" title="People" testId="contacts" aside={contacts ? <span className={s.count}>{contacts.length}</span> : undefined}>
        <form method="get" action="/contacts" className={c.filter} role="search">
          <label className={s.fieldLabel}>
            Filter
            <input className={s.field} type="search" name="q" defaultValue={q} placeholder="Name, alias or tag" autoComplete="off" />
          </label>
          <button className={s.button} type="submit">
            Filter
          </button>
          {q ? (
            <Link className={s.button} href="/contacts">
              Clear
            </Link>
          ) : null}
        </form>
        {problem ? (
          <Notice role="alert" tone="warn">
            {problem}
          </Notice>
        ) : contacts && contacts.length === 0 ? (
          <p className={`${s.note} ${s.pad}`}>{q ? "No contact matches that." : "No contacts yet."}</p>
        ) : contacts ? (
          <ul className={s.list}>
            {contacts.map((x) => (
              <li key={x.id} data-contact-id={x.id}>
                <Link className={`${s.label} ${s.emph}`} href={`/contacts/${x.id}`}>
                  {x.name}
                </Link>
                {x.aliases.length > 0 ? <p className={c.meta}>Also: {x.aliases.join(", ")}</p> : null}
                {x.howKnown ? <p className={c.meta}>{x.howKnown}</p> : null}
                {x.tags.length > 0 ? <p className={c.meta}>Tags: {x.tags.join(", ")}</p> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Region>

      <Region id="contact-notes" title="Notes" testId="notes">
        {notes && notes.length === 0 ? (
          <p className={`${s.note} ${s.pad}`}>No CRM notes yet.</p>
        ) : notes ? (
          <ol className={s.list}>
            {notes.map((n) => {
              const st = linkState(n);
              return (
                <li key={n.id} data-note-id={n.id}>
                  <p className={c.noteBody}>{n.body}</p>
                  <p className={c.meta}>
                    <time className={s.mono} dateTime={n.createdAt}>
                      {formatUtc(n.createdAt)}
                    </time>{" "}
                    <span className={s.statusWord}>
                      <Dot tone={st.tone} />
                      <span data-field="link" className={s.emph}>
                        {st.label}
                      </span>
                    </span>
                  </p>
                  <NotePicker noteId={n.id} options={options} current={n.contactId} back="/contacts" />
                </li>
              );
            })}
          </ol>
        ) : null}
      </Region>
    </OwnerFrame>
  );
}
