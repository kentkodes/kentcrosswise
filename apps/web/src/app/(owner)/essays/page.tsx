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
import { noticeText } from "../notices";
import { EssayCardView } from "./essay-card";
import styles from "./essays.module.css";

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
    <main className={styles.page}>
      <h1>Essays</h1>
      <p>
        <Link href="/essays/setup">Setup</Link> · <Link href="/hub">Hub</Link>
      </p>
      {notice ? <p role="status">{notice}</p> : null}
      {problem ? <p role="alert">{problem}</p> : null}
      {data ? (
        <>
          <p className={styles.meta}>{describeSetup(data.prefs)}</p>

          <section aria-labelledby="recommended">
            <h2 id="recommended">Recommended</h2>
            {data.likedCount === 0 ? (
              <p className={styles.meta}>
                No essay is rated 4 stars or more yet, so these are the newest unrated essays. Rate essays to tune this list.
              </p>
            ) : null}
            {data.recommended.length === 0 ? <p>No unrated essays match your setup.</p> : null}
            <div data-testid="recommended">
              {data.recommended.map((card) => (
                <EssayCardView key={card.id} card={card} />
              ))}
            </div>
          </section>

          <section aria-labelledby="library">
            <h2 id="library">Library</h2>
            {data.feed.length === 0 ? <p>No essays match your setup yet.</p> : null}
            <div data-testid="feed">
              {data.feed.map((card) => (
                <EssayCardView key={card.id} card={card} />
              ))}
            </div>
            {data.hasMore && show < MAX_FEED_SHOW ? (
              <p>
                <Link href={`/essays?show=${Math.min(show + FEED_PAGE_SIZE, MAX_FEED_SHOW)}`}>Load more</Link>
              </p>
            ) : null}
          </section>
        </>
      ) : null}
    </main>
  );
}
