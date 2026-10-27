import type { Metadata } from "next";
import { PublicShell } from "../_site/public-shell";
import s from "./bot.module.css";

export const metadata: Metadata = {
  title: "KentcrosswiseBot | Kentcrosswise",
  description: "What KentcrosswiseBot does and how to report a bot issue.",
};

export default function BotPage() {
  return (
    <PublicShell current="/bot">
      <main className={s.article}>
        <h1>KentcrosswiseBot</h1>
        <p className={s.intro}>KentcrosswiseBot discovers essays for a personal reading library.</p>
        <p className={s.status}>In development. Automated discovery is not enabled.</p>

        <section aria-labelledby="how-it-works">
          <h2 id="how-it-works">How it works</h2>
          <p>
            Discovery starts with catalog metadata. The bot follows published access rules, uses
            conservative request pacing, and stops when access is blocked. It does not sign in,
            bypass paywalls, or work around access restrictions.
          </p>
        </section>

        <section aria-labelledby="identification">
          <h2 id="identification">Identification</h2>
          <p>The planned User-Agent identifies the bot and links back to this page:</p>
          <p className={s.agent}><code>KentcrosswiseBot/1.0 (+https://kentcrosswise.com/bot)</code></p>
        </section>

        <section aria-labelledby="contact">
          <h2 id="contact">Contact</h2>
          <p><a className={s.report} href="https://github.com/kentkodes/kentcrosswise/issues/new">Report a bot issue</a></p>
          <p className={s.note}>
            GitHub sign-in required. Reports are public; include the affected URL and request time,
            and avoid private information.
          </p>
        </section>
      </main>
    </PublicShell>
  );
}
