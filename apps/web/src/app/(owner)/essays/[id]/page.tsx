// Essay reader (essays SPEC "Reader" and "Rating"). Owner only (the (owner) layout).
// Link-only essays open their source instead of a reader. Full text comes from loadEssayText, which
// is a placeholder until the S3 slice lands.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isUuid } from "@/server/console";
import { DbNotConfiguredError, dbErrorLabel, withDb } from "@/server/db";
import { requireOwner } from "@/server/owner";
import {
  LENGTH_NAMES,
  TYPE_LABELS,
  externalHref,
  getReaderEssay,
  readingMinutesOf,
  type ReaderEssay,
} from "@/server/essay-library";
import { loadEssayText } from "@/server/essay-text";
import { noticeText } from "../../notices";
import styles from "../essays.module.css";
import { RatingForm } from "./rating-form";
import { ReadingProgress } from "./reading-progress";

export const metadata: Metadata = { title: "Essay | Kentcrosswise" };

async function load(id: string): Promise<{ essay?: ReaderEssay; problem?: string }> {
  try {
    return { essay: await withDb("web_rw", (db) => getReaderEssay(db, id), { readOnly: true }) };
  } catch (err) {
    if (err instanceof DbNotConfiguredError) return { problem: "The database is not connected yet." };
    console.error(`[essay-reader] ${dbErrorLabel(err)}`);
    return { problem: "The database is unavailable right now." };
  }
}

export default async function EssayReaderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOwner();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const notice = noticeText((await searchParams).n);
  const { essay, problem } = await load(id);
  if (problem) {
    return (
      <main className={styles.page}>
        <p role="alert">{problem}</p>
        <p>
          <Link href="/essays">Back to essays</Link>
        </p>
      </main>
    );
  }
  if (!essay) notFound();

  if (essay.kind === "link") {
    const href = externalHref(essay.sourceUrl);
    if (href) redirect(href);
    return (
      <main className={styles.page}>
        <h1>{essay.title}</h1>
        <p role="alert">This entry has no usable source link.</p>
        <p>
          <Link href="/essays">Back to essays</Link>
        </p>
      </main>
    );
  }

  const text = await loadEssayText(essay.textS3Key);
  const minutes = readingMinutesOf(essay);

  return (
    <main className={styles.page}>
      <p>
        <Link href="/essays">Back to essays</Link>
      </p>
      <header>
        <h1>{essay.title}</h1>
        <p className={styles.meta}>
          {essay.author}
          {essay.year !== null ? <> · {essay.year}</> : null}
        </p>
        <p className={styles.meta}>
          {essay.primaryType ? TYPE_LABELS[essay.primaryType] : "Untyped"}
          {essay.lengthBand ? <> · {LENGTH_NAMES[essay.lengthBand]}</> : null}
          {minutes !== null ? <> · {minutes} min read</> : null}
        </p>
      </header>
      <ReadingProgress />
      {notice ? <p role="status">{notice}</p> : null}
      {text === null ? (
        <p role="status">Text storage connection pending</p>
      ) : (
        <article className={styles.body}>
          {text
            .split(/\n\s*\n/)
            .map((p) => p.trim())
            .filter((p) => p.length > 0)
            .map((p, i) => (
              <p key={i}>{p}</p>
            ))}
        </article>
      )}
      <RatingForm essayId={essay.id} rating={essay.rating} />
    </main>
  );
}
