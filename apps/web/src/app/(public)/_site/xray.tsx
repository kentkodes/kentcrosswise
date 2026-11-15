"use client";
// <Xray id="activity-feed">...</Xray>: marks a component for the X-ray overlay. Off, the wrapper is a
// `display: contents` div: no box, no tab stop, no role, and the same element in both states so the children
// never remount. On, it draws an outline and reserves a label row at its top (in normal flow, so a chip never
// covers anything) holding the chip (label and tech). Hover, focus or a tap on the chip shows a card (what and
// why); Escape or a tap elsewhere closes it. The card is not focusable, so nothing traps focus.
// <XrayChip id> is the same chip on its own, for site-wide entries shown in the strip under the header.
import { XRAY, type XrayId } from "@kcw/xray";
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getXray, getXrayServer, subscribeXray } from "./xray-state";
import x from "./xray.module.css";

const MARGIN = 8;
const GAP = 6;

export function XrayChip({ id }: { id: XrayId }) {
  const entry = XRAY[id];
  const cardId = useId();
  const chip = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  // Place the card under the chip (above if there is no room), kept inside the viewport.
  useLayoutEffect(() => {
    if (!open) return;
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
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (!chip.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  // Inside the page frame (not the sticky header, whose blur would trap a fixed card); body as a fallback.
  const host = open ? (chip.current?.closest("header, main, [data-xray-strip]")?.parentElement ?? document.body) : null;

  return (
    <>
      <button
        ref={chip}
        type="button"
        className={x.chip}
        data-xray-chip={id}
        aria-describedby={open ? cardId : undefined}
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
    </>
  );
}

export function Xray({ id, children }: { id: XrayId; children: ReactNode }) {
  const on = useSyncExternalStore(subscribeXray, getXray, getXrayServer);
  return (
    <div className={on ? x.on : x.off} data-xray={on ? id : undefined}>
      {on && <XrayChip id={id} />}
      {children}
    </div>
  );
}

/** In-flow strip under the sticky header with the chips of site-wide entries. Nothing is rendered when X-ray is off. */
export function XrayStrip({ ids }: { ids: readonly XrayId[] }) {
  const on = useSyncExternalStore(subscribeXray, getXray, getXrayServer);
  if (!on) return null;
  return (
    <div className={x.strip} data-xray-strip>
      {ids.map((id) => (
        <XrayChip key={id} id={id} />
      ))}
    </div>
  );
}
