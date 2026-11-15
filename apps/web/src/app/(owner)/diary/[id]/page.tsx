import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DbNotConfiguredError, dbErrorLabel, withDb } from "@/server/db";
import { getDiary, isDiaryId, MAX_DIARY_CHARS, MOOD_KEYS, type DiaryRow } from "@/server/diary";
import { requireOwner } from "@/server/owner";
import { routingEnabled } from "@/server/router";
import { formatUtc } from "../../format";
import { OwnerFrame } from "../../owner-frame";
import { Notice, Region } from "../../owner-ui";
import s from "../../owner.module.css";
import { deleteDiaryAction, editDiaryAction, scoreAgainAction } from "../actions";
import d from "../diary.module.css";
import { diaryNoticeText, isDiarySuccess } from "../notices";

export const metadata: Metadata = { title: "Diary entry | Kentcrosswise" };

async function load(id: string): Promise<{ row?: DiaryRow; problem?: string }> {
  try {
    return { row: await withDb("web_rw", (db) => getDiary(db, id), { readOnly: true }) };
  } catch (err) {
    if (err instanceof DbNotConfiguredError) return { problem: "The database is not connected yet." };
    console.error(`[diary] ${dbErrorLabel(err)}`);
    return { problem: "The database is unavailable right now." };
  }
}

const label = (k: string) => k.charAt(0).toUpperCase() + k.slice(1);

export default async function DiaryEntryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOwner();
  const { id } = await params;
  if (!isDiaryId(id)) notFound();
  const query = await searchParams;
  const notice = diaryNoticeText(query.n);
  const ok = isDiarySuccess(query.n);
  const confirming = query.delete === "1";
  const scoring = routingEnabled(process.env);
  const { row, problem } = await load(id);
  if (!row && !problem) notFound();

  return (
    <OwnerFrame
      title="Diary entry"
      current="/hub"
      actions={
        <Link className={s.button} href="/diary">
          All entries
        </Link>
      }
    >
      {notice ? (
        <Notice role={ok ? "status" : "alert"} tone={ok ? "ok" : "warn"}>
          {notice}
        </Notice>
      ) : null}
      {problem ? (
        <Notice role="alert" tone="warn">
          {problem}
        </Notice>
      ) : null}

      {row ? (
        <>
          <Region id="entry" title="Entry" testId="diary-entry" aside={<time className={s.mono} dateTime={row.writtenAt}>{formatUtc(row.writtenAt)}</time>}>
            <div className={s.pad}>
              <p className={d.reading} data-testid="diary-text">
                {row.body}
              </p>
            </div>
          </Region>

          <Region id="edit" title="Edit">
            <form action={editDiaryAction} className={`${s.pad} ${s.stack}`}>
              <input type="hidden" name="id" value={row.id} />
              <label className={s.fieldLabel} htmlFor="diary_edit_body">
                Text
              </label>
              <textarea
                id="diary_edit_body"
                name="body"
                className={`${s.field} ${d.editor}`}
                required
                maxLength={MAX_DIARY_CHARS}
                rows={10}
                defaultValue={row.body}
              />
              <div className={d.row}>
                <button className={`${s.button} ${s.primary} ${s.tapTarget}`} type="submit">
                  Save changes
                </button>
              </div>
            </form>
          </Region>

          <Region id="mood" title="Mood" testId="diary-mood">
            {row.mood ? (
              <dl className={d.scores}>
                <div>
                  <dt>Sentiment</dt>
                  <dd data-score="sentiment">{row.mood.sentiment.toFixed(2)}</dd>
                </div>
                {MOOD_KEYS.map((k) => (
                  <div key={k}>
                    <dt>{label(k)}</dt>
                    <dd data-score={k}>{row.mood![k].toFixed(2)}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className={`${s.note} ${s.pad}`}>Not scored</p>
            )}
            <div className={`${d.row} ${s.pad}`}>
              {scoring ? (
                <form action={scoreAgainAction}>
                  <input type="hidden" name="id" value={row.id} />
                  <button className={`${s.button} ${s.tapTarget}`} type="submit">
                    Score again
                  </button>
                </form>
              ) : (
                <span className={s.note}>Mood scoring is not set up here.</span>
              )}
              {row.mood ? <span className={s.mono}>{row.mood.model}</span> : null}
            </div>
          </Region>

          <Region id="delete" title="Delete">
            {confirming ? (
              <form action={deleteDiaryAction} className={d.confirm}>
                <input type="hidden" name="id" value={row.id} />
                <p role="alert" className={s.emph}>
                  Delete this entry and its mood scores? This cannot be undone.
                </p>
                <div className={d.row}>
                  <button className={`${s.button} ${s.primary} ${s.tapTarget}`} type="submit">
                    Yes, delete
                  </button>
                  <Link className={`${s.button} ${s.tapTarget}`} href={`/diary/${row.id}`}>
                    Cancel
                  </Link>
                </div>
              </form>
            ) : (
              <div className={s.pad}>
                <Link className={`${s.button} ${s.tapTarget}`} href={`/diary/${row.id}?delete=1`}>
                  Delete
                </Link>
              </div>
            )}
          </Region>
        </>
      ) : null}
    </OwnerFrame>
  );
}
