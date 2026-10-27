// Public: visitors. May import only @kcw/demo-data and @kcw/xray (ESLint enforces it).
// Home, first viewport: approved composition 3 "Hub window" (.impeccable/mocks/03-hub-window.png).
import Image from "next/image";
import Link from "next/link";
import { HubWindow } from "./_home/hub-window";
import { Fireflies } from "./_home/fireflies";
import { ArrowRight } from "./_home/icons";
import { SceneFrame } from "./_home/scene";
import { figures, rosarivo } from "./_site/fonts";
import { SiteHeader } from "./_site/site-header";
import s from "./_home/home.module.css";
import landscape from "./_home/plates/landscape.png";
import retroComputer from "./_home/plates/retro-computer.png";

export default function HomePage() {
  return (
    <div className={`${s.page} ${rosarivo.variable} ${figures.variable}`}>
      <SceneFrame>
        <div className={s.stage}>
          <div className={s.scenery} aria-hidden="true" data-scenery="">
            <Image className={s.landscape} src={landscape} alt="" sizes="100vw" preload />
            <Image className={s.computer} src={retroComputer} alt="" loading="eager" unoptimized />
            <div className={s.nightVeil} />
            <Fireflies />
          </div>

          <SiteHeader current="/" stage className={s.siteHeader} />

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
