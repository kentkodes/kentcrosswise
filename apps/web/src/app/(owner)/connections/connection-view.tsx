// The body of /connections, separate from the page so tests can render each state.
import Link from "next/link";
import { formatUtc } from "../format";
import { Dot, Notice, Region } from "../owner-ui";
import s from "../owner.module.css";
import type { GoogleConnection } from "@/server/google";
import { connectGoogleAction, disconnectGoogleAction } from "./actions";

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
