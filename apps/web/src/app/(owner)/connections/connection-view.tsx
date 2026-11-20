// The body of /connections, separate from the page so tests can render each state.
import Link from "next/link";
import { formatUtc } from "../format";
import { Dot, Notice, Region } from "../owner-ui";
import s from "../owner.module.css";
import type { GoogleConnection } from "@/server/google";
import type { DemoCalendarStatus, SyncOutcome } from "../../../server/demo-calendar";
import { publicCalendarUrl } from "../../../server/public-log";
import {
  connectDemoCalendarAction,
  connectGoogleAction,
  disconnectDemoCalendarAction,
  disconnectGoogleAction,
  syncDemoCalendarAction,
} from "./actions";

const SCOPE_LABELS = [{ key: "calendar", label: "Calendar events (own calendar)" }] as const;

export function ConnectionView({ conn, confirming }: { conn: GoogleConnection; confirming: boolean }) {
  const since = conn.connectedAt && !Number.isNaN(Date.parse(conn.connectedAt)) ? formatUtc(conn.connectedAt) : null;
  return (
    <Region id="google" title="Google" testId="google">
      <div className={`${s.pad} ${s.stack}`}>
        <p className={s.emph}>
          <Dot tone={conn.connected ? "ok" : "warn"} /> {conn.connected ? "Connected" : "Not connected"}
        </p>
        {!conn.configured ? (
          <p className={s.muted}>Google is not configured here (no Google sign-in or token secret), so it cannot be connected.</p>
        ) : null}
        {conn.expired ? <p className={s.muted}>Google rejected the stored connection. Connect again.</p> : null}
        {conn.connected ? (
          <>
            <ul className={s.list}>
              {SCOPE_LABELS.map(({ key, label }) => {
                const granted = conn.scopes.includes(key);
                return (
                  <li key={key} data-testid={`scope-${key}`}>
                    <Dot tone={granted ? "ok" : "warn"} /> {label}: {granted ? (since ? `granted since ${since}` : "granted") : "not granted"}
                  </li>
                );
              })}
            </ul>
            {conn.scopes.length < SCOPE_LABELS.length ? (
              <p className={s.muted}>Calendar access is missing. Reconnect and approve it.</p>
            ) : null}
          </>
        ) : null}
        {conn.configured ? (
          <div className={s.formRow}>
            <form action={connectGoogleAction}>
              <button className={`${s.button} ${s.primary} ${s.tapTarget}`} type="submit">
                {conn.connected || conn.expired ? "Reconnect Google" : "Connect Google"}
              </button>
            </form>
            {conn.connected && !confirming ? (
              <Link className={`${s.button} ${s.tapTarget}`} href="/connections?confirm=disconnect">
                Disconnect
              </Link>
            ) : null}
          </div>
        ) : null}
        {conn.connected && confirming ? (
          <form action={disconnectGoogleAction} className={s.stack}>
            <Notice tone="warn">Disconnect Google? The token is revoked at Google and deleted here.</Notice>
            <div className={s.formRow}>
              <button className={`${s.button} ${s.tapTarget}`} type="submit">
                Yes, disconnect
              </button>
              <Link className={`${s.button} ${s.tapTarget}`} href="/connections">
                Cancel
              </Link>
            </div>
          </form>
        ) : null}
      </div>
    </Region>
  );
}

const SYNC_TEXT: Record<SyncOutcome, string> = {
  synced: "in sync",
  nothing: "nothing to change",
  "not-configured": "not configured",
  "not-connected": "paused: not connected",
  reconnect: "paused: Google rejected the connection",
  failed: "some changes did not go through",
};

/**
 * The demo calendar of the public log (PL7): a separate dummy Google account, never the owner's. Its own consent,
 * its sync state, and the link to its public calendar.
 */
export function DemoCalendarView({ conn, status, confirming }: { conn: GoogleConnection; status: DemoCalendarStatus | null; confirming: boolean }) {
  const link = publicCalendarUrl(status?.calendarId);
  const last = status?.lastSyncAt && status.lastSyncOutcome ? `${formatUtc(status.lastSyncAt)}, ${SYNC_TEXT[status.lastSyncOutcome]}` : null;
  return (
    <Region id="demo-calendar" title="Demo calendar" testId="demo-calendar">
      <div className={`${s.pad} ${s.stack}`}>
        <p className={s.emph}>
          <Dot tone={conn.connected ? "ok" : "warn"} /> {conn.connected ? "Connected" : "Not connected"}
        </p>
        <p className={s.muted}>
          The public log mirrors the calendar suggestions you added from published contact notes into a separate dummy
          Google account, with sanitized titles and times rounded to the hour. Pick that account when Google asks; your
          own account is refused.
        </p>
        {!conn.configured ? <p className={s.muted}>The demo calendar is not configured here (no Google client or token secret).</p> : null}
        {conn.expired ? <p className={s.muted}>Google rejected the stored connection. Mirroring is paused until you connect again.</p> : null}
        {status ? (
          <ul className={s.list}>
            <li data-testid="demo-calendar-id">Calendar: {status.calendarId ?? "none yet"}</li>
            <li data-testid="demo-calendar-count">Events mirrored: {status.mirrored}</li>
            <li data-testid="demo-calendar-sync">Last sync: {last ?? "none yet"}</li>
          </ul>
        ) : null}
        {link ? (
          <p>
            <a href={link} rel="noopener noreferrer" target="_blank">
              Open the public calendar
            </a>
          </p>
        ) : null}
        {conn.configured ? (
          <div className={s.formRow}>
            <form action={connectDemoCalendarAction}>
              <button className={`${s.button} ${s.primary} ${s.tapTarget}`} type="submit">
                {conn.connected || conn.expired ? "Reconnect demo calendar" : "Connect demo calendar"}
              </button>
            </form>
            {conn.connected ? (
              <form action={syncDemoCalendarAction}>
                <button className={`${s.button} ${s.tapTarget}`} type="submit">
                  Sync now
                </button>
              </form>
            ) : null}
            {conn.connected && !confirming ? (
              <Link className={`${s.button} ${s.tapTarget}`} href="/connections?confirm=demo-disconnect#demo-calendar">
                Disconnect
              </Link>
            ) : null}
          </div>
        ) : null}
        {conn.connected && confirming ? (
          <form action={disconnectDemoCalendarAction} className={s.stack}>
            <Notice tone="warn">Disconnect the demo calendar? The token is revoked at Google and deleted here. Its events stay in the public calendar.</Notice>
            <div className={s.formRow}>
              <button className={`${s.button} ${s.tapTarget}`} type="submit">
                Yes, disconnect
              </button>
              <Link className={`${s.button} ${s.tapTarget}`} href="/connections#demo-calendar">
                Cancel
              </Link>
            </div>
          </form>
        ) : null}
      </div>
    </Region>
  );
}
