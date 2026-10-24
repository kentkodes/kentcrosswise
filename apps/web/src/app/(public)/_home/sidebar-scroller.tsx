"use client";
// The hub sidebar becomes a sideways-scrolling row on narrow screens. This wrapper marks which
// edges have more links beyond them (the CSS fades those edges) and keeps a focused link fully in
// view. On the wide stage the row never overflows, so no fade is drawn.
import { useEffect, useRef, type FocusEvent, type ReactNode } from "react";
import s from "./home.module.css";

export function SidebarScroller({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      el.dataset.fadeStart = String(max > 1 && el.scrollLeft > 1);
      el.dataset.fadeEnd = String(max > 1 && el.scrollLeft < max - 1);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, []);

  const onFocus = (e: FocusEvent<HTMLElement>) => {
    if (e.target instanceof HTMLElement && e.target !== e.currentTarget) {
      e.target.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  };

  return (
    <nav ref={ref} className={s.sidebar} aria-label="Hub preview" onFocus={onFocus}>
      {children}
    </nav>
  );
}
