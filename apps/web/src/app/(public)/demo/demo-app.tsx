"use client";
// The /demo app frame: a tab sidebar and one section. Only the selected tab is client state; the data
// arrives as a serializable view model from the server page.
import { useId, useState } from "react";
import { sparkline, SPARK_H, SPARK_W } from "../_site/sparkline";
import type { DemoView } from "./demo-view";
import d from "./demo.module.css";

const TABS = ["Today", "People", "Mood", "Following", "Notes"] as const;
type Tab = (typeof TABS)[number];

export function DemoApp({ view }: { view: DemoView }) {
  const [tab, setTab] = useState<Tab>("Today");
  // The section is named by its h2, which carries this id.
  const titleId = useId();
  return (
    <div className={d.frame}>
      <nav className={d.tabs} aria-label="Hub sections">
        {TABS.map((t) => (
          <button key={t} type="button" className={d.tab} aria-pressed={t === tab} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      <section className={d.body} aria-labelledby={titleId}>
        {tab === "Today" && <TodaySection view={view} titleId={titleId} />}
        {tab === "People" && <PeopleSection view={view} titleId={titleId} />}
        {tab === "Mood" && <MoodSection view={view} titleId={titleId} />}
        {tab === "Following" && <FollowingSection view={view} titleId={titleId} />}
        {tab === "Notes" && <NotesSection view={view} titleId={titleId} />}
      </section>
    </div>
  );
}

type SectionProps = { view: DemoView; titleId: string };

function TodaySection({ view, titleId }: SectionProps) {
  const { today } = view;
  const spark = sparkline(today.moodSeries);
  const latest = today.moodSeries.at(-1);
  return (
    <>
      <div className={d.headRow}>
        <h2 id={titleId} className={d.h2}>
          Today
        </h2>
        <span className={d.muted}>{view.todayLabel}</span>
      </div>
      <div className={d.cards}>
        <div className={d.card}>
          <span className={d.cardLabel}>Mood, 7 days</span>
          {spark ? (
            <>
              <svg className={d.spark} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} aria-hidden="true">
                <polyline
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  points={spark.points}
                />
                <circle cx={spark.end.x} cy={spark.end.y} r="2.5" fill="currentColor" />
              </svg>
              <span className={d.srOnly}>
                Sentiment over the last 7 days{latest === undefined ? "" : `, latest ${latest.toFixed(2)}`}
              </span>
            </>
          ) : null}
        </div>
        {today.followUp ? (
          <div className={d.card}>
            <span className={d.cardLabel}>Follow up</span>
            <p className={d.cardValue}>{today.followUp.name}</p>
            <span className={d.muted}>
              {today.followUp.howKnown}
              {today.followUp.sinceLastNote ? ` · ${today.followUp.sinceLastNote}` : ""}
            </span>
          </div>
        ) : null}
        {today.followers ? (
          <div className={d.card}>
            <span className={d.cardLabel}>Followers</span>
            <p className={d.cardValue}>{today.followers.count}</p>
            <span className={d.muted}>
              {today.followers.platform} · {today.followers.change}
            </span>
          </div>
        ) : null}
      </div>
      <h3 className={d.h3}>Latest captures, and where they went</h3>
      <ul className={d.list}>
        {today.captures.map((c, i) => (
          <li key={i} className={d.captureRow}>
            <span className={d.captureText}>{c.text}</span>
            <span className={d.captureMeta}>
              <span className={d.mono}>{c.day}</span>
              <span className={d.route}>{c.route}</span>
              {c.detail}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function PeopleSection({ view, titleId }: SectionProps) {
  return (
    <>
      <h2 id={titleId} className={d.h2}>
        People
      </h2>
      <div className={d.tableBox}>
        <table className={d.table}>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">How you know them</th>
              <th scope="col">Last note</th>
              <th scope="col">Birthday</th>
            </tr>
          </thead>
          <tbody>
            {view.people.map((p) => (
              <tr key={p.name}>
                <td className={d.strong}>{p.name}</td>
                <td className={d.muted}>{p.howKnown}</td>
                <td>{p.lastNote}</td>
                <td className={d.mono}>{p.birthday}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function MoodSection({ view, titleId }: SectionProps) {
  return (
    <>
      <h2 id={titleId} className={d.h2}>
        Mood
      </h2>
      <p className={d.caption}>Scored from the latest diary entry, 0 to 1.</p>
      <div className={d.bars}>
        {view.mood.map((m) => (
          <div key={m.name} className={d.barRow}>
            <span>{m.name}</span>
            <span className={d.track}>
              <span className={d.fill} style={{ width: `${Math.round(m.value * 100)}%` }} />
            </span>
            <span className={d.barValue}>{m.text}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function FollowingSection({ view, titleId }: SectionProps) {
  return (
    <>
      <h2 id={titleId} className={d.h2}>
        Following
      </h2>
      <div className={d.cards}>
        {view.following.map((f) => (
          <div key={f.handle} className={d.card}>
            <span className={d.cardLabel}>{f.platform}</span>
            <p className={d.bigValue}>{f.followers}</p>
            <span className={d.muted}>
              {f.change} · {f.handle}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function NotesSection({ view, titleId }: SectionProps) {
  return (
    <>
      <h2 id={titleId} className={d.h2}>
        Notes
      </h2>
      <div className={d.notesGrid}>
        <div>
          <h3 className={d.h3}>To do</h3>
          <ul className={d.plainList}>
            {view.notes.todos.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className={d.h3}>Ideas</h3>
          <ul className={d.plainList}>
            {view.notes.ideas.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}
