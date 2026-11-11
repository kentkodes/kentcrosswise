// Shared public header: wordmark and main navigation for /, /demo, /office and /bot.
// Renders statically; the account link ("Sign in" or, for a signed-in visitor, "Your hub") is
// resolved in the browser by AccountLink, so the public pages never read the session on the server.
import Link from "next/link";
import type { ReactNode } from "react";
import { AccountLink } from "./account-link";
import h from "./site-header.module.css";

export type PublicPath = "/" | "/demo" | "/office" | "/bot";

const LINKS: { href: PublicPath; label: string }[] = [
  { href: "/", label: "Home" },
  { href: "/demo", label: "Demo" },
  { href: "/office", label: "Agent office" },
];

export function SiteHeader({
  current,
  className,
  below,
}: {
  /** The page being shown; its link carries aria-current="page". Omitted on owner pages. */
  current?: PublicPath;
  /** Placement from the page (e.g. its grid cell). */
  className?: string;
  /** Full-width content under the header row, inside the sticky header (the reader's progress line). */
  below?: ReactNode;
}) {
  return (
    <header className={[h.header, className ?? ""].filter(Boolean).join(" ")}>
      <div className={h.inner}>
        <Link className={h.wordmark} href="/">
          Kentcrosswise
        </Link>
        <nav className={h.nav} aria-label="Main">
          <ul className={h.navList}>
            {LINKS.map((l) => (
              <li key={l.href}>
                <Link className={h.navLink} href={l.href} aria-current={l.href === current ? "page" : undefined}>
                  {l.label}
                </Link>
              </li>
            ))}
            <li>
              <AccountLink />
            </li>
          </ul>
        </nav>
      </div>
      {below}
    </header>
  );
}
