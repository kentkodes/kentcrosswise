"use client";
// The owner nav strip. It scrolls sideways inside itself; on load the strip is scrolled so the current item is
// visible (CSS alone cannot do this). Only the strip's own scrollLeft is set, so the page never moves.
import Link from "next/link";
import { useEffect, useRef } from "react";
import s from "./owner.module.css";

export function OwnerNav({ items, current }: { items: { href: string; label: string }[]; current: string }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = ref.current;
    const link = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !link) return;
    const left = link.offsetLeft - nav.offsetLeft;
    nav.scrollLeft = Math.max(0, left - (nav.clientWidth - link.offsetWidth) / 2);
  }, [current]);
  return (
    <nav ref={ref} aria-label="Owner" className={s.navScroll}>
      <ul className={s.track}>
        {items.map((item) => (
          <li key={item.href}>
            <Link className={s.navLink} href={item.href} aria-current={item.href === current ? "page" : undefined}>
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
