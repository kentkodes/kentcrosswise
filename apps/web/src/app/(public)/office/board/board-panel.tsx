"use client";
// The Board tab: status pills, role cards and the activity list. It owns the only board poller, so it
// mounts only while the Board tab is selected. Cards always render; the list keeps its last rows when the
// feed becomes unavailable, and says it will retry only while a retry can happen (the document is visible).
import { useMemo, useState } from "react";
import { ACTIVITY_FILTERS, deriveBoard, filterRows, loadingBoard, utcLabel, type ActivityFilter, type ActivityState, type Board, type BoardPills } from "./board-state";
import { TeamRoster } from "./roster";
import { useOfficeView } from "./use-office-view";
import s from "./board.module.css";

export function BoardPanel() {
  const { view, nowMs, polling } = useOfficeView();
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const board = useMemo(() => (view ? deriveBoard(view) : loadingBoard()), [view]);
  return (
    <div className={s.board}>
      <Pills pills={board.pills} />
      <h2 className={s.srOnly}>Agents</h2>
      <TeamRoster roster={board.roster} nowMs={nowMs} />
      <Activity board={board} filter={filter} onFilter={setFilter} polling={polling} />
    </div>
  );
}

function Pills({ pills }: { pills: BoardPills }) {
  const inFlight = pills.inFlight ?? 0;
  if (!pills.system && inFlight === 0 && !pills.feed) return null;
  return (
    <ul className={s.pills} aria-label="Office status">
      {pills.system && (
        <li className={s.pill}>
          <span className={s.dot} data-tone={pills.system.tone} aria-hidden="true" />
          {pills.system.label}
        </li>
      )}
      {inFlight > 0 && (
        <li className={s.pill}>
          <b>{inFlight}</b> {inFlight === 1 ? "task" : "tasks"} in flight
        </li>
      )}
      {pills.feed && (
        <li className={s.pill}>
          <span className={s.dot} data-tone={pills.feed.tone} aria-hidden="true" />
          {pills.feed.label}
        </li>
      )}
    </ul>
  );
}

const STATE_MESSAGE: Record<ActivityState, string> = {
  loading: "Loading agent activity…",
  unavailable: "The office feed is unavailable. Retrying shortly.",
  empty: "No public agent activity yet.",
  list: "No events for this filter in the current list.",
};

function Activity({ board, filter, onFilter, polling }: { board: Board; filter: ActivityFilter; onFilter: (filter: ActivityFilter) => void; polling: boolean }) {
  const { state, replay, stale } = board.activity;
  const rows = filterRows(board.activity.rows, filter);
  return (
    <section className={s.log} aria-labelledby="office-activity-title">
      <div className={s.logbar}>
        <h2 id="office-activity-title" className={s.logTitle}>{replay ? "Activity · replay" : "Activity"}</h2>
        <div className={s.chips} role="group" aria-label="Filter activity">
          {ACTIVITY_FILTERS.map((option) => (
            <button key={option.value} type="button" className={s.chip} aria-pressed={filter === option.value} onClick={() => onFilter(option.value)}>
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {replay && <p className={s.note}>Latest recorded events with their original times.</p>}
      {stale && polling && <p className={s.note}>Showing the last events received. Updates will retry.</p>}
      {rows.length === 0 && (
        <p className={s.empty}>{board.activity.rows.length > 0 ? STATE_MESSAGE.list : STATE_MESSAGE[state]}</p>
      )}
      {rows.length > 0 && (
        <ol className={s.rows}>
          {rows.map((row) =>
            row.kind === "withdrawn" ? (
              <li key={row.key} className={`${s.row} ${s.withdrawn}`}>
                <p>Withdrawn event</p>
              </li>
            ) : (
              <li key={row.key} className={s.row}>
                <div className={s.rowHead}>
                  <time dateTime={row.recordedAt} className={s.time}>
                    {utcLabel(row.recordedAt)}
                  </time>
                  <span className={s.who}>
                    <span className={s.rowDot} aria-hidden="true" />
                    {row.roleLabel}
                  </span>
                </div>
                <span className={s.event}>{row.label}</span>
                <span className={s.task}>{row.text}</span>
              </li>
            ),
          )}
        </ol>
      )}
    </section>
  );
}
