"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { OFFICE_PLAYBACK, OfficePlayback, type OfficeClock, type PlaybackEvent, type PlaybackView } from "../../../../office-playback";
import { OfficeRoom, executionActor, executionLabel, eventLabel, ROLE_LABEL } from "../../../../office-room";
import { drawOffice } from "../draft/draw-office";
import { PEOPLE, type Actor } from "../draft/scene";
import { ACTIVITY_FILTERS, CARD_INFO, STATUS_WORD, deriveBoard, loadingBoard, utcLabel, viewKey, type ActivityFilter, type BoardRole } from "../board/board-state";
import s from "./connected.module.css";
const clock = (): OfficeClock => ({ wallMs: Date.now(), monoMs: performance.now() });
const timestamp = (value: string) => value.replace("T", " ").replace(".000Z", " UTC").replace("Z", " UTC");
const textEvent = (event: PlaybackEvent) => "deleted" in event ? "Withdrawn event" : eventLabel(event);
const ROLES: Actor[] = ["boss", "dev1", "dev2", "dev3", "dev4", "qa", "scraper", "docs", "router", "extra"];
const SEAT_ACTORS = ["dev1", "dev2", "dev3", "dev4"] as const;
/** Role filters for the event log: the Board's activity filters, without "All". */
const ROLE_FILTERS = ACTIVITY_FILTERS.filter(option => option.value !== "all");
/** "all" clears both the role and the task filter; "task" is the selected station's task. */
type LogFilter = ActivityFilter | "task";
/** The card a station reads its model and description from. Router and unassigned executions have none. */
const CARD_OF: Partial<Record<Actor, BoardRole>> = { boss: "orchestrator", dev1: "developer", dev2: "developer", dev3: "developer", dev4: "developer", extra: "developer", qa: "qa", docs: "docs", scraper: "scraper" };
/** The replay has played its last event and nothing is active. No state of its own: derived from the view. */
const atReplayEnd = (v: PlaybackView) => v.mode === "replay" && !v.active && v.replay.events.length > 0 && v.replay.index >= v.replay.events.length;

function Dot({ color, ring = false }: { color: string; ring?: boolean }) {
  return <span className={ring ? `${s.dot} ${s.dotRing}` : s.dot} style={{ backgroundColor: color }} aria-hidden="true" />;
}

function TeamRow({ actor, name, status, selected, onSelect }: { actor: Actor; name: string; status: string; selected: boolean; onSelect: (actor: Actor) => void }) {
  return (
    <button type="button" className={s.row} aria-pressed={selected} onClick={() => onSelect(actor)}>
      <span className={s.rowName}><Dot color={PEOPLE[actor].color} ring={actor === "router"} />{name}</span>
      <span className={s.rowStatus}>{status}</span>
    </button>
  );
}

