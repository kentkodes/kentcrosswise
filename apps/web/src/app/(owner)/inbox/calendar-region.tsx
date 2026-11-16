// Server component for /inbox: pending calendar suggestions (H5), each with Add to Google Calendar and Dismiss.
// Without a Google Calendar connection the Add button is replaced by a link to /connections. Loads its own data;
// a failure shows one fixed line.
import Link from "next/link";
import { listPendingSuggestions, type PendingSuggestion } from "@/server/calendar";
import { DbNotConfiguredError, dbErrorLabel, withDb } from "@/server/db";
import { googleConnection } from "@/server/google";
import { requireOwner } from "@/server/owner";
import { Notice, Region } from "../owner-ui";
import s from "../owner.module.css";
import { addSuggestionAction, dismissSuggestionAction } from "./calendar-actions";
import { calendarNotice } from "./calendar-notices";
import c from "./calendar-region.module.css";

async function calendarConnected(): Promise<boolean> {
  try {
    return (await googleConnection()).scopes.includes("calendar");
  } catch (err) {
    console.error(`[calendar] connection-${err instanceof Error ? err.name : "error"}`);
    return false;
  }
}

export async function CalendarSuggestionRegion({ code }: { code?: string | string[] }) {
  await requireOwner();
  let rows: PendingSuggestion[] = [];
  let problem: string | undefined;
  try {
    rows = await withDb("web_rw", (db) => listPendingSuggestions(db), { readOnly: true });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) problem = "The database is not connected yet.";
    else {
      console.error(`[calendar] ${dbErrorLabel(err)}`);
      problem = "The database is unavailable right now.";
    }
  }
  const connected = rows.length > 0 ? await calendarConnected() : false;
  const notice = calendarNotice(code);

  return (
    <Region id="calendar" title="Calendar" testId="calendar" aside={<span className={s.count}>{rows.length}</span>}>
      {notice ? (
        <Notice role="status" tone={notice.ok ? "ok" : "warn"}>
          {notice.text}
        </Notice>
      ) : null}
      {problem ? (
        <Notice role="alert" tone="warn">
          {problem}
        </Notice>
      ) : rows.length === 0 ? (
        <p className={`${s.note} ${s.pad}`}>No calendar suggestions.</p>
      ) : (
        <ul className={s.list}>
          {rows.map((r) => (
            <li key={r.id} data-suggestion-id={r.id}>
              <p className={c.title}>{r.title}</p>
              <p className={c.when}>
                <span className={s.mono}>{r.when}</span> <span>{r.timeZone}</span>
              </p>
              <form className={s.formRow}>
                <input type="hidden" name="suggestion_id" value={r.id} />
                {connected ? (
                  <button className={`${s.button} ${s.primary}`} type="submit" formAction={addSuggestionAction}>
                    Add to calendar
                  </button>
                ) : (
                  <Link className={s.button} href="/connections">
                    Connect Google to add
                  </Link>
                )}
                <button className={s.button} type="submit" formAction={dismissSuggestionAction}>
                  Dismiss
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </Region>
  );
}
