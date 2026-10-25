"use client";
import { useActivity } from "../_site/use-activity";
import { timestamp } from "../_site/activity";
import { Document } from "./icons";
import s from "./home.module.css";

export function RecentActivity() {
  const { events, status } = useActivity();
  return <div className={s.activityContent}>
    {status === "error" ? <p className={s.activityNote}>Feed unavailable.{events.length ? " Cached activity shown." : " Retrying shortly."}</p> : null}
    {!events.length ? <p className={s.activityNote}>{status === "loading" ? "Loading agent activity…" : status === "ready" ? "No public agent activity yet." : ""}</p> : null}
    <ul className={s.activityList}>
      {events.slice(-3).reverse().map((event) => <li key={event.id} className={s.activity}>
        <span className={s.activityTile}><Document className={s.activityIcon} /></span>
        <span className={s.activityTitle} title={`${event.agent} · ${event.type.replaceAll("_", " ")}: ${event.title}`}>{event.title}</span>
        <time className={s.activityWhen} dateTime={event.ts}>{timestamp(event.ts)}</time>
      </li>)}
    </ul>
  </div>;
}
