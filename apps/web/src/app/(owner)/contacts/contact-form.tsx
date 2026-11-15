// The create/edit form for a contact. Aliases and tags are typed comma-separated.
import type { ContactRow } from "@/server/contacts";
import s from "../owner.module.css";
import c from "./contacts.module.css";

export function ContactForm({
  action,
  contact,
  submitLabel,
}: {
  action: (formData: FormData) => Promise<void>;
  contact?: ContactRow;
  submitLabel: string;
}) {
  return (
    <form action={action} className={c.form}>
      {contact ? <input type="hidden" name="id" value={contact.id} /> : null}
      <label className={s.fieldLabel}>
        Name
        <input className={s.field} name="name" required maxLength={200} defaultValue={contact?.name ?? ""} autoComplete="off" />
      </label>
      <label className={s.fieldLabel}>
        Aliases
        <input className={s.field} name="aliases" defaultValue={contact?.aliases.join(", ") ?? ""} placeholder="Comma separated" autoComplete="off" />
      </label>
      <label className={s.fieldLabel}>
        How known
        <input className={s.field} name="how_known" maxLength={2000} defaultValue={contact?.howKnown ?? ""} autoComplete="off" />
      </label>
      <label className={s.fieldLabel}>
        Birthday
        <input className={s.field} type="date" name="birthday" defaultValue={contact?.birthday ?? ""} />
      </label>
      <label className={s.fieldLabel}>
        Notes
        <textarea className={s.field} name="notes" rows={4} maxLength={10000} defaultValue={contact?.notes ?? ""} />
      </label>
      <label className={s.fieldLabel}>
        Tags
        <input className={s.field} name="tags" defaultValue={contact?.tags.join(", ") ?? ""} placeholder="Comma separated" autoComplete="off" />
      </label>
      <div>
        <button className={`${s.button} ${s.primary} ${s.tapTarget}`} type="submit">
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
