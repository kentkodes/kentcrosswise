"use client";
import { useEffect, useRef, useState } from "react";
import { advancePlayback, emptyPlayback, receiveEvents, timestamp } from "../_site/activity";
import { useActivity } from "../_site/use-activity";
import s from "./office.module.css";

export function OfficeFeed() {
  const { events, status } = useActivity();
  const [playback, setPlayback] = useState(emptyPlayback);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(true);
  const [visible, setVisible] = useState(false);
  const [inView, setInView] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const playing = !paused && !reduced && visible && inView;

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const motion = () => setReduced(preference.matches);
    const visibility = () => setVisible(document.visibilityState === "visible");
    motion();
    visibility();
    preference.addEventListener("change", motion);
    document.addEventListener("visibilitychange", visibility);
    const observer = new IntersectionObserver(([entry]) => setInView(!!entry?.isIntersecting));
    if (panel.current) observer.observe(panel.current);
    return () => {
      preference.removeEventListener("change", motion);
      document.removeEventListener("visibilitychange", visibility);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (status === "ready" || events.length) setPlayback((previous) => receiveEvents(previous, events, playing));
  }, [events, status, playing]);

  useEffect(() => {
    if (!playing || !playback.current) return;
    const timer = setTimeout(() => setPlayback(advancePlayback), 4_000);
    return () => clearTimeout(timer);
  }, [playing, playback]);

  const current = playback.current;
  return <section aria-label="Agent events" className={s.feed}>
    <section ref={panel} className={s.playback} aria-labelledby="playback-title" data-testid="activity-playback" data-playing={playing}>
      <h2 id="playback-title">{status === "error" ? "Activity replay · cached" : playback.mode === "live" ? "Live feed · new event" : "Activity replay"}</h2>
      {status === "error" ? <p role="status">The agent feed is unavailable. {events.length ? "Showing cached events; updates will retry shortly." : "Retrying shortly."}</p> : null}
      {!current ? <p role="status">{status === "loading" ? "Loading agent activity…" : status === "ready" ? "No public agent events yet." : "No cached events to replay."}</p> : <>
        <div className={s.current} data-event-id={current.id}>
          <p className={s.eventTitle}>{current.title}</p>
          <p>{current.agent} · {current.type.replaceAll("_", " ")}</p>
          <time dateTime={current.ts}>{timestamp(current.ts)}</time>
        </div>
        <p className={s.explanation}>{status === "error" ? "Cached replay" : playback.mode === "live" ? "Newly received from the public feed" : `Replaying ${playback.events.length} recorded events`} · original event time shown</p>
      </>}
      <div className={s.controls}>
        <button type="button" disabled={!current || reduced} onClick={() => setPaused(!paused)}>{reduced ? "Autoplay off" : paused ? "Resume" : "Pause"}</button>
        <button type="button" disabled={!current} onClick={() => setPlayback(advancePlayback)}>Next event</button>
        <span>{reduced ? "Reduced motion · use Next event" : paused ? "Playback paused" : "Advances every 4 seconds while visible"}</span>
      </div>
    </section>
    <h2>Recorded events</h2>
    <p>The latest public events, newest first. This list stays available while playback is paused.</p>
    <ol className={s.events} data-testid="agent-events" reversed>
      {[...events].reverse().map((event) => <li key={event.id} data-event-id={event.id}>
        <time dateTime={event.ts}>{timestamp(event.ts)}</time>{" "}
        <span data-field="agent">{event.agent}</span>{" "}<span data-field="type">{event.type.replaceAll("_", " ")}</span>{": "}
        <span data-field="title">{event.title}</span>
      </li>)}
    </ol>
  </section>;
}
