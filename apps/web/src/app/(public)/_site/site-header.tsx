// Shared public header: wordmark and main navigation for /, /demo and /office.
// Renders statically; the account link ("Sign in" or, for a signed-in visitor, "Your hub") is
// resolved in the browser by AccountLink, so the public pages never read the session on the server.
import Link from "next/link";
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
  stage = false,
}: {
  /** The page being shown; its link carries aria-current="page". */
  current: PublicPath;
  /** Placement from the page (e.g. its grid cell). */
  className?: string;
  /** Home only: from 1100px, place the header in the comp stage's pixel coordinates. */
  stage?: boolean;
}) {
  return (
    <header className={[h.header, stage ? h.stage : "", className ?? ""].filter(Boolean).join(" ")}>
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
          <li className={h.navSignIn}>
            <AccountLink />
          </li>
        </ul>
      </nav>
    </header>
  );
}
