// Owner console frame: the shared Paper frame (PaperFrame renders the <main>), the page head with its
// heading and optional actions, and the owner nav. Owner pages render their content as children.
// Regions, dots and notices are in owner-ui.tsx.
import Link from "next/link";
import type { ReactNode } from "react";
import { PaperFrame } from "@/app/(public)/_site/paper-frame";
import s from "./owner.module.css";

export type OwnerPath = "/hub" | "/console" | "/inbox" | "/console/usage" | "/essays";

const NAV: { href: OwnerPath; label: string }[] = [
  { href: "/hub", label: "Hub" },
  { href: "/console", label: "Boss console" },
  { href: "/inbox", label: "Inbox" },
  { href: "/console/usage", label: "Usage" },
  { href: "/essays", label: "Essays" },
];

export function OwnerFrame({
  title,
  current,
  actions,
  children,
}: {
  title: string;
  /** The nav item for this page. /essays/setup passes "/essays". */
  current: OwnerPath;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <PaperFrame>
      <div className={s.page}>
        <div className={s.top}>
          <header className={s.head}>
            <h1 className={s.title}>{title}</h1>
            {actions ? <div className={s.actions}>{actions}</div> : null}
          </header>
          <nav aria-label="Owner" className={s.navScroll}>
            <ul className={s.track}>
              {NAV.map((item) => (
                <li key={item.href}>
                  <Link className={s.navLink} href={item.href} aria-current={item.href === current ? "page" : undefined}>
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        {children}
      </div>
    </PaperFrame>
  );
}
