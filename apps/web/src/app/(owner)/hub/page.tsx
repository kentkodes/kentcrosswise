import type { Metadata } from "next";
import Link from "next/link";
import { entryStatus, listRecentEntries, MAX_CAPTURE_CHARS, type EntryRow } from "@/server/capture";
import { DbNotConfiguredError, dbErrorLabel, withDb } from "@/server/db";
import { requireOwner } from "@/server/owner";
import { formatUtc } from "../format";
import { noticeText } from "../notices";
import { OwnerFrame } from "../owner-frame";
import { Dot, Notice, Region } from "../owner-ui";
import s from "../owner.module.css";
import { captureAction } from "./actions";
import { CaptureField } from "./capture-field";

export const metadata: Metadata = { title: "Hub | Kentcrosswise" };

const PAGES = [
  { href: "/console", label: "Boss console", note: "Create tasks, follow them, pause switches" },
  { href: "/inbox", label: "Inbox", note: "Approvals waiting on you" },
  { href: "/console/usage", label: "Usage", note: "Model cost, spend cap, Actions minutes" },
  { href: "/essays", label: "Essays", note: "Library, recommendations and setup" },
] as const;

async function loadRecent(): Promise<{ rows?: EntryRow[]; problem?: string }> {
  try {
    const rows = await withDb("web_rw", (db) => listRecentEntries(db), { readOnly: true });
    return { rows };
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
  const saved = code === "captured";
  const { rows, problem } = await loadRecent();

  return (
    <OwnerFrame title="Hub" current="/hub">
      {notice ? (
        <Notice role={saved ? "status" : "alert"} tone={saved ? "ok" : "warn"}>
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

      <Region id="recent" title="Recent" testId="recent">
        {problem ? (
          <Notice role="alert" tone="warn">
            {problem}
          </Notice>
        ) : rows && rows.length === 0 ? (
          <p className={`${s.note} ${s.pad}`}>Nothing captured yet.</p>
        ) : rows ? (
          <ol className={s.list} data-testid="entries">
            {rows.map((e) => {
              const status = entryStatus(e);
              return (
                <li key={e.id} data-entry-id={e.id}>
                  <p className={s.entryText}>{e.rawText}</p>
                  <p className={s.entryMeta}>
                    <time className={s.mono} dateTime={e.createdAt}>
                      {formatUtc(e.createdAt)}
                    </time>
                    <span className={s.statusWord}>
                      <Dot tone={status.tone} />
                      <span data-field="status" className={s.emph}>
                        {status.label}
                      </span>
                    </span>
                  </p>
                </li>
              );
            })}
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
