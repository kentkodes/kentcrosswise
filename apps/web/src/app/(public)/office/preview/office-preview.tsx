"use client";
import { useEffect, useRef, useState } from "react";
import { drawOffice } from "./draw-office";
import { HEIGHT, WIDTH, SCENARIOS, beatAt, initialClock, next, scenePose, tick } from "./scene";
import type { Role, Scenario } from "./scene";
import s from "./preview.module.css";

export function OfficePreview() {
  const [scenario, setScenario] = useState<Scenario>("success");
  const [clock, setClock] = useState(initialClock);
  const [selected, setSelected] = useState<Role>("developer");
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(true);
  const [visible, setVisible] = useState(false);
  const [inView, setInView] = useState(false);
  const [roomWidth, setRoomWidth] = useState(320);
  const [canvasReady, setCanvasReady] = useState(true);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const { beats } = SCENARIOS[scenario];
  const beat = beatAt(beats, clock.index);
  const progress = Math.min(1, clock.elapsed / beat.duration);
  const pose = scenePose(beats, clock.index, progress);
  const playing = !paused && !reduced && visible && inView && !clock.done;

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const motion = () => setReduced(preference.matches);
    const visibility = () => setVisible(document.visibilityState === "visible");
    motion(); visibility();
    preference.addEventListener("change", motion);
    document.addEventListener("visibilitychange", visibility);
    const element = stage.current;
    const observer = new IntersectionObserver(([entry]) => setInView(!!entry?.isIntersecting));
    const size = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const available = entry.contentRect.width;
      setRoomWidth(available < WIDTH ? available : Math.min(640, Math.floor(available / WIDTH) * WIDTH));
    });
    if (element) { observer.observe(element); size.observe(element); }
    return () => { preference.removeEventListener("change", motion); document.removeEventListener("visibilitychange", visibility); observer.disconnect(); size.disconnect(); };
  }, []);
  useEffect(() => {
    if (!playing) return;
    // A bounded 10fps simulation freezes cleanly offscreen; no wall-clock catch-up.
    const timer = setInterval(() => setClock((current) => tick(current, 100, beats)), 100);
    return () => clearInterval(timer);
  }, [playing, beats]);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) { setCanvasReady(false); return; }
    const currentBeat = beatAt(beats, clock.index);
    drawOffice(ctx, scenePose(beats, clock.index, Math.min(1, clock.elapsed / currentBeat.duration)), currentBeat.kind, Math.floor(clock.elapsed / 180), selected);
  }, [beats, clock, selected]);

  function chooseScenario(value: Scenario) { setScenario(value); setClock(initialClock()); setPaused(true); }
  const currentStatus = selected === beat.role ? beat.title : pose.walking === selected ? "Returning to the desk" : "At their workstation";
  return <section aria-label="Office sample animation" className={s.preview}>
    <div className={s.toolbar}>
      <label htmlFor="office-scenario">Sample story <select id="office-scenario" value={scenario} onChange={(event) => chooseScenario(event.target.value as Scenario)}>
        {Object.entries(SCENARIOS).map(([value, entry]) => <option key={value} value={value}>{entry.label}</option>)}
      </select></label>
      <div className={s.controls}>
        <button type="button" disabled={reduced || clock.done} onClick={() => setPaused((value) => !value)}>{reduced ? "Autoplay off" : paused ? "Resume" : "Pause"}</button>
        <button type="button" disabled={clock.done} onClick={() => { setPaused(true); setClock((current) => next(current, beats)); }}>Next event</button>
        <button type="button" onClick={() => { setClock(initialClock()); setPaused(true); }}>Restart</button>
      </div>
      <p>{reduced ? "Reduced motion · manual stepping" : clock.done ? "Sample complete" : paused ? "Playback paused" : !visible || !inView ? "Playback suspended" : "Sample playing"}</p>
    </div>
    <div className={s.studio}>
      <div ref={stage} className={s.stage}>
        <div className={s.room} style={{ width: roomWidth }} data-testid="office-room" data-event={beat.kind} data-elapsed={clock.elapsed} data-playing={playing} data-filed={pose.filed}>
          <canvas ref={canvas} width={WIDTH} height={HEIGHT} aria-hidden="true" className={s.canvas} />
          {(["developer", "qa"] as const).map((role) => <button key={role} className={s.robotTarget} type="button" aria-label={`${role === "qa" ? "QA" : "Developer"} robot`} aria-pressed={selected === role} style={{ left: `${pose[role].x / WIDTH * 100}%`, top: `${(pose[role].y - 12) / HEIGHT * 100}%` }} onClick={() => setSelected(role)} />)}
          <button className={s.deskTarget} style={{ left: "16%" }} type="button" aria-label="Inspect Developer workstation" onClick={() => setSelected("developer")} />
          <button className={s.deskTarget} style={{ left: "84%" }} type="button" aria-label="Inspect QA workstation" onClick={() => setSelected("qa")} />
        </div>
        {!canvasReady ? <p role="status">The pixel scene could not load. You can still inspect the robots and step through the sample below.</p> : null}
        <div className={s.legend} aria-label="Inspect a coworker">
          <button type="button" aria-pressed={selected === "developer"} onClick={() => setSelected("developer")}><span className={s.teal} />Developer</button>
          <button type="button" aria-pressed={selected === "qa"} onClick={() => setSelected("qa")}><span className={s.amber} />QA</button>
        </div>
      </div>
      <aside className={s.inspector} aria-label="Robot inspection">
        <h2>{selected === "developer" ? "Developer" : "QA"}</h2>
        <p className={s.role}>{selected === "developer" ? "Teal robot · builds and revises" : "Amber robot · reviews and files"}</p>
        <h3>{currentStatus}</h3>
        <p>{selected === beat.role ? beat.detail : selected === "developer" ? "Developer writes the change and delivers it for review." : "QA checks the work, requests revisions and files merged papers."}</p>
        <dl><div><dt>Work item</dt><dd>Welcome note · fictional sample</dd></div><div><dt>Papers</dt><dd>{pose.carrying ? `Carried by ${pose.carrying === "qa" ? "QA" : "Developer"}` : pose.filed ? "Filed after merge" : pose.paper === "inbox" ? "In the owner inbox" : pose.paper === "cabinet" ? "At the cabinet" : `At ${pose.paper === "qa" ? "QA’s" : "Developer’s"} desk`}</dd></div></dl>
      </aside>
    </div>
    <section className={s.playback} aria-label="Sample playback">
      <div className={s.now} aria-live="polite" aria-atomic="true"><span>Sample event {clock.index + 1} of {beats.length}</span><h2>{beat.title}</h2><p>{beat.detail}</p></div>
      <p className={s.help}>Select a robot or desk to inspect it. {reduced ? "Use Next event to move through the story without animation." : "Playback pauses when this room is offscreen or the tab is hidden."}</p>
    </section>
    <details className={s.timeline}><summary>Read the sample sequence</summary><ol>{beats.map((entry, index) => <li key={`${entry.kind}-${index}`} aria-current={index === clock.index ? "step" : undefined}>{entry.title}</li>)}</ol></details>
  </section>;
}
