"use client";
import { useActivity } from "../_site/use-activity";
import { timestamp } from "../_site/activity";
import s from "./home.module.css";

// The last three public events, as log rows. The only live part of the home page's product still.
export function RecentActivity() {
  const { events, status } = useActivity();
  return (
    <section className={s.log} aria-label="Recent activity">
      {status === "error" ? <p className={s.logNote}>Feed unavailable.{events.length ? " Cached activity shown." : " Retrying shortly."}</p> : null}
      {!events.length && status !== "error" ? <p className={s.logNote}>{status === "loading" ? "Loading agent activity…" : "No public agent activity yet."}</p> : null}
      <ul className={s.logList}>
        {events.slice(-3).reverse().map((event) => <li key={event.id} className={s.logRow}>
          <time className={s.logTime} dateTime={event.ts}>{timestamp(event.ts).slice(11)}</time>
          <span className={s.logAgent}>{event.agent}</span>
          <span className={s.logTitle} title={`${event.agent} · ${event.type.replaceAll("_", " ")}: ${event.title}`}>{event.title}</span>
        </li>)}
      </ul>
    </section>
  );
}
