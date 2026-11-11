// Shared public footer: wordmark, what the demo is, and the public links. Static; no session read.
import Link from "next/link";
import f from "./site-footer.module.css";

export function SiteFooter() {
  return (
    <footer className={f.footer}>
      <div className={f.inner}>
        <p className={f.wordmark}>Kentcrosswise</p>
        <p className={f.note}>
          A personal hub built with a small team of AI agents. Everything in the demo is simulated: the
          people, moods and numbers are generated examples.
        </p>
        <nav className={f.nav} aria-label="Footer">
          <ul className={f.navList}>
            <li>
              <Link className={f.navLink} href="/demo">
                Demo
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
          </ul>
        </nav>
      </div>
    </footer>
  );
}
