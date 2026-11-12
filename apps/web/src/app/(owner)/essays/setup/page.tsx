// Essay setup (essays SPEC "Setup"): the types and lengths the feed and recommendations use.
// Owner only (the (owner) layout); the save action checks again.
import type { Metadata } from "next";
import Link from "next/link";
import { DbNotConfiguredError, dbErrorLabel, withDb } from "@/server/db";
import { requireOwner } from "@/server/owner";
import { ESSAY_LENGTHS, ESSAY_TYPES, LENGTH_LABELS, TYPE_LABELS, readPrefs, type Prefs } from "@/server/essay-library";
import { OwnerFrame } from "../../owner-frame";
import { Notice } from "../../owner-ui";
import s from "../../owner.module.css";
import { noticeText } from "../../notices";
import { savePrefsAction } from "../actions";

export const metadata: Metadata = { title: "Essay setup | Kentcrosswise" };

async function load(): Promise<{ prefs?: Prefs; problem?: string }> {
  try {
    return { prefs: await withDb("web_rw", (db) => readPrefs(db), { readOnly: true }) };
  } catch (err) {
    if (err instanceof DbNotConfiguredError) return { problem: "The database is not connected yet." };
    console.error(`[essays-setup] ${dbErrorLabel(err)}`);
    return { problem: "The database is unavailable right now." };
  }
}

export default async function EssaySetupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner();
  const notice = noticeText((await searchParams).n);
  const { prefs, problem } = await load();

  return (
    <OwnerFrame title="Essay setup" current="/essays">
      <p className={s.note}>
        <Link className={s.muted} href="/essays">
          <span aria-hidden="true">← </span>Essays
        </Link>
      </p>
      {notice ? <Notice role="status" tone="ok">{notice}</Notice> : null}
      {problem ? <Notice role="alert" tone="warn">{problem}</Notice> : null}
      {prefs ? (
        <form action={savePrefsAction} className={s.stack}>
          <fieldset className={`${s.region} ${s.fieldset}`}>
            <legend className={s.legend}>Types</legend>
            <div className={`${s.pad} ${s.choices}`}>
              {ESSAY_TYPES.map((t) => (
                <label key={t} className={s.pill}>
                  <input className={s.hidden} type="checkbox" name="type" value={t} defaultChecked={prefs.types.includes(t)} />
                  {TYPE_LABELS[t]}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className={`${s.region} ${s.fieldset}`}>
            <legend className={s.legend}>Lengths</legend>
            <div className={`${s.pad} ${s.choices}`}>
              {ESSAY_LENGTHS.map((l) => (
                <label key={l} className={s.pill}>
                  <input className={s.hidden} type="checkbox" name="length" value={l} defaultChecked={prefs.lengths.includes(l)} />
                  {LENGTH_LABELS[l]}
                </label>
              ))}
            </div>
          </fieldset>
          <p className={s.note}>Leave a group empty to see every length or type.</p>
          <div>
            <button className={`${s.button} ${s.primary}`} type="submit">
              Save setup
            </button>
          </div>
        </form>
      ) : null}
    </OwnerFrame>
  );
}
