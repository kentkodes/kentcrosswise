"use client";
import { useEffect, useRef, useState } from "react";
import { OFFICE_PLAYBACK, OfficePlayback, type OfficeClock, type PlaybackEvent, type PlaybackView } from "../../../../office-playback";
import { OfficeRoom, executionActor, executionLabel, eventLabel, ROLE_LABEL } from "../../../../office-room";
import { drawOffice } from "../draft/draw-office";
import { PEOPLE, type Actor } from "../draft/scene";
import s from "./connected.module.css";
const clock = (): OfficeClock => ({ wallMs: Date.now(), monoMs: performance.now() });
const timestamp = (value: string) => value.replace("T", " ").replace(".000Z", " UTC").replace("Z", " UTC");
const textEvent = (event: PlaybackEvent) => "deleted" in event ? "Withdrawn event" : eventLabel(event);
const ROLES: Actor[] = ["boss", "dev1", "dev2", "dev3", "dev4", "qa", "scraper", "docs", "router", "extra"];

export function ConnectedOffice() {
  const controller = useRef<OfficePlayback | null>(null);
  const room = useRef<OfficeRoom | null>(null);
  const [view, setView] = useState<PlaybackView | null>(null);
  const [selected, setSelected] = useState<Actor | null>("boss");
  const [selectedExecution, setSelectedExecution] = useState<string | null>(null);
  const [taskOnly, setTaskOnly] = useState(false);
  const [annex, setAnnex] = useState(false);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(true);
  const [override, setOverride] = useState(false);
  const [visible, setVisible] = useState(false);
  const [inView, setInView] = useState(false);
  const [canvasReady, setCanvasReady] = useState(true);
  const [revision, setRevision] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null), annexCanvas = useRef<HTMLCanvasElement>(null), stage = useRef<HTMLDivElement>(null);
  const publish = () => {
    const c = controller.current, r = room.current; if (!c || !r) return;
    const next = c.view(clock()); r.reconcile(next); setView(next); setRevision(n => n + 1);
  };
  useEffect(() => {
    const c = new OfficePlayback(), r = new OfficeRoom(); controller.current = c; room.current = r;
    const abort = new AbortController(); let stateBusy = false, eventBusy = false;
    const send = async (mode: "bootstrap" | "state" | "incremental") => {
      const lane = mode === "state" ? "state" : "events";
      if (lane === "state" ? stateBusy : eventBusy) return;
      const request = c.request(mode, clock()); if (!request) return;
      if (lane === "state") stateBusy = true; else eventBusy = true;
      const requestAbort = new AbortController();
      const cancel = () => requestAbort.abort(); abort.signal.addEventListener("abort", cancel, { once: true });
      const timeout = setTimeout(cancel, 10000);
      const query = new URLSearchParams({ mode });
      if (mode === "state" && request.epoch !== null) query.set("privacy_epoch", request.epoch);
      if (mode === "incremental" && request.cursor) { query.set("cursor", request.cursor); query.set("limit", "50"); if (request.rebind) query.set("rebind", "true"); }
      try {
        const response = await fetch(`/api/public/office?${query}`, { cache: "no-store", signal: requestAbort.signal });
        if (!response.ok) throw new Error("unavailable");
        c.receive(request, await response.json(), clock());
        const state = c.view(clock());
        if (state.mode === "live" && !state.active && state.pending.length === 0 && state.replay.events.length > 0 && !state.gap) c.setMode("replay");
      } catch { if (!abort.signal.aborted) c.fail(request); }
      finally { clearTimeout(timeout); abort.signal.removeEventListener("abort", cancel); if (lane === "state") stateBusy = false; else eventBusy = false; if (!abort.signal.aborted) publish(); }
    };
    // Both network lanes poll every OFFICE_PLAYBACK.pollMs while the document is visible and stop while
    // it is hidden. Becoming visible fetches state and events once, then resumes the intervals.
    const pollEvents = () => { void send(c.view(clock()).history === "partial" ? "bootstrap" : "incremental"); };
    let stateTimer: ReturnType<typeof setInterval> | undefined, eventTimer: ReturnType<typeof setInterval> | undefined;
    const stopPolling = () => { clearInterval(stateTimer); clearInterval(eventTimer); stateTimer = eventTimer = undefined; };
    const startPolling = () => {
      stopPolling();
      stateTimer = setInterval(() => { void send("state"); }, OFFICE_PLAYBACK.pollMs);
      eventTimer = setInterval(pollEvents, OFFICE_PLAYBACK.pollMs);
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") { stopPolling(); return; }
      if (stateTimer !== undefined) return;
      if (c.view(clock()).history === "initialized") void send("state");
      pollEvents(); startPolling();
    };
    if (document.visibilityState === "visible") { pollEvents(); startPolling(); }
    document.addEventListener("visibilitychange", onVisibility);
    const ageTimer = setInterval(publish, 1000);
    return () => { abort.abort(); stopPolling(); clearInterval(ageTimer); document.removeEventListener("visibilitychange", onVisibility); controller.current = null; room.current = null; };
  }, []);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const motion = () => setReduced(media.matches), visibility = () => setVisible(document.visibilityState === "visible");
    motion(); visibility(); media.addEventListener("change", motion); document.addEventListener("visibilitychange", visibility);
    const observer = new IntersectionObserver(([entry]) => setInView(!!entry?.isIntersecting));
    if (stage.current) observer.observe(stage.current);
    return () => { media.removeEventListener("change", motion); document.removeEventListener("visibilitychange", visibility); observer.disconnect(); };
  }, []);
  const playing = !paused && (!reduced || override) && visible && inView;
  useEffect(() => {
    if (!playing) return;
    let frame = 0, previous: number | null = null;
    const animate = (now: number) => {
      const c = controller.current, r = room.current;
      if (c && r && previous !== null) {
        let v = c.view(clock());
        if (!v.active) { if (v.mode === "replay" && v.replay.index >= v.replay.events.length) c.rewindReplay(); c.begin(); v = c.view(clock()); }
        r.reconcile(v);
        if (!v.paused && v.active && r.tick(now - previous) && c.finish(v.active.ref)) r.complete();
        publish();
      }
      previous = now; frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate); return () => cancelAnimationFrame(frame);
  }, [playing]);
  useEffect(() => {
    if (!visible || !inView || !view || !room.current) return;
    const ctx = canvas.current?.getContext("2d"); if (!ctx) { setCanvasReady(false); return; }
    const model = room.current.render(view);
    drawOffice(ctx, room.current.scene, selected, false, model);
    const extra = annexCanvas.current?.getContext("2d"); if (extra) drawOffice(extra, room.current.scene, selected, true, model);
  }, [view, selected, annex, revision, visible, inView]);
  const select = (actor: Actor | null) => { setSelected(actor); setSelectedExecution(null); setTaskOnly(false); };
  const play = () => { setOverride(true); setPaused(false); controller.current?.setPaused(false); publish(); };
  const pause = () => { setPaused(true); controller.current?.setPaused(true); publish(); };
  const next = () => {
    const c = controller.current, r = room.current; if (!c || !r) return;
    c.setPaused(false); let v = c.view(clock());
    if (!v.active) { if (v.mode === "replay" && v.replay.index >= v.replay.events.length) c.rewindReplay(); c.begin(); v = c.view(clock()); }
    r.reconcile(v); if (v.active) { r.settle(); r.complete(); c.finish(v.active.ref); }
    c.setPaused(true); setPaused(true); publish();
  };
  const executions = view?.current?.snapshot.executions ?? [];
  const selectedRuns = executions.filter(e => executionActor(e) === selected);
  const execution = selectedExecution === null ? selectedRuns[0] : selectedRuns.find(e => e.ref === selectedExecution);
  const task = view?.current?.snapshot.tasks?.find(t => t.ref === execution?.task_ref);
  const relation = view?.current?.snapshot.related_tasks?.find(r => r.task_ref === task?.ref);
  const log = view?.mode === "replay" ? view.replay.events.slice(0, view.replay.index + Number(view.active !== null)) : [...(view?.log ?? []), ...(view?.active ? [view.active] : [])];
  const events = log.filter(e => !taskOnly || !("deleted" in e) && e.task_ref === task?.ref);
  const active = view?.active;
  const dataState = !view ? "Connecting" : view.freshness === "fresh" ? "Current" : view.freshness === "unavailable" ? "Unavailable · last known state" : view.freshness === "stale" ? "Stale · last known state" : "Freshness unknown";
  return <section className={s.draft} aria-label="Connected agent office">
    <div className={s.toolbar}><div className={s.controls}>
      <button type="button" onClick={play}>Play</button><button type="button" onClick={pause} disabled={paused}>Pause</button><button type="button" onClick={next}>Next event</button>
      <button type="button" aria-pressed={view?.mode === "replay"} onClick={() => { controller.current?.setMode(view?.mode === "replay" ? "live" : "replay"); publish(); }} disabled={!!active || !!view?.pending.length || !view?.replay.events.length}>{view?.mode === "replay" ? "Return to live" : "Replay latest events"}</button>
    </div><p>{reduced && !override ? "Still view · Play enables motion" : paused ? "Playback paused" : playing ? "Playing recorded transitions" : "Playback suspended"}</p></div>
    <p className={s.connection} role="status">{view?.mode === "replay" ? "Replay" : "Live"} · {dataState} · {view?.pending.length ?? 0} transitions waiting</p>
    {view?.gap && <div className={s.recovery}><p>History needs reconciliation. {view.gap.recovery === "rebind" ? "Descriptions have been updated. Received transitions remain in order." : "Some history is unavailable. Received transitions are retained until you restart."}</p><button type="button" onClick={() => { controller.current?.restart(); room.current?.reset(); setSelectedExecution(null); publish(); }}>Restart and reconcile to current</button></div>}
    <div className={s.studio}><div>
      <div ref={stage} className={s.room}>
        <canvas ref={canvas} width={384} height={304} className={s.canvas} aria-label="Woodland team room. Select a role below to inspect." role="img" />
        {ROLES.filter(a => a !== "extra").map(actor => <button type="button" key={actor} className={s.target} style={{ left: `${(room.current?.scene.positions[actor].x ?? PEOPLE[actor].home.x) / 384 * 100}%`, top: `${((room.current?.scene.positions[actor].y ?? PEOPLE[actor].home.y) - 12) / 304 * 100}%` }} aria-label={`Inspect ${PEOPLE[actor].name}`} onClick={() => select(actor)} />)}
      </div>
      {!canvasReady && <p>Room drawing is unavailable. All recorded activity is available in the inspector and event log.</p>}
      <div className={s.roomNotes}><span>Fixed core team · expandable worker seats</span><button type="button" onClick={() => setAnnex(!annex)} aria-expanded={annex}>{annex ? "Hide annex" : "Show annex"}</button></div>
      {annex && <div className={s.annexRoom}><canvas ref={annexCanvas} width={384} height={96} className={s.canvas} role="img" aria-label="Expandable Developer annex" /></div>}
      <div className={s.people} aria-label="Inspect a role">{ROLES.map(actor => <button type="button" key={actor} aria-pressed={selected === actor} onClick={() => select(actor)}><span className={s.swatch} style={{ backgroundColor: PEOPLE[actor].color }} />{PEOPLE[actor].name}</button>)}<button type="button" aria-pressed={selected === null} onClick={() => select(null)}>Unassigned executions</button></div>
      <p className={s.small}>Robots mark team stations. A recorded transition is an illustration; current execution evidence is shown separately. Routing and deployment remain unknown unless reported.</p>
    </div><aside className={s.inspector} aria-label="Agent details"><h2>{selected ? PEOPLE[selected].name : "Unassigned executions"}</h2>
      <p className={s.small}>{selected === "router" ? view?.current?.capabilities.routing_events === true ? "Routing observations are available. Inspect the execution evidence below." : "Routing capability is not confirmed." : selected === "extra" ? "Every annex execution is listed here, including seats beyond the drawn room." : "Inspect the latest confirmed execution, separately from the transition being illustrated."}</p>
      <p>{selectedRuns.length ? `${selectedRuns.length} execution${selectedRuns.length === 1 ? "" : "s"} reported` : "No execution inventory for this station"}</p>
      {selectedRuns.map((e, i) => <button type="button" key={i} aria-pressed={execution?.ref === e.ref} onClick={() => { setSelectedExecution(e.ref); setTaskOnly(false); }}>{executionLabel(e)} · {e.observation ? timestamp(e.observation.observed_at) : "observation unknown"} · entry {i + 1}</button>)}
      <dl><div><dt>Current execution</dt><dd>{execution ? execution.phase === "unknown" ? "Unknown" : `${execution.phase === "running" ? "Last reported running" : execution.phase}${execution.outcome ? ` · ${execution.outcome}` : ""}` : "Unknown"}</dd></div><div><dt>Observation</dt><dd>{execution?.observation ? `${execution.observation.source.replaceAll("_", " ")} · ${timestamp(execution.observation.observed_at)}` : "No trusted observation"}</dd></div><div><dt>Task</dt><dd>{task?.description ?? "Task details unavailable"}</dd></div><div><dt>Task state</dt><dd>{task?.state?.replaceAll("_", " ") ?? "Unknown"}{task?.waiting_on ? ` · waiting on ${task.waiting_on}` : ""}{task?.paused === true ? " · task paused" : ""}</dd></div><div><dt>Related work</dt><dd>{relation?.description ?? "No related work in this snapshot"}</dd></div><div><dt>System pause</dt><dd>{view?.current?.snapshot.pause.paused === null || view?.current?.snapshot.pause.paused === undefined ? "Unknown" : view.current.snapshot.pause.paused ? "Agents paused" : "Agents not paused"}</dd></div><div><dt>Latest snapshot</dt><dd>{view?.current ? `${timestamp(view.current.observedAt)} · ${dataState}` : "Unavailable"}</dd></div></dl>
      <button type="button" onClick={() => setTaskOnly(true)} disabled={!task}>Show task events</button>
    </aside></div>
    <section className={s.now} aria-label="Illustrated transition"><h2>{active ? textEvent(active) : "Ready for the next transition"}</h2><p>{active && !("deleted" in active) ? `${active.description} · ${timestamp(active.recorded_at)}` : "No event is being illustrated."}</p><p className={s.small}>Illustration follows received events in sequence. The latest confirmed snapshot can be ahead of this scene. {view?.mode === "replay" && `${view.replay.completeness === "complete" ? "Complete retained replay window" : "Partial task history"} · original recorded timestamps.`}</p></section>
    <section className={s.logs} aria-label="Event log"><div className={s.logHeading}><h2>Recorded events</h2><div className={s.filters}><button type="button" aria-pressed={!taskOnly} onClick={() => setTaskOnly(false)}>All events</button><button type="button" aria-pressed={taskOnly} onClick={() => setTaskOnly(true)} disabled={!task}>Selected task</button></div></div>
      {events.length === 0 ? <p>{taskOnly ? "No received events for this task in this window." : "No illustrated events yet. The room stays neutral until recorded activity arrives."}</p> : <ol className={s.eventList}>{events.map((event, i) => <li key={i}>{"deleted" in event ? <p>Withdrawn event · history position retained</p> : <><time dateTime={event.recorded_at}>{timestamp(event.recorded_at)}</time><div><span>{eventLabel(event)} · {ROLE_LABEL[event.role]}</span><p>{event.description}</p></div></>}</li>)}</ol>}
    </section>
  </section>;
}
