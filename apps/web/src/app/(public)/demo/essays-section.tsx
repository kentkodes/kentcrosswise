"use client";
// The /demo Essays tab: a feed of public-domain essay cards, a recommended card and a reader panel with the
// rating form. Link-only: facts, hook, source link and rating, never essay text. Ratings are local state and
// reset on reload.
import { useState } from "react";
import type { DemoView, EssayCard } from "./demo-view";
import d from "./demo.module.css";

const WORKED = ["Ideas", "Prose", "Argument", "Humor", "Emotion", "Surprise"] as const;
const FELT = ["Too long", "Right", "Too short"] as const;
type Rating = { stars: number; worked: string[]; felt: string; saved: boolean };
const BLANK: Rating = { stars: 0, worked: [], felt: "", saved: false };

const factsOf = (e: EssayCard) => [e.type, e.length, e.minutes, e.year].filter((x): x is string => Boolean(x)).join(" · ");

export function EssaysSection({ view, titleId }: { view: DemoView; titleId: string }) {
  const { feed, recommended } = view.essays;
  const [openId, setOpenId] = useState<string | null>(null);
  const [ratings, setRatings] = useState<Record<string, Rating>>({});
  const open = feed.find((e) => e.id === openId);
  const rec = recommended ? feed.find((e) => e.id === recommended.id) : undefined;
  const toggle = (id: string) => setOpenId((cur) => (cur === id ? null : id));
  const rating = (id: string): Rating => ratings[id] ?? BLANK;
  const update = (id: string, patch: Partial<Rating>) =>
    setRatings((r) => ({ ...r, [id]: { ...(r[id] ?? BLANK), ...patch, saved: false } }));
  return (
    <>
      <div className={d.headRow}>
        <h2 id={titleId} className={d.h2}>
          Essays
        </h2>
        <span className={d.muted}>Simulated ratings · public-domain essays, source links only</span>
      </div>
      {rec && recommended ? (
        <div className={d.recCard}>
          <span className={d.cardLabel}>Recommended</span>
          <button type="button" className={d.essayTitle} aria-pressed={openId === rec.id} onClick={() => toggle(rec.id)}>
            {rec.title}
          </button>
          <span className={d.muted}>{recommended.reason}</span>
        </div>
      ) : null}
      <ul className={d.essayList} aria-label="Essay feed">
        {feed.map((e) => (
          <li key={e.id} className={d.essayCard}>
            <button type="button" className={d.essayTitle} aria-pressed={openId === e.id} onClick={() => toggle(e.id)}>
              {e.title}
            </button>
            <span className={d.muted}>
              {e.author}
              {e.year ? `, ${e.year}` : ""}
            </span>
            <span className={d.mono}>
              {e.type} · {e.length} · {e.minutes}
            </span>
            <span className={d.hook}>{e.hook}</span>
            {e.stars !== null ? <span className={d.muted}>Simulated rating: {e.stars} of 5</span> : null}
          </li>
        ))}
      </ul>
      {open ? (
        <article className={d.reader} aria-labelledby={`${titleId}-reader`}>
          <p className={d.kicker}>{factsOf(open)}</p>
          <h3 id={`${titleId}-reader`} className={d.readerTitle}>
            {open.title}
          </h3>
          <p className={d.muted}>{open.author}</p>
          <p className={d.readerHook}>{open.hook}</p>
          <p>
            <a className={d.source} href={open.sourceUrl} target="_blank" rel="noopener noreferrer">
              Read it at Project Gutenberg
            </a>
          </p>
          <form
            className={d.rate}
            onSubmit={(ev) => {
              ev.preventDefault();
              setRatings((r) => ({ ...r, [open.id]: { ...rating(open.id), saved: true } }));
            }}
          >
            <fieldset className={d.fieldset}>
              <legend className={d.legend}>Overall</legend>
              <div className={d.pills}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <label key={n} className={d.ratePill}>
                    <input
                      type="radio"
                      name={`stars-${open.id}`}
                      checked={rating(open.id).stars === n}
                      onChange={() => update(open.id, { stars: n })}
                    />
                    <span>{n}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className={d.fieldset}>
              <legend className={d.legend}>What worked</legend>
              <div className={d.pills}>
                {WORKED.map((w) => (
                  <label key={w} className={d.ratePill}>
                    <input
                      type="checkbox"
                      checked={rating(open.id).worked.includes(w)}
                      onChange={(ev) =>
                        update(open.id, {
                          worked: ev.target.checked ? [...rating(open.id).worked, w] : rating(open.id).worked.filter((x) => x !== w),
                        })
                      }
                    />
                    <span>{w}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className={d.fieldset}>
              <legend className={d.legend}>Length felt</legend>
              <div className={d.pills}>
                {FELT.map((f) => (
                  <label key={f} className={d.ratePill}>
                    <input
                      type="radio"
                      name={`felt-${open.id}`}
                      checked={rating(open.id).felt === f}
                      onChange={() => update(open.id, { felt: f })}
                    />
                    <span>{f}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className={d.rateRow}>
              <button type="submit" className={d.save} disabled={rating(open.id).stars === 0}>
                Save rating
              </button>
              <span className={d.muted} role="status">
                {rating(open.id).saved ? "Saved on this page (simulated; resets on reload)." : "Simulated: nothing is stored."}
              </span>
            </div>
          </form>
        </article>
      ) : null}
    </>
  );
}
