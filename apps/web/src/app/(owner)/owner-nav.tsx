// The owner nav: six primary links in one row plus a native <details> disclosure ("More") holding the rest.
// The disclosure opens without JavaScript; its panel overlays the content below instead of widening the row.
// The summary names the section when the current page is one of the links it hides.
import Link from "next/link";
import s from "./owner.module.css";

export type OwnerNavItem = { href: string; label: string };

export function OwnerNav({ primary, more, current }: { primary: OwnerNavItem[]; more: OwnerNavItem[]; current: string }) {
  const currentMore = more.find((item) => item.href === current);
  return (
    <nav aria-label="Owner" className={s.nav}>
      <div className={s.navRow}>
        <ul className={s.track}>
          {primary.map((item) => (
            <li key={item.href}>
              <Link className={s.navLink} href={item.href} aria-current={item.href === current ? "page" : undefined}>
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
        <details className={s.more}>
          <summary className={s.moreSummary}>{currentMore ? `More: ${currentMore.label}` : "More"}</summary>
          <ul className={s.morePanel}>
            {more.map((item) => (
              <li key={item.href}>
                <Link
                  className={s.moreLink}
                  href={item.href}
                  aria-current={item.href === current ? "page" : undefined}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </details>
      </div>
    </nav>
  );
}
