"use client";
// The home page's lead panel (PL5): the three newest published log entries with their outcome and a link to the
// full log, then the latest public agent activity. The log loads in the browser from GET /api/public/log.
import Link from "next/link";
import { hourLabel, KIND_LABEL, summary } from "../_site/public-log";
import { usePublicLog } from "../_site/use-public-log";
import { Xray } from "../_site/xray";
import { RecentActivity } from "./recent-activity";
import s from "./home.module.css";

export function LogPreview() {
  const state = usePublicLog();
  const log = state.status === "ready" && state.log.available ? state.log : null;
  const latest = log ? log.records.slice(0, 3) : [];
  return (
    <div className={s.panel}>
      <section className={s.panelPart} aria-labelledby="latest-log">
        <div className={s.panelHead}>
          <h2 id="latest-log" className={s.panelTitle}>
            Latest from the log
          </h2>
          {log ? (
            <span className={s.label}>
              {log.counts.published} published · {log.counts.withheld} withheld
            </span>
          ) : null}
        </div>
        {state.status === "loading" ? <p className={s.logNote}>Loading the log…</p> : null}
        {state.status === "error" || (state.status === "ready" && !state.log.available) ? (
          <p className={s.logNote}>The log is unavailable right now.</p>
        ) : null}
        {log && latest.length === 0 ? <p className={s.logNote}>Nothing published yet.</p> : null}
        {latest.length > 0 ? (
          <ul className={s.entries}>
            {latest.map((r) => (
              <li key={r.id} className={s.entry}>
                <span className={s.entryMeta}>
                  {KIND_LABEL[r.kind]} · <time dateTime={r.capturedHour}>{hourLabel(r.capturedHour)}</time>
                </span>
                <span className={s.entryText}>{r.text}</span>
                {summary(r) ? <span className={s.entryMeta}>{summary(r)}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
        <Link className={s.more} href="/demo">
          Read the log
        </Link>
      </section>
      <section className={s.panelPart} aria-labelledby="agent-activity">
        <div className={s.panelHead}>
          <h2 id="agent-activity" className={s.panelTitle}>
            From the agent office
          </h2>
        </div>
        <Xray id="activity-feed">
          <RecentActivity />
        </Xray>
      </section>
    </div>
  );
}
