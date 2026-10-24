// Shared public header: wordmark and main navigation for /, /demo and /office.
// Server component: a signed-in visitor sees "Your hub" (/hub) in place of "Sign in". Reading the
// session cookie makes the public pages render per request.
import Link from "next/link";
import { isSignedIn } from "@/auth/visitor";
import h from "./site-header.module.css";

export type PublicPath = "/" | "/demo" | "/office";

const LINKS: { href: PublicPath; label: string }[] = [
  { href: "/", label: "Home" },
  { href: "/demo", label: "Demo" },
  { href: "/office", label: "Agent office" },
];

export async function SiteHeader({
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
  const signedIn = await isSignedIn();
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
            {signedIn ? (
              <Link className={h.signIn} href="/hub">
                Your hub
              </Link>
            ) : (
              // eslint-disable-next-line @next/next/no-html-link-for-pages -- Auth.js route handler, needs a full page load
              <a className={h.signIn} href="/api/auth/signin">
                Sign in
              </a>
            )}
          </li>
        </ul>
      </nav>
    </header>
  );
}
