// Essay setup (essays SPEC "Setup"): the types and lengths the feed and recommendations use.
// Owner only (the (owner) layout); the save action checks again.
import type { Metadata } from "next";
import Link from "next/link";
import { DbNotConfiguredError, dbErrorLabel, withDb } from "@/server/db";
import { requireOwner } from "@/server/owner";
import {
  ESSAY_LENGTHS,
  ESSAY_TYPES,
  LENGTH_LABELS,
  TYPE_LABELS,
  readPrefs,
  type Prefs,
} from "@/server/essay-library";
import { noticeText } from "../../notices";
import { savePrefsAction } from "../actions";
import styles from "../essays.module.css";

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
    <main className={styles.page}>
      <h1>Essay setup</h1>
      <p>
        <Link href="/essays">Back to essays</Link>
      </p>
      {notice ? <p role="status">{notice}</p> : null}
      {problem ? <p role="alert">{problem}</p> : null}
      {prefs ? (
        <form action={savePrefsAction}>
          <fieldset>
            <legend>Types</legend>
            {ESSAY_TYPES.map((t) => (
              <label key={t} className={styles.option}>
                <input type="checkbox" name="type" value={t} defaultChecked={prefs.types.includes(t)} /> {TYPE_LABELS[t]}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>Lengths</legend>
            {ESSAY_LENGTHS.map((l) => (
              <label key={l} className={styles.option}>
                <input type="checkbox" name="length" value={l} defaultChecked={prefs.lengths.includes(l)} /> {LENGTH_LABELS[l]}
              </label>
            ))}
          </fieldset>
          <p className={styles.meta}>Leave a group empty to see every length or type.</p>
          <button type="submit">Save setup</button>
        </form>
      ) : null}
    </main>
  );
}
