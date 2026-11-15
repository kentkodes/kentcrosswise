// Server component for the inbox (the Liaison wires it in): the notes whose name match was ambiguous, each with
// a choice among the matching contacts or "No contact". Loads its own data; a failure shows one fixed line.
import { listOpenContactMatches, type ContactMatch } from "@/server/contacts";
import { DbNotConfiguredError, dbErrorLabel, withDb } from "@/server/db";
import { formatUtc } from "../format";
import { Notice, Region } from "../owner-ui";
import s from "../owner.module.css";
import c from "./contacts.module.css";
import { NotePicker } from "./note-picker";

export async function ContactMatchRegion() {
  let rows: ContactMatch[] = [];
  let problem: string | undefined;
  try {
    rows = await withDb("web_rw", (db) => listOpenContactMatches(db), { readOnly: true });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) problem = "The database is not connected yet.";
    else {
      console.error(`[contacts] ${dbErrorLabel(err)}`);
      problem = "The database is unavailable right now.";
    }
  }

  return (
    <Region id="contact-matches" title="Which contact" testId="contact-matches" aside={<span className={s.count}>{rows.length}</span>}>
      {problem ? (
        <Notice role="alert" tone="warn">
          {problem}
        </Notice>
      ) : rows.length === 0 ? (
        <p className={`${s.note} ${s.pad}`}>No notes are waiting for a contact.</p>
      ) : (
        <ol className={s.list}>
          {rows.map((m) => (
            <li key={m.noteId} data-note-id={m.noteId}>
              <p className={c.noteBody}>{m.body}</p>
              <p className={c.meta}>
                <time className={s.mono} dateTime={m.createdAt}>
                  {formatUtc(m.createdAt)}
                </time>
              </p>
              <NotePicker noteId={m.noteId} options={m.candidates} current={null} back="/inbox" />
            </li>
          ))}
        </ol>
      )}
    </Region>
  );
}
