"use client";
// The /demo Log tab (PL5): the owner's published entries, newest first, each with its sanitized text, a one-line
// outcome and an Evidence disclosure listing every step in plain words and the read-back checks (PL6). Withheld
// records are only counted. The accuracy lines are counted from the published records only. The calendar (PL7)
// lists the events mirrored into a separate dummy Google account, each linked to its record, and links to that
// public calendar (no embed).
// Loaded in the browser from GET /api/public/log (public pages may not import server code, D10).
import {
  accuracyLines,
  checkText,
  eventWhen,
  hourLabel,
  isMine,
  isProblem,
  KIND_LABEL,
  stepText,
  summary,
  type LogCalendar,
  type LogRecord,
} from "../_site/public-log";
import { usePublicLog } from "../_site/use-public-log";
import d from "./demo.module.css";

export function LogSection({ titleId }: { titleId: string }) {
  const state = usePublicLog();
  const log = state.status === "ready" && state.log.available ? state.log : null;
  return (
    <>
      <div className={d.headRow}>
        <h2 id={titleId} className={d.h2}>
          Log
        </h2>
        {log ? (
          <span className={d.muted} data-testid="log-counts">
            {log.counts.published} published · {log.counts.withheld} withheld · {log.counts.awaitingReview} awaiting review
          </span>
        ) : null}
      </div>
      <p className={d.caption}>
        {state.status === "ready" ? state.log.label : "Tasks published automatically after sanitization; some records withheld for privacy/security"}
      </p>
      {state.status === "loading" ? <p className={d.note}>Loading the log…</p> : null}
      {state.status === "error" ? <p className={d.note}>The log is unavailable right now.</p> : null}
      {state.status === "ready" && !state.log.available ? <p className={d.note}>{state.log.note || "The log is unavailable right now."}</p> : null}
      {log?.accuracy ? (
        <section className={d.accuracy} aria-label="Accuracy">
          <ul className={d.accuracyList}>
            {accuracyLines(log.accuracy).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className={d.muted}>Counted from the published records only, by my verdicts.</p>
        </section>
      ) : null}
      {log?.calendar ? <CalendarSection calendar={log.calendar} shown={new Set(log.records.map((r) => r.id))} /> : null}
      {log && log.records.length === 0 ? <p className={d.note}>Nothing published yet.</p> : null}
      {log && log.records.length > 0 ? (
        <ol className={d.records} aria-label="Published entries">
          {log.records.map((r) => (
            <RecordItem key={r.id} r={r} />
          ))}
        </ol>
      ) : null}
    </>
  );
}

function CalendarSection({ calendar, shown }: { calendar: LogCalendar; shown: ReadonlySet<string> }) {
  return (
    <section className={d.accuracy} aria-label="Demo calendar">
      <p className={d.cardLabel}>Demo calendar</p>
      <p className={d.muted}>
        Calendar suggestions I added from published contact notes, mirrored to a separate demo Google account: titles
        sanitized like the records, times rounded to the hour.
      </p>
      {calendar.events.length > 0 ? (
        <ul className={d.accuracyList} aria-label="Calendar events">
          {calendar.events.map((e) => (
            <li key={`${e.recordId}-${e.start}-${e.title}`}>
              <time className={d.mono} dateTime={e.start}>
                {eventWhen(e)}
              </time>{" "}
              · {shown.has(e.recordId) ? <a href={`#r-${e.recordId}`}>{e.title}</a> : e.title}
            </li>
          ))}
        </ul>
      ) : (
        <p className={d.muted}>{calendar.link ? "No events yet." : "The demo calendar is not connected yet."}</p>
      )}
      {calendar.link ? (
        <p>
          <a href={calendar.link} rel="noopener noreferrer" target="_blank">
            Open the public calendar
          </a>
        </p>
      ) : null}
    </section>
  );
}

function RecordItem({ r }: { r: LogRecord }) {
  const outcome = summary(r);
  return (
    <li className={d.record} id={`r-${r.id}`}>
      <div className={d.recordMeta}>
        <span className={d.route}>{KIND_LABEL[r.kind]}</span>
        <time className={d.mono} dateTime={r.capturedHour}>
          {hourLabel(r.capturedHour)}
        </time>
      </div>
      <p className={d.recordText}>{r.text}</p>
      {outcome ? <p className={d.muted}>{outcome}</p> : null}
      <details className={d.evidence}>
        <summary className={d.evidenceSummary}>
          Evidence · {r.steps.length} steps{r.checks.length > 0 ? ` · ${r.checks.length} ${r.checks.length === 1 ? "check" : "checks"}` : ""}
        </summary>
        <ol className={d.steps}>
          {r.steps.map((s, i) => (
            <li key={i} className={isProblem(s) ? `${d.step} ${d.stepProblem}` : isMine(s) ? `${d.step} ${d.stepMine}` : d.step}>
              <time className={d.mono} dateTime={s.hour}>
                {s.hour.slice(11, 16)}
              </time>
              <span>{stepText(s)}</span>
            </li>
          ))}
        </ol>
        {r.checks.length > 0 ? (
          <>
            <p className={d.cardLabel}>Checks{r.checksVersion !== null ? ` · list v${r.checksVersion}` : ""}</p>
            <ul className={d.steps} aria-label="Checks">
              {r.checks.map((c) => (
                <li key={c.check} className={c.result === "pass" ? d.step : `${d.step} ${d.stepProblem}`}>
                  {checkText(c)}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </details>
    </li>
  );
}
