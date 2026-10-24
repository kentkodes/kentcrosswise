"use client";
// Day/night scene state for the home page. The control is a real two-option toggle; the scene
// answers with a bounded veil cross-fade (none under prefers-reduced-motion, see home.module.css).
// The ambient lights pause while the scene is offscreen.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Moon, Sun } from "./icons";
import s from "./home.module.css";

type Time = "day" | "night";

const TimeContext = createContext<{ time: Time; setTime: (t: Time) => void }>({
  time: "day",
  setTime: () => {},
});

export function SceneFrame({ children }: { children: ReactNode }) {
  const [time, setTime] = useState<Time>("day");
  const [active, setActive] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setActive(entry?.isIntersecting ?? true));
    io.observe(el.querySelector("[data-scenery]") ?? el);
    return () => io.disconnect();
  }, []);
  return (
    <TimeContext.Provider value={{ time, setTime }}>
      <div ref={ref} className={s.frame} data-time={time} data-active={active}>
        {children}
      </div>
    </TimeContext.Provider>
  );
}

export function DayNightToggle({ className }: { className?: string }) {
  const { time, setTime } = useContext(TimeContext);
  return (
    <div
      id="scene-light"
      className={`${s.toggle} ${className ?? ""}`}
      role="group"
      aria-label="Scene light"
      data-time={time}
    >
      <button
        type="button"
        className={s.toggleDay}
        aria-pressed={time === "day"}
        onClick={() => setTime("day")}
      >
        <Sun className={s.toggleIcon} />
        <span className={s.srOnly}>Day</span>
      </button>
      <button
        type="button"
        className={s.toggleNight}
        aria-pressed={time === "night"}
        onClick={() => setTime("night")}
      >
        <Moon className={s.toggleIcon} />
        <span className={s.srOnly}>Night</span>
      </button>
    </div>
  );
}
