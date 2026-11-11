"use client";
// Client loop for the Board tab: the poller from office/connected/connected-office.tsx (bootstrap, state and
// incremental lanes, every OFFICE_PLAYBACK.pollMs while the document is visible, abort on unmount) without
// the room. Received events are settled at once, because the board does not animate: an undrained pending
// queue would stop incremental polling at the playback capacity.
// Two more rules: a playback that reports a restart gap is replaced by a fresh one (at most once per
// RESTART_MIN_MS), because the old playback never recovers on its own; and the view is only republished when
// its key changes, with the age timer stopped while the document is hidden.
import { useEffect, useState } from "react";
import { OFFICE_PLAYBACK, OfficePlayback, type OfficeClock, type PlaybackView } from "../../../../office-playback";
import { ACTIVITY_LIMIT, shouldRestart, viewKey } from "./board-state";

const clock = (): OfficeClock => ({ wallMs: Date.now(), monoMs: performance.now() });

function settle(controller: OfficePlayback): void {
  for (let event = controller.begin(); event; event = controller.begin()) controller.finish(event.ref);
}

/** One playback and the requests in flight for it. A restart replaces the whole session. */
interface Session { controller: OfficePlayback; abort: AbortController; stateBusy: boolean; eventBusy: boolean }
const newSession = (): Session => ({ controller: new OfficePlayback(), abort: new AbortController(), stateBusy: false, eventBusy: false });

/**
 * The latest playback view for the board. `polling` is true while the document is visible, which is when the
 * feed is retried; the "updates will retry" note depends on it.
 */
export function useOfficeView(): { view: PlaybackView | null; nowMs: number; polling: boolean } {
  const [view, setView] = useState<PlaybackView | null>(null);
  const [nowMs, setNowMs] = useState(0);
  const [polling, setPolling] = useState(false);
  useEffect(() => {
    let s = newSession();
    let lastRestart = -Infinity;
    let lastKey = "";
    let stateTimer: ReturnType<typeof setInterval> | undefined;
    let eventTimer: ReturnType<typeof setInterval> | undefined;
    let ageTimer: ReturnType<typeof setInterval> | undefined;
    const visible = () => document.visibilityState === "visible";

    const publish = () => {
      settle(s.controller);
      const now = clock();
      const next = s.controller.view(now);
      if (shouldRestart(next, lastRestart, now.monoMs)) { lastRestart = now.monoMs; restart(); return; }
      setNowMs(now.wallMs);
      const key = viewKey(next);
      if (key === lastKey) return;
      lastKey = key;
      // The working copy keeps only the newest live events; replay is already capped by the feed.
      setView({ ...next, log: next.log.slice(-ACTIVITY_LIMIT) });
    };

    const send = async (mode: "bootstrap" | "state" | "incremental") => {
      const mine = s;
      const lane = mode === "state" ? "state" : "events";
      if (lane === "state" ? mine.stateBusy : mine.eventBusy) return;
      const request = mine.controller.request(mode, clock());
      if (!request) return;
      if (lane === "state") mine.stateBusy = true; else mine.eventBusy = true;
      const requestAbort = new AbortController();
      const cancel = () => requestAbort.abort();
      mine.abort.signal.addEventListener("abort", cancel, { once: true });
      const timeout = setTimeout(cancel, 10000);
      const query = new URLSearchParams({ mode });
      if (mode === "state" && request.epoch !== null) query.set("privacy_epoch", request.epoch);
      if (mode === "incremental" && request.cursor) { query.set("cursor", request.cursor); query.set("limit", "50"); if (request.rebind) query.set("rebind", "true"); }
      try {
        const response = await fetch(`/api/public/office?${query}`, { cache: "no-store", signal: requestAbort.signal });
        if (!response.ok) throw new Error("unavailable");
        mine.controller.receive(request, await response.json(), clock());
        const state = mine.controller.view(clock());
        if (state.mode === "live" && !state.active && state.pending.length === 0 && state.replay.events.length > 0 && !state.gap) mine.controller.setMode("replay");
      } catch { if (!mine.abort.signal.aborted) mine.controller.fail(request); }
      finally {
        clearTimeout(timeout);
        mine.abort.signal.removeEventListener("abort", cancel);
        if (lane === "state") mine.stateBusy = false; else mine.eventBusy = false;
        if (!mine.abort.signal.aborted) publish();
      }
    };
    // Both network lanes poll every OFFICE_PLAYBACK.pollMs while the document is visible and stop while
    // it is hidden. Becoming visible fetches state and events once, then resumes the intervals.
    const pollEvents = () => { void send(s.controller.view(clock()).history === "partial" ? "bootstrap" : "incremental"); };
    const stopPolling = () => { clearInterval(stateTimer); clearInterval(eventTimer); stateTimer = eventTimer = undefined; };
    const startPolling = () => {
      stopPolling();
      stateTimer = setInterval(() => { void send("state"); }, OFFICE_PLAYBACK.pollMs);
      eventTimer = setInterval(pollEvents, OFFICE_PLAYBACK.pollMs);
    };
    const startAge = () => { if (ageTimer === undefined) ageTimer = setInterval(publish, 1000); };
    const stopAge = () => { clearInterval(ageTimer); ageTimer = undefined; };
    // Replaces the playback that reported a restart gap. Old requests are aborted; the new one bootstraps.
    const restart = () => {
      s.abort.abort();
      s = newSession();
      lastKey = "";
      setView(null);
      stopPolling();
      pollEvents();
      startPolling();
    };
    const onVisibility = () => {
      if (!visible()) { stopPolling(); stopAge(); setPolling(false); return; }
      setPolling(true);
      startAge();
      if (stateTimer !== undefined) return;
      if (s.controller.view(clock()).history === "initialized") void send("state");
      pollEvents(); startPolling(); publish();
    };
    if (visible()) { setPolling(true); startAge(); pollEvents(); startPolling(); }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      s.abort.abort(); stopPolling(); stopAge();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return { view, nowMs, polling };
}
