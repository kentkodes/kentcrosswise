import type { Metadata } from "next";
import Link from "next/link";
import { DbNotConfiguredError, dbErrorLabel, withDb } from "@/server/db";
import { listMoodPoints, type MoodPoint } from "@/server/diary";
import { requireOwner } from "@/server/owner";
import { OwnerFrame } from "../owner-frame";
import { Notice } from "../owner-ui";
import s from "../owner.module.css";
import { MoodChart } from "./mood-chart";
import m from "./mood.module.css";

export const metadata: Metadata = { title: "Mood | Kentcrosswise" };

const DEFAULT_DAYS = 90;

async function load(since: string | undefined): Promise<{ points?: MoodPoint[]; problem?: string }> {
  try {
    return { points: await withDb("web_rw", (db) => listMoodPoints(db, since), { readOnly: true }) };
  } catch (err) {
    if (err instanceof DbNotConfiguredError) return { problem: "The database is not connected yet." };
    console.error(`[mood] ${dbErrorLabel(err)}`);
    return { problem: "The database is unavailable right now." };
  }
}

export default async function MoodPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner();
  const all = (await searchParams).range === "all";
  const since = all ? undefined : new Date(Date.now() - DEFAULT_DAYS * 86_400_000).toISOString();
  const { points, problem } = await load(since);

  return (
    <OwnerFrame
      title="Mood"
      current="/hub"
      actions={
        <Link className={s.button} href="/diary">
          Diary
        </Link>
      }
    >
      <p className={`${s.note} ${m.range}`}>
        <span data-testid="range-note">{all ? "All scored entries." : `Scored entries from the last ${DEFAULT_DAYS} days.`}</span>
        {all ? <Link href="/mood">Show the last {DEFAULT_DAYS} days</Link> : <Link href="/mood?range=all">Show all</Link>}
      </p>
      {problem ? (
        <Notice role="alert" tone="warn">
          {problem}
        </Notice>
      ) : points ? (
        <MoodChart points={points} />
      ) : null}
    </OwnerFrame>
  );
}
