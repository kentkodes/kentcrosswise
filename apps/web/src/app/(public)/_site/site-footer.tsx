// Shared public footer: wordmark, what the public pages show, and the public links. Static; no session read.
import Link from "next/link";
import f from "./site-footer.module.css";

export function SiteFooter() {
  return (
    <footer className={f.footer}>
      <div className={f.inner}>
        <p className={f.wordmark}>Kentcrosswise</p>
        <p className={f.note}>
          A personal helper built with a small team of AI agents. The log shows the owner&apos;s own entries,
          sanitized; the essay ratings are simulated.
        </p>
        <nav className={f.nav} aria-label="Footer">
          <ul className={f.navList}>
            <li>
              <Link className={f.navLink} href="/demo">
                Log
              </Link>
            </li>
            <li>
              <Link className={f.navLink} href="/office">
                Agent office
              </Link>
            </li>
            <li>
              <Link className={f.navLink} href="/bot">
                Bot
              </Link>
            </li>
            <li>
              <Link className={f.navLink} href="/terms">
                Terms
              </Link>
            </li>
            <li>
              <Link className={f.navLink} href="/privacy">
                Privacy
              </Link>
            </li>
          </ul>
        </nav>
      </div>
    </footer>
  );
}
