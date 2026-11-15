"use client";
// <Xray id="activity-feed">...</Xray>: marks a component for the X-ray overlay. Off, the wrapper is a
// `display: contents` div: no box, no tab stop, no role, and the same element in both states so the children
// never remount. On, it draws an outline and a chip (label and tech); hover, focus or a tap on the chip shows a
// card (what and why). Escape or a tap elsewhere closes it. The card is not focusable, so nothing traps focus.
import { XRAY, type XrayId } from "@kcw/xray";
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getXray, getXrayServer, subscribeXray } from "./xray-state";
import x from "./xray.module.css";

const MARGIN = 8;
const GAP = 6;

export function Xray({ id, align = "start", side = "above", children }: { id: XrayId; align?: "start" | "end"; side?: "above" | "below"; children: ReactNode }) {
  const on = useSyncExternalStore(subscribeXray, getXray, getXrayServer);
  const entry = XRAY[id];
  const cardId = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const shown = on && open;

  // Place the card under the chip (above if there is no room), kept inside the viewport.
  useLayoutEffect(() => {
    if (!shown) return;
    const place = () => {
      const c = chip.current;
      const el = card.current;
      if (!c || !el) return;
      const r = c.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const w = el.offsetWidth;
      const hgt = el.offsetHeight;
      const left = Math.max(MARGIN, Math.min(r.left, vw - w - MARGIN));
      let top = r.bottom + GAP;
      if (top + hgt > vh - MARGIN) top = r.top - hgt - GAP;
      top = Math.max(MARGIN, top);
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [shown]);

  useEffect(() => {
    if (!shown) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [shown]);

  // Inside the page frame (not the sticky header, whose blur would trap a fixed card); body as a fallback.
  const host = shown ? (wrapper.current?.closest("header, main")?.parentElement ?? document.body) : null;

  return (
    <div ref={wrapper} className={on ? x.on : x.off} data-xray={on ? id : undefined}>
      {on && (
        <button
          ref={chip}
          type="button"
          className={[x.chip, align === "end" ? x.end : "", side === "below" ? x.below : ""].filter(Boolean).join(" ")}
          aria-expanded={shown}
          aria-describedby={shown ? cardId : undefined}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => {
            if (document.activeElement !== chip.current) setOpen(false);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onClick={() => setOpen(true)}
        >
          <span className={x.chipLabel}>{entry.label}</span>
          <span className={x.chipTech}>{entry.tech}</span>
        </button>
      )}
      {children}
      {host &&
        createPortal(
          <div ref={card} id={cardId} role="tooltip" className={x.card}>
            <p className={x.cardTitle}>
              {entry.label} <span className={x.cardTech}>{entry.tech}</span>
            </p>
            <p className={x.cardText}>
              <strong>What it does.</strong> {entry.what}
            </p>
            <p className={x.cardText}>
              <strong>Why it was chosen.</strong> {entry.why}
            </p>
          </div>,
          host,
        )}
    </div>
  );
}
