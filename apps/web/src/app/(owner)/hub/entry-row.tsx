import Link from "next/link";
import { entryStatus, ROUTE_LABELS, type EntryRow, type RouteKind } from "@/server/capture";
import { formatUtc } from "../format";
import { Dot } from "../owner-ui";
import s from "../owner.module.css";
import { reassignAction, routeAgainAction } from "./actions";

const KINDS = Object.keys(ROUTE_LABELS) as RouteKind[];

/** One entry with its state word, the route picker and, where routing is configured, "Route again". */
export function EntryItem({ e, routing }: { e: EntryRow; routing: boolean }) {
  const status = entryStatus(e);
  return (
    <li data-entry-id={e.id}>
      <p className={s.entryText}>{e.rawText}</p>
      <p className={s.entryMeta}>
        <time className={s.mono} dateTime={e.createdAt}>
          {formatUtc(e.createdAt)}
        </time>
        <span className={s.statusWord}>
          <Dot tone={status.tone} />
          {e.status === "needs_owner" ? (
            <Link href="/inbox#routing" className={s.emph}>
              <span data-field="status">{status.label}</span>
            </Link>
          ) : (
            <span data-field="status" className={s.emph}>
              {status.label}
            </span>
          )}
        </span>
      </p>
      <form action={reassignAction} className={s.formRow}>
        <input type="hidden" name="entry_id" value={e.id} />
        <label className={s.fieldLabel}>
          Route
          <select className={s.field} name="to" defaultValue={e.routeKind ?? ""} required>
            <option value="" disabled>
              Choose a kind
            </option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {ROUTE_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <button className={s.button} type="submit">
          Save
        </button>
        {routing && e.routeKind === null ? (
          <button className={s.button} type="submit" formAction={routeAgainAction} formNoValidate>
            Route again
          </button>
        ) : null}
      </form>
    </li>
  );
}
