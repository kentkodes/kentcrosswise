// Public: visitors. May import only @kcw/demo-data and @kcw/xray (ESLint enforces it).
// Home, first viewport: approved composition 3 "Hub window" (.impeccable/mocks/03-hub-window.png).
import Image from "next/image";
import Link from "next/link";
import { figures, rosarivo } from "./_home/fonts";
import { HubWindow } from "./_home/hub-window";
import { Fireflies } from "./_home/fireflies";
import { ArrowRight } from "./_home/icons";
import { SceneFrame } from "./_home/scene";
import s from "./_home/home.module.css";
import landscape from "./_home/plates/landscape.png";
import retroComputer from "./_home/plates/retro-computer.png";

export default function HomePage() {
  return (
    <div className={`${s.page} ${rosarivo.variable} ${figures.variable}`}>
      <SceneFrame>
        <div className={s.stage}>
          <div className={s.scenery} aria-hidden="true" data-scenery="">
            <Image className={s.landscape} src={landscape} alt="" preload unoptimized />
            <Image className={s.computer} src={retroComputer} alt="" loading="eager" unoptimized />
            <div className={s.nightVeil} />
            <Fireflies />
          </div>

          <header className={s.siteHeader}>
            <Link className={s.wordmark} href="/">
              Kentcrosswise
            </Link>
            <nav className={s.siteNav} aria-label="Main">
              <ul className={s.navList}>
                <li>
                  <Link className={s.navLink} href="/" aria-current="page">
                    Home
                  </Link>
                </li>
                <li>
                  <Link className={s.navLink} href="/demo">
                    Demo
                  </Link>
                </li>
                <li>
                  <Link className={s.navLink} href="/office">
                    Office
                  </Link>
                </li>
                <li className={s.navSignIn}>
                  {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- Auth.js route handler, needs a full page load */}
                  <a className={s.signIn} href="/api/auth/signin">
                    Sign in
                  </a>
                </li>
              </ul>
            </nav>
          </header>

          <main className={s.main}>
            <div className={s.intro}>
              <h1 className={s.headline}>
                A little space
                <br />
                for your everyday.
              </h1>
              <Link className={s.entrance} href="/demo">
                Explore the demo
                <ArrowRight className={s.entranceArrow} />
              </Link>
            </div>
            <HubWindow />
          </main>
        </div>
      </SceneFrame>

      <footer className={s.footer}>
        <div className={s.footerInner}>
          <p className={s.footerMark}>Kentcrosswise</p>
          <p className={s.footerNote}>
            A personal hub built with a small team of AI agents. Everything in the demo is simulated: the
            people, moods and numbers are generated examples.
          </p>
          <ul className={s.footerLinks}>
            <li>
              <Link href="/demo">Explore the demo</Link>
            </li>
            <li>
              <Link href="/office">Agent office</Link>
            </li>
          </ul>
        </div>
      </footer>
    </div>
  );
}
