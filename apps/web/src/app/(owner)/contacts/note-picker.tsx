// The form that links, relinks or unlinks one CRM note. Plain server-action form (works without JS).
import type { ReactNode } from "react";
import s from "../owner.module.css";
import { resolveNoteAction } from "./actions";

export function NotePicker({
  noteId,
  options,
  current,
  back,
  allowNone = true,
  children,
}: {
  noteId: string;
  options: { id: string; name: string }[];
  current: string | null;
  back: "/contacts" | "/inbox";
  allowNone?: boolean;
  children?: ReactNode;
}) {
  return (
    <form action={resolveNoteAction} className={s.formRow}>
      <input type="hidden" name="note_id" value={noteId} />
      <input type="hidden" name="back" value={back} />
      <label className={s.fieldLabel}>
        Contact
        <select className={s.field} name="contact_id" defaultValue={current ?? (allowNone ? "" : undefined)} required={!allowNone}>
          {allowNone ? <option value="">No contact</option> : <option value="" disabled>Choose a contact</option>}
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </label>
      <button className={s.button} type="submit">
        Save
      </button>
      {children}
    </form>
  );
}
