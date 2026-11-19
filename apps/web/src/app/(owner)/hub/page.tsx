import type { Metadata } from "next";
import { listRecentEntries, listUnresolvedEntries, MAX_CAPTURE_CHARS, type EntryRow } from "@/server/capture";
import { DbNotConfiguredError, dbErrorLabel, withDb } from "@/server/db";
import { requireOwner } from "@/server/owner";
import { listWithheldRetry, type WithheldItem } from "@/server/publish";
import { contactOptions, listAwaitingReview, type ReviewItem } from "@/server/review";
import { routingEnabled } from "@/server/router";
import { isSuccessNotice, noticeText } from "../notices";
import { OwnerFrame } from "../owner-frame";
import { Notice, Region } from "../owner-ui";
import s from "../owner.module.css";
import { captureAction } from "./actions";
import { CaptureField } from "./capture-field";
import { EntryItem } from "./entry-row";
import { ReviewEntry, WithheldEntry } from "./review-item";

export const metadata: Metadata = { title: "Hub | Kentcrosswise" };

async function loadRecent(): Promise<{
  rows?: EntryRow[];
  unresolved?: EntryRow[];
  review?: ReviewItem[];
  withheld?: WithheldItem[];
  contacts?: { id: string; name: string }[];
  problem?: string;
}> {
  try {
    return await withDb(
      "web_rw",
      async (db) => ({
        rows: await listRecentEntries(db),
        unresolved: await listUnresolvedEntries(db),
        review: await listAwaitingReview(db),
        withheld: await listWithheldRetry(db),
        contacts: await contactOptions(db),
      }),
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
  const { rows, unresolved, review, withheld, contacts, problem } = await loadRecent();

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

      <Region id="review" title={review && review.length > 0 ? `Awaiting review (${review.length})` : "Awaiting review"} testId="review">
        {problem ? null : review && review.length > 0 ? (
          <ol className={s.list} data-testid="review-entries">
            {review.map((e) => (
              <ReviewEntry key={e.id} e={e} routing={routing} contacts={contacts} />
            ))}
          </ol>
        ) : (
          <p className={`${s.note} ${s.pad}`}>Nothing to review. A routed entry waits here until you mark it correct or change its route.</p>
        )}
      </Region>

      {!problem && withheld && withheld.length > 0 ? (
        <Region id="withheld" title={`Withheld after review (${withheld.length})`} testId="withheld">
          <ol className={s.list} data-testid="withheld-entries">
            {withheld.map((e) => (
              <WithheldEntry key={e.id} e={e} routing={routing} />
            ))}
          </ol>
        </Region>
      ) : null}

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
    </OwnerFrame>
  );
}
