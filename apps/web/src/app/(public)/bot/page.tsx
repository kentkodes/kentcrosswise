import type { Metadata } from "next";
import { PaperFrame } from "../_site/paper-frame";
import s from "./bot.module.css";

export const metadata: Metadata = {
  title: "KentcrosswiseBot | Kentcrosswise",
  description: "What KentcrosswiseBot does and how to report a bot issue.",
};

export default function BotPage() {
  return (
    <PaperFrame current="/bot">
      <div className={s.column}>
        <h1 className={s.title}>KentcrosswiseBot</h1>
        <p className={s.intro}>KentcrosswiseBot discovers essays for a personal reading library.</p>
        <p className={s.status}>
          <span className={s.dot} aria-hidden="true" />
          In development. Automated discovery is not enabled.
        </p>

        <section aria-labelledby="how-it-works" className={s.section}>
          <h2 id="how-it-works" className={s.heading}>How it works</h2>
          <p className={s.text}>
            Discovery starts with catalog metadata. The bot follows published access rules, uses
            conservative request pacing, and stops when access is blocked. It does not sign in,
            bypass paywalls, or work around access restrictions.
          </p>
        </section>

        <section aria-labelledby="identification" className={s.section}>
          <h2 id="identification" className={s.heading}>Identification</h2>
          <p className={s.text}>The planned User-Agent identifies the bot and links back to this page:</p>
          <pre className={s.agent}>KentcrosswiseBot/1.0 (+https://kentcrosswise.com/bot)</pre>
        </section>

        <section aria-labelledby="contact" className={s.section}>
          <h2 id="contact" className={s.heading}>Contact</h2>
          <p className={s.text}>
            <a className={s.report} href="https://github.com/kentkodes/kentcrosswise/issues/new">Report a bot issue</a>
          </p>
          <p className={s.note}>
            GitHub sign-in required. Reports are public; include the affected URL and request time,
            and avoid private information.
          </p>
        </section>
      </div>
    </PaperFrame>
  );
}
