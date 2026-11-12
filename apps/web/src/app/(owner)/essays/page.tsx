// Essays feed (essays SPEC "Feed" and "Recommendations"). Owner only (the (owner) layout).
// Setup filters apply to both the recommendations and the library; empty setup means no filter.
import type { Metadata } from "next";
import Link from "next/link";
import { DbNotConfiguredError, dbErrorLabel, withDb } from "@/server/db";
import { requireOwner } from "@/server/owner";
import {
  FEED_PAGE_SIZE,
  LENGTH_NAMES,
  MAX_FEED_SHOW,
  RECOMMENDATION_COUNT,
  TYPE_LABELS,
  listFeed,
  listRecommendations,
  parseShow,
  readPrefs,
  type EssayCard,
  type Prefs,
} from "@/server/essay-library";
import { OwnerFrame } from "../owner-frame";
import { Notice, Region } from "../owner-ui";
import s from "../owner.module.css";
import { noticeText } from "../notices";
import { EssayCardView } from "./essay-card";

export const metadata: Metadata = { title: "Essays | Kentcrosswise" };

type Loaded = {
  prefs: Prefs;
  recommended: EssayCard[];
  likedCount: number;
  feed: EssayCard[];
  hasMore: boolean;
};

async function load(show: number): Promise<{ data?: Loaded; problem?: string }> {
  try {
    const data = await withDb(
      "web_rw",
      async (db) => {
        const prefs = await readPrefs(db);
        const rec = await listRecommendations(db, prefs, RECOMMENDATION_COUNT);
        const feed = await listFeed(db, prefs, show);
        return { prefs, recommended: rec.cards, likedCount: rec.likedCount, feed: feed.cards, hasMore: feed.hasMore };
      },
      { readOnly: true },
    );
    return { data };
  } catch (err) {
    if (err instanceof DbNotConfiguredError) return { problem: "The database is not connected yet." };
    console.error(`[essays] ${dbErrorLabel(err)}`);
    return { problem: "The database is unavailable right now." };
  }
}

function describeSetup(prefs: Prefs): string {
  const types = prefs.types.length > 0 ? prefs.types.map((t) => TYPE_LABELS[t]).join(", ") : "all types";
  const lengths = prefs.lengths.length > 0 ? prefs.lengths.map((l) => LENGTH_NAMES[l]).join(", ") : "all lengths";
  return `Showing ${types}, ${lengths}.`;
}

export default async function EssaysPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner();
  const params = await searchParams;
  const show = parseShow(params.show);
  const notice = noticeText(params.n);
  const { data, problem } = await load(show);

  return (
    <OwnerFrame
      title="Essays"
      current="/essays"
      actions={
        <Link className={s.button} href="/essays/setup">
          Setup
        </Link>
      }
    >
      {notice ? <Notice role="status" tone="ok">{notice}</Notice> : null}
      {problem ? <Notice role="alert" tone="warn">{problem}</Notice> : null}
      {data ? (
        <>
          <p className={s.note}>{describeSetup(data.prefs)}</p>

          <Region id="recommended" title="Recommended">
            {data.likedCount === 0 ? (
              <p className={`${s.note} ${s.pad}`}>
                No essay is rated 4 stars or more yet, so these are the newest unrated essays. Rate essays to tune this list.
              </p>
            ) : null}
            {data.recommended.length === 0 ? <p className={`${s.note} ${s.pad}`}>No unrated essays match your setup.</p> : null}
            <div data-testid="recommended">
              {data.recommended.map((card) => (
                <EssayCardView key={card.id} card={card} />
              ))}
            </div>
          </Region>

          <Region id="library" title="Library">
            {data.feed.length === 0 ? <p className={`${s.note} ${s.pad}`}>No essays match your setup yet.</p> : null}
            <div data-testid="feed">
              {data.feed.map((card) => (
                <EssayCardView key={card.id} card={card} />
              ))}
            </div>
            {data.hasMore && show < MAX_FEED_SHOW ? (
              <div className={`${s.pad} ${s.endRow}`}>
                <Link className={s.button} href={`/essays?show=${Math.min(show + FEED_PAGE_SIZE, MAX_FEED_SHOW)}`}>
                  Load more
                </Link>
              </div>
            ) : null}
          </Region>
        </>
      ) : null}
    </OwnerFrame>
  );
}
