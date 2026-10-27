"use client";
import { useEffect, useRef, useState } from "react";
import type { ActivityEvent } from "../_site/activity";
import { advanceVignette, beginVignette, motionRole } from "./live-scene";
import { drawOffice } from "./preview/draw-office";
import { HEIGHT, WIDTH } from "./preview/scene";
import type { Role } from "./preview/scene";
import s from "./preview/preview.module.css";

export function LiveOfficeScene({ event, cycle, playing, onComplete, onViewChange }: {
  event?: ActivityEvent; cycle: number; playing: boolean;
  onComplete: () => void; onViewChange: (visible: boolean) => void;
}) {
  const token = `${cycle}:${event?.id ?? "empty"}:${event?.agent ?? ""}:${event?.type ?? ""}`;
  const [state, setState] = useState(() => ({ token, motion: beginVignette(event) }));
  const [selected, setSelected] = useState<Role>("developer");
  const [roomWidth, setRoomWidth] = useState(320);
  const [canvasReady, setCanvasReady] = useState(true);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const room = useRef<HTMLDivElement>(null);
  const completed = useRef<string | undefined>(undefined);
  const { motion } = state;
  const pose = motion.pose;

  useEffect(() => {
    setState(previous => previous.token === token ? previous : { token, motion: beginVignette(event, previous.motion.pose) });
  }, [token, event]);
  useEffect(() => {
    const element = stage.current;
    const observer = new IntersectionObserver(([entry]) => onViewChange(!!entry?.isIntersecting));
    const resize = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const available = entry.contentRect.width;
      setRoomWidth(available < WIDTH ? available : Math.min(640, Math.floor(available / WIDTH) * WIDTH));
    });
    if (room.current) observer.observe(room.current);
    if (element) resize.observe(element);
    return () => { observer.disconnect(); resize.disconnect(); };
  }, [onViewChange]);
  useEffect(() => {
    if (!playing || state.token !== token || motion.done) return;
    let previous: number | undefined;
    let frame: number;
    const advance = (timestamp: number) => {
      if (previous !== undefined) {
        const delta = timestamp - previous;
        setState(current => ({ ...current, motion: advanceVignette(current.motion, delta) }));
      }
      previous = timestamp;
      frame = requestAnimationFrame(advance);
    };
    frame = requestAnimationFrame(advance);
    return () => cancelAnimationFrame(frame);
  }, [playing, state.token, token, motion.done]);
  useEffect(() => {
    if (!playing || !event || state.token !== token || !motion.done || completed.current === token) return;
    completed.current = token;
    onComplete();
  }, [playing, event, state.token, token, motion.done, onComplete]);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) { setCanvasReady(false); return; }
    drawOffice(ctx, pose, motion.phase === "return" ? "idle" : motion.kind ?? "idle", Math.floor(motion.elapsed / 180), selected);
  }, [pose, motion.kind, motion.phase, motion.elapsed, selected]);

  const actor = motionRole(motion.kind);
  const status = motion.phase === "return" ? "Returning to workstations" : actor === selected ? `Illustrating ${event?.type.replaceAll("_", " ")}` : "At their workstation";
  const papers = pose.carrying ? `Carried by ${pose.carrying === "qa" ? "QA" : "Developer"}` : pose.filed ? "Filed after this merge event" : pose.paper === "none" ? "Not shown" : pose.paper === "inbox" ? "In the owner inbox" : pose.paper === "cabinet" ? "At the cabinet" : `At ${pose.paper === "qa" ? "QA’s" : "Developer’s"} desk`;
  return <div className={s.studio}>
    <div ref={stage} className={s.stage}>
      <div ref={room} className={s.room} style={{ width: roomWidth }} data-testid="live-office-room" data-cycle={cycle} data-event={event?.type ?? "idle"} data-phase={motion.phase} data-elapsed={motion.elapsed} data-playing={playing} data-filed={pose.filed}>
        <canvas ref={canvas} width={WIDTH} height={HEIGHT} aria-hidden="true" className={s.canvas} />
        {(["developer", "qa"] as const).map(role => <button key={role} className={s.robotTarget} type="button" aria-label={`${role === "qa" ? "QA" : "Developer"} robot`} aria-pressed={selected === role} style={{ left: `${pose[role].x / WIDTH * 100}%`, top: `${(pose[role].y - 12) / HEIGHT * 100}%` }} onClick={() => setSelected(role)} />)}
        <button className={s.deskTarget} style={{ left: "16%" }} type="button" aria-label="Inspect Developer workstation" onClick={() => setSelected("developer")} />
        <button className={s.deskTarget} style={{ left: "84%" }} type="button" aria-label="Inspect QA workstation" onClick={() => setSelected("qa")} />
      </div>
      {!canvasReady ? <p role="status">The pixel scene could not load. Recorded activity and inspection remain available.</p> : null}
      <div className={s.legend} aria-label="Inspect a coworker">
        <button type="button" aria-pressed={selected === "developer"} onClick={() => setSelected("developer")}><span className={s.teal} />Developer</button>
        <button type="button" aria-pressed={selected === "qa"} onClick={() => setSelected("qa")}><span className={s.amber} />QA</button>
      </div>
    </div>
    <aside className={s.inspector} aria-label="Robot inspection">
      <h3>{selected === "developer" ? "Developer" : "QA"}</h3>
      <p className={s.role}>{selected === "developer" ? "Teal robot · builds and revises" : "Amber robot · reviews and files"}</p>
      <p>{event ? status : "No recorded activity selected"}</p>
      <p>{event && !actor ? "This event has no robot animation yet; its recorded details remain below." : "A role-based illustration of the selected event, not a live view of agent positions."}</p>
      <dl><div><dt>Papers in this illustration</dt><dd>{papers}</dd></div></dl>
    </aside>
  </div>;
}
