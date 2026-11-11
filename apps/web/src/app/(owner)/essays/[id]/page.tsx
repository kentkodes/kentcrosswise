// Essay reader (essays SPEC "Reader" and "Rating"). Owner only (the (owner) layout).
// Link-only essays open their source instead of a reader. Full text comes from loadEssayText (S3);
// when it is null (no bucket, missing object, read error) the reader says "Text unavailable".
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { PaperFrame } from "@/app/(public)/_site/paper-frame";
import { isUuid } from "@/server/console";
import { DbNotConfiguredError, dbErrorLabel, withDb } from "@/server/db";
import { requireOwner } from "@/server/owner";
import {
  LENGTH_NAMES,
  TYPE_LABELS,
  externalHref,
  getReaderEssay,
  linkSearchHref,
  readingMinutesOf,
  type ReaderEssay,
} from "@/server/essay-library";
import { loadEssayText, textParagraphs } from "@/server/essay-text";
import { noticeText } from "../../notices";
import styles from "./reader.module.css";
import { newsreader } from "./reading-font";
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
      <PaperFrame>
        <div className={styles.column}>
          <p role="alert" className={styles.status}>
            {problem}
          </p>
          <p className={styles.back}>
            <Link href="/essays">Back to essays</Link>
          </p>
        </div>
      </PaperFrame>
    );
  }
  if (!essay) notFound();

  if (essay.kind === "link") redirect(externalHref(essay.sourceUrl) ?? linkSearchHref(essay.title, essay.author));

  const text = await loadEssayText(essay.textS3Key);
  const paragraphs = text === null ? [] : textParagraphs(text);
  const minutes = readingMinutesOf(essay);
  const kicker = [
    essay.primaryType ? TYPE_LABELS[essay.primaryType] : null,
    essay.lengthBand ? LENGTH_NAMES[essay.lengthBand] : null,
    minutes !== null ? `${minutes} min read` : null,
  ].filter((part): part is string => part !== null);

  return (
    <PaperFrame headerBelow={<ReadingProgress />}>
      <div className={styles.column}>
        <p className={styles.back}>
          <Link href="/essays">
            <span aria-hidden="true">← </span>Essays
          </Link>
        </p>
        <header className={styles.head}>
          {kicker.length > 0 ? <p className={styles.kicker}>{kicker.join(" · ")}</p> : null}
          <h1 className={styles.title}>{essay.title}</h1>
          <p className={styles.byline}>
            {essay.author}
            {essay.year !== null ? <> · {essay.year}</> : null}
          </p>
        </header>
        {notice ? <p role="status" className={styles.status}>{notice}</p> : null}
        {paragraphs.length === 0 ? (
          <p role="status" className={styles.status}>
            Text unavailable
          </p>
        ) : (
          <article className={`${styles.body} ${newsreader.variable}`}>
            {paragraphs.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </article>
        )}
        <RatingForm essayId={essay.id} rating={essay.rating} />
      </div>
    </PaperFrame>
  );
}
