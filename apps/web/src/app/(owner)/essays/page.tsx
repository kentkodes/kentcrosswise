// Essays feed (essays SPEC "Feed" and "Recommendations"). Owner only (the (owner) layout).
// Setup filters apply to both the recommendations and the library; empty setup means no filter.
// The library's search, kind and page size are all in the URL (?q, ?kind, ?show).
import type { Metadata } from "next";
import Link from "next/link";
import { Fragment } from "react";
import { DbNotConfiguredError, dbErrorLabel, withDb } from "@/server/db";
import { requireOwner } from "@/server/owner";
import type { Ranked } from "@/server/essay-recommend";
import {
  FEED_PAGE_SIZE,
  LENGTH_NAMES,
  MAX_FEED_SHOW,
  RECOMMENDATION_COUNT,
  TYPE_LABELS,
  countFeed,
  feedHref,
  listFeed,
  listRecommendations,
  parseKind,
  parseSearch,
  parseShow,
  readPrefs,
  surnameInitial,
  type EssayCard,
  type FeedFilter,
  type FeedKind,
  type Prefs,
} from "@/server/essay-library";
import { OwnerFrame } from "../owner-frame";
import { Notice, Region } from "../owner-ui";
import s from "../owner.module.css";
import { noticeText } from "../notices";
import { EssayCardView, LinkRowView } from "./essay-card";
import styles from "./essays.module.css";

export const metadata: Metadata = { title: "Essays | Kentcrosswise" };

const KINDS: FeedKind[] = ["all", "full", "link"];
const KIND_LABELS: Record<FeedKind, string> = { all: "All", full: "Full text", link: "Links" };

type Loaded = {
  prefs: Prefs;
  recommended: Ranked<EssayCard>[];
  likedCount: number;
  feed: EssayCard[];
  hasMore: boolean;
  total: number;
};

async function load(show: number, filter: FeedFilter): Promise<{ data?: Loaded; problem?: string }> {
  try {
    const data = await withDb(
      "web_rw",
      async (db) => {
        const prefs = await readPrefs(db);
        const rec = await listRecommendations(db, prefs, RECOMMENDATION_COUNT);
        const feed = await listFeed(db, prefs, show, filter);
        const total = await countFeed(db, prefs, filter);
        return { prefs, recommended: rec.cards, likedCount: rec.likedCount, feed: feed.cards, hasMore: feed.hasMore, total };
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
  const filter: FeedFilter = { q: parseSearch(params.q), kind: parseKind(params.kind) };
  const notice = noticeText(params.n);
  const { data, problem } = await load(show, filter);

  // The feed is full-text essays first, then links, so the two groups are contiguous.
  const fullCards = data?.feed.filter((c) => c.kind === "full") ?? [];
  const linkCards = data?.feed.filter((c) => c.kind === "link") ?? [];

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
                No essay is rated 4 stars or more yet, so these are the newest unrated essays, full texts first. Rate essays to tune this list.
              </p>
            ) : null}
            {data.recommended.length === 0 ? <p className={`${s.note} ${s.pad}`}>No unrated essays match your setup.</p> : null}
            <div data-testid="recommended">
              {data.recommended.map((card) => (
                <EssayCardView key={card.id} card={card} because={card.because} />
              ))}
            </div>
          </Region>

          <Region
            id="library"
            title="Library"
            aside={
              <span className={s.count}>{filter.q ? `${data.total} ${data.total === 1 ? "match" : "matches"}` : `${data.feed.length} of ${data.total}`}</span>
            }
          >
            <div className={styles.toolbar}>
              <form action="/essays" className={styles.find} role="search">
                <label htmlFor="essays-q" className={styles.srOnly}>
                  Search title or author
                </label>
                <input
                  id="essays-q"
                  className={`${s.field} ${styles.searchInput}`}
                  type="search"
                  name="q"
                  defaultValue={filter.q}
                  placeholder="Search title or author"
                  maxLength={100}
                />
                <input type="hidden" name="kind" value={filter.kind} />
                <button type="submit" className={`${s.button} ${styles.searchButton}`}>
                  Search
                </button>
              </form>
              <nav aria-label="Filter library" className={s.navScroll}>
                <ul className={s.track}>
                  {KINDS.map((k) => (
                    <li key={k}>
                      <Link
                        className={`${s.navLink} ${styles.kindLink}`}
                        href={feedHref({ q: filter.q, kind: k })}
                        aria-current={k === filter.kind ? "true" : undefined}
                      >
                        {KIND_LABELS[k]}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            </div>

            {data.feed.length === 0 ? (
              filter.q ? (
                <p className={`${s.note} ${s.pad}`}>
                  No essays match “{filter.q}”. <Link href={feedHref({ kind: filter.kind })}>Clear search</Link>
                </p>
              ) : (
                <p className={`${s.note} ${s.pad}`}>No essays match your setup yet.</p>
              )
            ) : null}
            <div data-testid="feed">
              {fullCards.map((card) => (
                <EssayCardView key={card.id} card={card} />
              ))}
              {linkCards.length > 0 ? <p className={styles.strip}>Links · A–Z by author</p> : null}
              {linkCards.map((card, i) => {
                const initial = surnameInitial(card.author);
                const newLetter = i === 0 || surnameInitial(linkCards[i - 1]!.author) !== initial;
                return (
                  <Fragment key={card.id}>
                    {newLetter ? (
                      <div className={styles.letter} aria-hidden="true">
                        {initial}
                      </div>
                    ) : null}
                    <LinkRowView card={card} />
                  </Fragment>
                );
              })}
            </div>
            {data.hasMore && show < MAX_FEED_SHOW ? (
              <div className={`${s.pad} ${s.endRow}`}>
                <Link
                  className={s.button}
                  href={feedHref({ q: filter.q, kind: filter.kind, show: Math.min(show + FEED_PAGE_SIZE, MAX_FEED_SHOW) })}
                >
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