export function ConnectedOffice() {
  const controller = useRef<OfficePlayback | null>(null);
  const room = useRef<OfficeRoom | null>(null);
  const [view, setView] = useState<PlaybackView | null>(null);
  const [selected, setSelected] = useState<Actor | null>("boss");
  const [selectedExecution, setSelectedExecution] = useState<string | null>(null);
  const [filter, setFilter] = useState<LogFilter>("all");
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
  const replayDone = !!view && atReplayEnd(view);
  useEffect(() => {
    if (!playing) return;
    let frame = 0, previous: number | null = null;
    const animate = (now: number) => {
      const c = controller.current, r = room.current;
      if (c && r && previous !== null) {
        let v = c.view(clock());
        // Replay plays once: at its end the loop does nothing. Play rewinds it; a live event still plays.
        if (!v.active && atReplayEnd(v)) { /* replay finished */ }
        else {
          if (!v.active) { c.begin(); v = c.view(clock()); }
          r.reconcile(v);
          if (!v.paused && v.active && r.tick(now - previous) && c.finish(v.active.ref)) r.complete();
        }
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
    const extra = annex ? annexCanvas.current?.getContext("2d") : null; if (extra) drawOffice(extra, room.current.scene, selected, true, model);
  }, [view, selected, annex, revision, visible, inView]);
  // Selecting a station leaves the role filter alone; it ends a "Selected task" filter, which belongs to the old station.
  const select = (actor: Actor | null) => { setSelected(actor); setSelectedExecution(null); setFilter(current => current === "task" ? "all" : current); };
  const play = () => {
    const c = controller.current; if (!c) return;
    if (atReplayEnd(c.view(clock()))) c.rewindReplay();
    setOverride(true); setPaused(false); c.setPaused(false); publish();
  };
  const pause = () => { setPaused(true); controller.current?.setPaused(true); publish(); };
  const next = () => {
    const c = controller.current, r = room.current; if (!c || !r) return;
    c.setPaused(false); let v = c.view(clock());
    if (!v.active) { if (v.mode === "replay" && v.replay.index >= v.replay.events.length) c.rewindReplay(); c.begin(); v = c.view(clock()); }
    r.reconcile(v); if (v.active) { r.settle(); r.complete(); c.finish(v.active.ref); }
    c.setPaused(true); setPaused(true); publish();
  };
  const executions = view?.current?.snapshot.executions ?? [];
  // deriveBoard runs per key, not per frame. The active flag belongs to the key: the replay label depends on it.
  const boardKey = view ? `${viewKey(view)}|${view.active ? "active" : ""}` : "";
  // The key covers every field deriveBoard reads, so the memo follows the view without re-deriving every frame.
  const board = useMemo(() => (view ? deriveBoard(view) : loadingBoard()), [boardKey]);
  const selectedRuns = executions.filter(e => executionActor(e) === selected);
  const execution = selectedExecution === null ? selectedRuns[0] : selectedRuns.find(e => e.ref === selectedExecution);
  const task = view?.current?.snapshot.tasks?.find(t => t.ref === execution?.task_ref);
  const relation = view?.current?.snapshot.related_tasks?.find(r => r.task_ref === task?.ref);
  const log = view?.mode === "replay" ? view.replay.events.slice(0, view.replay.index + Number(view.active !== null)) : [...(view?.log ?? []), ...(view?.active ? [view.active] : [])];
  const events = log.filter(e => {
    if (filter === "all") return true;
    if (filter === "task") return !("deleted" in e) && e.task_ref === task?.ref;
    return !("deleted" in e) && e.role === filter;
  });
  const active = view?.active;
  const dataState = !view ? "Connecting" : view.freshness === "fresh" ? "Current" : view.freshness === "unavailable" ? "Unavailable · last known state" : view.freshness === "stale" ? "Stale · last known state" : "Freshness unknown";
  const { roster } = board;
  const seatWorking = (seat: 1 | 2 | 3 | 4) => roster.developer.seats.find(x => x.seat === seat)?.status === "working";
  // Counts are shown only when the inventory is known; otherwise they read Unknown and a dash.
  const countsKnown = view?.current != null && view.current.snapshot.executions !== null && roster.developer.status !== "unknown";
  const devWorking = roster.developer.seats.filter(x => x.status === "working").length;
  const unassigned = executions.filter(e => executionActor(e) === null).length;
  const routing = view?.current?.capabilities.routing_events === true ? "Connected" : "Planned";
  const card = selected ? CARD_OF[selected] : undefined;
  const info = card ? CARD_INFO[card] : null;
  const note = selected === null ? "Executions that are not tied to a station."
    : selected === "router" ? (view?.current?.capabilities.routing_events === true ? "Routing observations are available." : "Routing is not connected yet.")
    : selected === "extra" ? "Lists every annex execution, including seats beyond the drawn room."
    : selected.startsWith("dev") ? "One of four Developer seats. It shows the task assigned to it."
    : info?.what ?? "";
  return <section className={s.draft} aria-label="Connected agent office">
    <div className={s.toolbar}>
      <div className={s.playback}>
        <div className={s.controls} role="group" aria-label="Playback">
          <button type="button" onClick={play}>Play</button><button type="button" onClick={pause} disabled={paused}>Pause</button><button type="button" onClick={next}>Next event</button>
          <button type="button" onClick={() => { controller.current?.setMode(view?.mode === "replay" ? "live" : "replay"); publish(); }} disabled={!!active || !!view?.pending.length || !view?.replay.events.length}>{view?.mode === "replay" ? "Return to live" : "Replay latest events"}</button>
        </div>
        <p className={s.stateText}>{replayDone ? "Replay finished · Play to watch again" : reduced && !override ? "Still view · Play enables motion" : paused ? "Playback paused" : playing ? "Playing recorded transitions" : "Playback suspended"}</p>
      </div>
      <ul className={s.pills} role="status">
        <li className={s.pill}>{view?.mode === "replay" ? "Replay" : "Live"}</li>
        <li className={s.pill}><span className={s.pillDot} data-tone={dataState === "Current" ? "ok" : "warn"} aria-hidden="true" />{dataState}</li>
        <li className={s.pill}><b>{view?.pending.length ?? 0}</b> transitions waiting</li>
      </ul>
    </div>
    {view?.gap && <div className={s.notice}><p>History needs reconciliation. {view.gap.recovery === "rebind" ? "Descriptions have been updated. Received transitions remain in order." : "Some history is unavailable. Received transitions are retained until you restart."}</p><button type="button" className={s.secondary} onClick={() => { controller.current?.restart(); room.current?.reset(); setSelectedExecution(null); publish(); }}>Restart and reconcile to current</button></div>}
    <div className={s.layout}>
      <div className={s.roomCard}>
        <div className={s.stageBox}>
          <div ref={stage} className={s.room}>
            <canvas ref={canvas} width={384} height={304} className={s.canvas} aria-label="Woodland team room. Select a robot or an agent to inspect." role="img" />
            {ROLES.filter(a => a !== "extra").map(actor => <button type="button" key={actor} className={s.target} style={{ left: `${(room.current?.scene.positions[actor].x ?? PEOPLE[actor].home.x) / 384 * 100}%`, top: `${((room.current?.scene.positions[actor].y ?? PEOPLE[actor].home.y) - 12) / 304 * 100}%` }} aria-label={`Inspect ${PEOPLE[actor].name}`} onClick={() => select(actor)} />)}
          </div>
        </div>
        {!canvasReady && <p className={s.muted}>Room drawing is unavailable. All recorded activity is available in the inspector and event log.</p>}
        <div className={s.roomFoot}>
          <p className={s.muted}>Click a robot, or pick an agent in the list.</p>
          <button type="button" className={s.secondary} onClick={() => setAnnex(!annex)} aria-expanded={annex} aria-controls="office-room-annex">{annex ? "Hide annex" : "Show annex"}</button>
        </div>
        <div id="office-room-annex" hidden={!annex} className={s.stageBox}><div className={s.annexRoom}><canvas ref={annexCanvas} width={384} height={96} className={s.canvas} role="img" aria-label="Expandable Developer annex" /></div></div>
      </div>
      <div className={s.side}>
        <section className={s.team} aria-labelledby="room-team-title">
          <div className={s.teamHead}><h2 id="room-team-title">Team</h2><span className={s.label}>6 stations</span></div>
          <TeamRow actor="boss" name={PEOPLE.boss.name} status={STATUS_WORD[roster.orchestrator.status]} selected={selected === "boss"} onSelect={select} />
          <div className={s.devGroup}>
            <div className={s.devHead}><span className={s.rowName}><Dot color={PEOPLE.dev1.color} />Developer</span><span className={s.rowStatus}>{countsKnown ? `${devWorking} of 4 seats working` : "Unknown"}</span></div>
            <div className={s.seats}>
              {SEAT_ACTORS.map((actor, i) => <button type="button" key={actor} className={s.seat} aria-label={`Developer seat ${i + 1}`} aria-pressed={selected === actor} onClick={() => select(actor)}>{seatWorking(i + 1 as 1 | 2 | 3 | 4) && <span className={s.okDot} aria-hidden="true" />}{i + 1}</button>)}
              <button type="button" className={s.seat} aria-label="Developer annex" aria-pressed={selected === "extra"} onClick={() => select("extra")}>Annex</button>
            </div>
          </div>
          <TeamRow actor="qa" name={PEOPLE.qa.name} status={STATUS_WORD[roster.qa.status]} selected={selected === "qa"} onSelect={select} />
          <TeamRow actor="docs" name={PEOPLE.docs.name} status={STATUS_WORD[roster.docs.status]} selected={selected === "docs"} onSelect={select} />
          <TeamRow actor="scraper" name={PEOPLE.scraper.name} status={STATUS_WORD[roster.scraper.status]} selected={selected === "scraper"} onSelect={select} />
          <TeamRow actor="router" name={PEOPLE.router.name} status={routing} selected={selected === "router"} onSelect={select} />
          <div className={s.divider}>
            <button type="button" className={s.row} aria-pressed={selected === null} onClick={() => select(null)}><span className={s.rowName}>Unassigned executions</span><span className={s.mono}>{countsKnown ? unassigned : "–"}</span></button>
          </div>
        </section>
        <aside className={s.inspector} aria-label="Agent details">
          <div className={s.inspectorHead}>
            <h2>{selected && <Dot color={PEOPLE[selected].color} ring={selected === "router"} />}{selected ? PEOPLE[selected].name : "Unassigned executions"}</h2>
            {info && <span className={s.model}>{info.model}</span>}
          </div>
          <p className={s.what}>{note}</p>
          <p className={s.count}>{selectedRuns.length ? `${selectedRuns.length} execution${selectedRuns.length === 1 ? "" : "s"} reported` : "No execution inventory for this station"}</p>
          {selectedRuns.length > 0 && <div className={s.runs}>{selectedRuns.map((e, i) => <button type="button" key={i} className={s.run} aria-pressed={execution?.ref === e.ref} onClick={() => { setSelectedExecution(e.ref); setFilter("all"); }}>{executionLabel(e)} · {e.observation ? utcLabel(e.observation.observed_at) : "observation unknown"} · entry {i + 1}</button>)}</div>}
          <dl className={s.facts}>
            <div><dt>Now</dt><dd>{execution ? execution.phase === "unknown" ? "Unknown" : `${execution.phase === "running" ? "Last reported running" : execution.phase}${execution.outcome ? ` · ${execution.outcome}` : ""}` : "Unknown"}</dd></div>
            <div><dt>Observation</dt><dd>{execution?.observation ? <>{`${execution.observation.source.replaceAll("_", " ")} · `}<span className={s.mono}>{utcLabel(execution.observation.observed_at)}</span></> : "No trusted observation"}</dd></div>
            <div><dt>Task</dt><dd>{task?.description ?? "Task details unavailable"}</dd></div>
            <div><dt>Task state</dt><dd>{task?.state?.replaceAll("_", " ") ?? "Unknown"}{task?.waiting_on ? ` · waiting on ${task.waiting_on}` : ""}{task?.paused === true ? " · task paused" : ""}</dd></div>
            <div><dt>Related</dt><dd>{relation?.description ?? "No related work in this snapshot"}</dd></div>
            <div><dt>System</dt><dd>{view?.current?.snapshot.pause.paused === null || view?.current?.snapshot.pause.paused === undefined ? "Unknown" : view.current.snapshot.pause.paused ? "Agents paused" : "Agents not paused"}</dd></div>
            <div><dt>Snapshot</dt><dd>{view?.current ? <><span className={s.mono}>{utcLabel(view.current.observedAt)}</span>{` · ${dataState}`}</> : "Unavailable"}</dd></div>
          </dl>
          <div className={s.inspectorFoot}>
            <button type="button" className={s.secondary} onClick={() => setFilter("task")} disabled={!task}>Show task events</button>
          </div>
        </aside>
      </div>
    </div>
    <section className={s.now} aria-label="Illustrated transition">
      <div className={s.nowRow}>
        <span className={s.label}>Now showing</span>
        <h2 className={s.nowTitle}>{active ? textEvent(active) : "Ready for the next transition"}</h2>
        <p className={s.nowMeta}>{active && !("deleted" in active) ? `${active.description} · ${timestamp(active.recorded_at)}` : "No event is being illustrated."}</p>
      </div>
      <p className={s.note}>The room plays received events in order, so the Board can be a step ahead of it.{view?.mode === "replay" && ` ${view.replay.completeness === "complete" ? "Complete retained replay window" : "Partial task history"} · original recorded times.`}</p>
    </section>
    <section className={s.logs} aria-label="Event log">
      <div className={s.logbar}>
        <h2 className={s.logTitle}>{view?.mode === "replay" ? "Recorded events · replay" : "Recorded events"}</h2>
        <div className={s.chips} role="group" aria-label="Filter events">
          <button type="button" className={s.chip} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All events</button>
          {ROLE_FILTERS.map(option => <button type="button" key={option.value} className={s.chip} aria-pressed={filter === option.value} onClick={() => setFilter(option.value)}>{option.label}</button>)}
          <button type="button" className={s.chip} aria-pressed={filter === "task"} onClick={() => setFilter("task")} disabled={!task}>Selected task</button>
        </div>
      </div>
      {events.length === 0 ? <p className={s.empty}>{filter === "task" ? "No received events for this task in this window." : filter === "all" ? "No illustrated events yet. The room stays neutral until recorded activity arrives." : "No received events for this role in this window."}</p> : <ol className={s.rows}>{events.map((event, i) => "deleted" in event
        ? <li key={i} className={`${s.logRow} ${s.withdrawn}`}><p>Withdrawn event · history position retained</p></li>
        : <li key={i} className={s.logRow}><div className={s.rowHead}><time dateTime={event.recorded_at} className={s.time}>{utcLabel(event.recorded_at)}</time><span className={s.who}><span className={s.rowDot} aria-hidden="true" />{ROLE_LABEL[event.role]}</span></div><span className={s.eventName}>{eventLabel(event)}</span><span className={s.task}>{event.description}</span></li>)}</ol>}
    </section>
  </section>;
}
