import type { Metadata } from "next";
import Link from "next/link";
import { listRecentEntries, listUnresolvedEntries, MAX_CAPTURE_CHARS, type EntryRow } from "@/server/capture";
import { DbNotConfiguredError, dbErrorLabel, withDb } from "@/server/db";
import { requireOwner } from "@/server/owner";
import { routingEnabled } from "@/server/router";
import { isSuccessNotice, noticeText } from "../notices";
import { OwnerFrame } from "../owner-frame";
import { Notice, Region } from "../owner-ui";
import s from "../owner.module.css";
import { captureAction } from "./actions";
import { CaptureField } from "./capture-field";
import { EntryItem } from "./entry-row";

export const metadata: Metadata = { title: "Hub | Kentcrosswise" };

const PAGES = [
  { href: "/contacts", label: "Contacts", note: "People and the notes about them" },
  { href: "/diary", label: "Diary", note: "Entries, scored for mood" },
  { href: "/mood", label: "Mood", note: "Mood scores over time" },
  { href: "/todos", label: "Todos", note: "Things to do" },
  { href: "/ideas", label: "Ideas", note: "Ideas and project thoughts" },
  { href: "/projects", label: "Projects", note: "One tab per project" },
  { href: "/console", label: "Boss console", note: "Create tasks, follow them, pause switches" },
  { href: "/inbox", label: "Inbox", note: "Approvals and routing waiting on you" },
  { href: "/console/usage", label: "Usage", note: "Model cost, spend cap, Actions minutes" },
  { href: "/essays", label: "Essays", note: "Library, recommendations and setup" },
  { href: "/connections", label: "Connections", note: "Google Calendar access" },
  { href: "/notifications", label: "Notifications", note: "Push notifications for new inbox items" },
] as const;

async function loadRecent(): Promise<{ rows?: EntryRow[]; unresolved?: EntryRow[]; problem?: string }> {
  try {
    return await withDb(
      "web_rw",
      async (db) => ({ rows: await listRecentEntries(db), unresolved: await listUnresolvedEntries(db) }),
      { readOnly: true },
    );
  } catch (err) {
    if (err instanceof DbNotConfiguredError) return { problem: "The database is not connected yet." };
    console.error(`[hub] ${dbErrorLabel(err)}`);
    return { problem: "The database is unavailable right now." };
  }
}

export default async function HubPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner();
  const code = (await searchParams).n;
  const notice = noticeText(code);
  const ok = isSuccessNotice(code);
  const routing = routingEnabled(process.env);
  const { rows, unresolved, problem } = await loadRecent();

  return (
    <OwnerFrame title="Hub" current="/hub">
      {notice ? (
        <Notice role={ok ? "status" : "alert"} tone={ok ? "ok" : "warn"}>
          {notice}
        </Notice>
      ) : null}

      <Region id="capture" testId="capture">
        <form action={captureAction} className={`${s.pad} ${s.stack}`}>
          <label className={s.fieldLabel} htmlFor="raw_text">
            Capture
          </label>
          <CaptureField maxLength={MAX_CAPTURE_CHARS} />
          <div>
            <button className={`${s.button} ${s.primary} ${s.tapTarget}`} type="submit">
              Save
            </button>
          </div>
        </form>
      </Region>

      <Region id="unresolved" title="Unresolved" testId="unresolved">
        {problem ? null : unresolved && unresolved.length > 0 ? (
          <ol className={s.list} data-testid="unresolved-entries">
            {unresolved.map((e) => (
              <EntryItem key={e.id} e={e} routing={routing} />
            ))}
          </ol>
        ) : (
          <p className={`${s.note} ${s.pad}`}>Nothing is waiting.</p>
        )}
      </Region>

      <Region id="recent" title="Recent" testId="recent">
        {problem ? (
          <Notice role="alert" tone="warn">
            {problem}
          </Notice>
        ) : rows && rows.length === 0 ? (
          <p className={`${s.note} ${s.pad}`}>Nothing captured yet.</p>
        ) : rows ? (
          <ol className={s.list} data-testid="entries">
            {rows.map((e) => (
              <EntryItem key={e.id} e={e} routing={routing} />
            ))}
          </ol>
        ) : null}
      </Region>

      <Region>
        <ul className={s.list}>
          {PAGES.map((p) => (
            <li key={p.href}>
              <Link className={s.label} href={p.href}>
                {p.label}
              </Link>
              <p className={s.note}>{p.note}</p>
            </li>
          ))}
        </ul>
      </Region>
    </OwnerFrame>
  );
}
