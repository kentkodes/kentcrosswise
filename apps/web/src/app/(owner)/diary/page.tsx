import type { Metadata } from "next";
import Link from "next/link";
import { DbNotConfiguredError, dbErrorLabel, withDb } from "@/server/db";
import { LIST_LIMIT, listDiary, MAX_DIARY_CHARS, moodSummaryLine, type DiaryRow } from "@/server/diary";
import { requireOwner } from "@/server/owner";
import { routingEnabled } from "@/server/router";
import { formatUtc } from "../format";
import { OwnerFrame } from "../owner-frame";
import { Notice, Region } from "../owner-ui";
import s from "../owner.module.css";
import { saveDiaryAction } from "./actions";
import d from "./diary.module.css";
import { diaryNoticeText, isDiarySuccess } from "./notices";

export const metadata: Metadata = { title: "Diary | Kentcrosswise" };

async function load(): Promise<{ rows?: DiaryRow[]; problem?: string }> {
  try {
    return { rows: await withDb("web_rw", (db) => listDiary(db), { readOnly: true }) };
  } catch (err) {
    if (err instanceof DbNotConfiguredError) return { problem: "The database is not connected yet." };
    console.error(`[diary] ${dbErrorLabel(err)}`);
    return { problem: "The database is unavailable right now." };
  }
}

export default async function DiaryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner();
  const code = (await searchParams).n;
  const notice = diaryNoticeText(code);
  const ok = isDiarySuccess(code);
  const scoring = routingEnabled(process.env);
  const { rows, problem } = await load();

  return (
    <OwnerFrame
      title="Diary"
      current="/hub"
      actions={
        <Link className={s.button} href="/mood">
          Mood board
        </Link>
      }
    >
      {notice ? (
        <Notice role={ok ? "status" : "alert"} tone={ok ? "ok" : "warn"}>
          {notice}
        </Notice>
      ) : null}

      <Region id="write" testId="diary-editor">
        <form action={saveDiaryAction} className={`${s.pad} ${s.stack}`}>
          <label className={s.fieldLabel} htmlFor="diary_body">
            New entry
          </label>
          <textarea id="diary_body" name="body" className={`${s.field} ${d.editor}`} required maxLength={MAX_DIARY_CHARS} rows={10} />
          <div className={d.row}>
            <button className={`${s.button} ${s.primary} ${s.tapTarget}`} type="submit">
              Save
            </button>
            {scoring ? null : <span className={s.note}>Mood scoring is not set up here.</span>}
          </div>
        </form>
      </Region>

      <Region id="entries" title="Entries" testId="diary-entries">
        {problem ? (
          <Notice role="alert" tone="warn">
            {problem}
          </Notice>
        ) : rows && rows.length === 0 ? (
          <p className={`${s.note} ${s.pad}`}>No diary entries yet.</p>
        ) : rows ? (
          <ol className={s.list}>
            {rows.map((e) => (
              <li key={e.id} data-diary-id={e.id}>
                <p className={s.entryText}>{e.body}</p>
                <p className={s.entryMeta}>
                  <Link href={`/diary/${e.id}`} className={s.emph}>
                    <time className={s.mono} dateTime={e.writtenAt}>
                      {formatUtc(e.writtenAt)}
                    </time>
                  </Link>
                  <span className={s.muted} data-field="mood">
                    {moodSummaryLine(e.mood)}
                  </span>
                </p>
              </li>
            ))}
          </ol>
        ) : null}
        {rows && rows.length >= LIST_LIMIT ? <p className={`${s.note} ${s.pad}`}>Showing the newest {LIST_LIMIT} entries.</p> : null}
      </Region>
    </OwnerFrame>
  );
}
