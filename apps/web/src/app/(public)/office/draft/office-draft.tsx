"use client";
import { useEffect, useRef, useState } from "react";
import { drawOffice } from "./draw-office";
import { ANNEX_HEIGHT, BEATS, HEIGHT, PEOPLE, TASKS, WIDTH, actorTask, currentBeat, eventTime, inFlight, initialScene, nextEvent, taskStates, tick } from "./scene";
import type { Actor } from "./scene";
import s from "./draft.module.css";

const STATUS = { queued: "Queued", assigned: "Assigned", coding: "Coding", pr_opened: "PR opened", ci_running: "Checks running", tests_failed: "Tests failed", ci_passed: "Checks passed", reviewing: "Reviewing", changes_requested: "Changes requested", approved: "Approved · awaiting merge", merged: "Merged", deployed: "Deployed", waiting: "Waiting on owner", paused: "Task paused", cancelled: "Cancelled", failed: "Needs attention" };
const MAIN_ACTORS: Actor[] = ["boss", "dev1", "dev2", "dev3", "dev4", "qa", "scraper", "docs", "router"];

export function OfficeDraft() {
  const [scene, setScene] = useState(initialScene);
  const [selected, setSelected] = useState<Actor>("boss");
  const [taskOnly, setTaskOnly] = useState(false);
  const [annex, setAnnex] = useState(false);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(true);
  const [override, setOverride] = useState(false);
  const [visible, setVisible] = useState(false);
  const [inView, setInView] = useState(false);
  const [width, setWidth] = useState(WIDTH);
  const [canvasReady, setCanvasReady] = useState(true);
  const stage = useRef<HTMLDivElement>(null);
  const room = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const annexCanvas = useRef<HTMLCanvasElement>(null);
  const beat = currentBeat(scene.index);
  const tasks = taskStates(scene);
  const task = actorTask(scene, selected);
  const motionAllowed = !reduced || override;
  const playing = motionAllowed && !paused && visible && inView && !scene.done;
  const selectedState = task ? tasks[task] : undefined;
  const events = BEATS.slice(0, scene.index + 1).map((entry, index) => ({ ...entry, index })).filter((entry) => !taskOnly || entry.task === task);

  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const motion = () => setReduced(media.matches);
    const visibility = () => setVisible(document.visibilityState === "visible");
    motion(); visibility();
    media.addEventListener("change", motion); document.addEventListener("visibilitychange", visibility);
    const element = stage.current;
    const observer = new IntersectionObserver(([entry]) => setInView(!!entry?.isIntersecting));
    const resize = new ResizeObserver(([entry]) => { if (entry) setWidth(entry.contentRect.width < WIDTH ? entry.contentRect.width : Math.min(WIDTH * 2, Math.floor(entry.contentRect.width / WIDTH) * WIDTH)); });
    if (room.current) observer.observe(room.current);
    if (element) resize.observe(element);
    return () => { media.removeEventListener("change", motion); document.removeEventListener("visibilitychange", visibility); observer.disconnect(); resize.disconnect(); };
  }, []);
  useEffect(() => {
    if (!playing) return;
    let previous: number | undefined;
    let frame: number;
    const animate = (now: number) => {
      if (previous !== undefined) {
        const delta = now - previous;
        setScene((current) => tick(current, delta));
      }
      previous = now;
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [playing]);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) { setCanvasReady(false); return; }
    drawOffice(ctx, scene, selected);
    const extra = annexCanvas.current?.getContext("2d");
    if (extra) drawOffice(extra, scene, selected, true);
  }, [scene, selected, annex]);

  const select = (actor: Actor) => { setSelected(actor); setTaskOnly(false); };
  const play = () => { setOverride(true); setPaused(false); if (scene.done) setScene(initialScene()); };
  const selectButton = (actor: Actor) => <button key={actor} type="button" aria-pressed={selected === actor} onClick={() => select(actor)}><span className={s.swatch} style={{ backgroundColor: PEOPLE[actor].color }} />{PEOPLE[actor].name}</button>;
  return <section className={s.draft} aria-label="Connected office fictional draft">
    <div className={s.toolbar}>
      <div className={s.controls}>
        <button type="button" onClick={() => playing || paused === false && motionAllowed && !scene.done ? setPaused(true) : play()}>{scene.done ? "Play again" : !motionAllowed ? "Play animation" : paused ? "Resume" : "Pause"}</button>
        <button type="button" disabled={scene.done} onClick={() => { setPaused(true); setScene((current) => nextEvent(current)); }}>Next event</button>
        <button type="button" onClick={() => { setScene(initialScene()); setOverride(true); setPaused(false); }}>Restart</button>
      </div>
      <p>{scene.done ? "Sample complete" : !motionAllowed ? "Reduced motion · choose Play for movement" : paused ? "Playback paused" : !visible || !inView ? "Playback suspended" : "Playing every transition in sequence"}</p>
    </div>
    <div className={s.studio}>
      <div ref={stage} className={s.stage}>
        <div ref={room} className={s.room} style={{ width }} data-testid="connected-room" data-playing={playing} data-step={scene.index} data-event={beat.kind} data-settled={scene.settled} data-filed={Object.values(tasks).filter((item) => item.filed).length}>
          <canvas ref={canvas} width={WIDTH} height={HEIGHT} className={s.canvas} aria-hidden="true" />
          {MAIN_ACTORS.filter((actor) => actor !== "dev3" && actor !== "dev4").map((actor) => <button key={actor} className={s.target} type="button" aria-label={`Inspect ${PEOPLE[actor].name} in the room`} aria-pressed={selected === actor} style={{ left: `${scene.positions[actor].x / WIDTH * 100}%`, top: `${(scene.positions[actor].y - 12) / HEIGHT * 100}%` }} onClick={() => select(actor)} />)}
        </div>
        {!canvasReady && <p role="status">The room could not draw. Use the coworker controls and event log to explore the sample.</p>}
        <div className={s.roomNotes}><span>{inFlight(scene)} of 4 sample tasks in flight</span><button type="button" aria-expanded={annex} aria-controls="worker-annex" onClick={() => setAnnex(!annex)}>{annex ? "Close worker annex" : "Open worker annex"}</button></div>
        <div id="worker-annex" hidden={!annex} className={s.annex}>
          <div className={s.annexRoom} style={{ width }}><canvas ref={annexCanvas} width={WIDTH} height={ANNEX_HEIGHT} className={s.canvas} aria-hidden="true" /></div>
          <p>{tasks.annex.seen ? "The annex worker has a separate assignment. Opening this room changes only the view." : "An extra workspace, ready for a later assignment. It starts after a task releases a slot."}</p>
        </div>
        <nav className={s.people} aria-label="Inspect a coworker">{MAIN_ACTORS.map(selectButton)}{selectButton("extra")}</nav>
        <p className={s.roomHelp}>Boss at the back · shared Developer bench · specialists around the perimeter. Empty chairs are capacity, not running workers.</p>
      </div>
      <aside className={s.inspector} aria-label="Agent details">
        <h2>{PEOPLE[selected].name}</h2><p className={s.role}>{PEOPLE[selected].job}</p>
        <h3>{selected === "router" ? "Planned station" : selectedState ? STATUS[selectedState.kind] : selected === "dev3" || selected === "dev4" ? "Available seat" : "Ready at the desk"}</h3>
        <dl>
          <div><dt>Task</dt><dd>{task ? TASKS[task].description : "No sample assignment"}</dd></div>
          {task && TASKS[task].parent && <div><dt>Related work</dt><dd>{TASKS[TASKS[task].parent!].description}</dd></div>}
          <div><dt>Papers</dt><dd>{selectedState?.filed ? "Filed after this task’s merge" : selectedState?.kind === "waiting" ? "Waiting in the owner approval tray" : selectedState?.kind === "cancelled" ? "Withdrawn · not filed" : selectedState ? "Unfiled" : "No task packet"}</dd></div>
          <div><dt>Scene</dt><dd>Fictional sample · event {scene.index + 1} of {BEATS.length}</dd></div>
          <div><dt>Illustrated time</dt><dd>{eventTime(scene.index)}</dd></div>
        </dl>
        <button className={s.taskButton} type="button" disabled={!task} onClick={() => setTaskOnly(true)}>Show task events</button>
        <p className={s.small}>Every transition is retained. {BEATS.length - scene.index - 1} sample events remain. Playback shows this point in the story, not a live runtime state.</p>
      </aside>
    </div>
    <section className={s.now} aria-label="Current sample event"><h2>{beat.title}</h2><p className={s.small}>Fictional event {scene.index + 1} of {BEATS.length} · {scene.settled ? "Illustration complete" : "Illustrating"}</p><p>{beat.detail}</p></section>
    <section className={s.logs} aria-label="Sample event log">
      <div className={s.logHeading}><h2>Event log</h2><div className={s.filters}><button type="button" aria-pressed={!taskOnly} onClick={() => setTaskOnly(false)}>All events</button><button type="button" disabled={!task} aria-pressed={taskOnly} onClick={() => setTaskOnly(true)}>Selected task</button></div></div>
      <p className={s.small}>{taskOnly && task ? TASKS[task].description : "All coworkers and tasks"} · fictional timestamps</p>
      <ol className={s.eventList}>{events.map((entry) => <li key={entry.index} aria-current={entry.index === scene.index ? "step" : undefined}><time>{eventTime(entry.index)}</time><div><span>{PEOPLE[entry.actor].name} · {STATUS[entry.kind]}</span><p>{TASKS[entry.task].description}</p></div></li>)}</ol>
      {events.length === 0 && <p>No events for this task have played yet.</p>}
    </section>
    <details className={s.stations}><summary>What the stations mean</summary><dl><div><dt>QA and the test rack</dt><dd>The amber robot reviews; the rack runs automated checks. A pass is not an approval or a merge.</dd></div><div><dt>Owner approval tray</dt><dd>Holds work that needs a human decision. The Orchestrator cannot grant approval.</dd></div><div><dt>Archive and deploy lift</dt><dd>Only merges file papers. Deployment is a separate result; Docs starts at merge and follows its own review.</dd></div><div><dt>Router / Categorizer</dt><dd>A planned station shown for composition review, without a live connection.</dd></div></dl></details>
  </section>;
}
