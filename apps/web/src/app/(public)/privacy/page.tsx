import type { Metadata } from "next";
import Link from "next/link";
import { PaperFrame } from "../_site/paper-frame";
import s from "../terms/legal.module.css";

export const metadata: Metadata = {
  title: "Privacy | Kentcrosswise",
  description: "What the Kentcrosswise website stores and which services it uses.",
};

export default function PrivacyPage() {
  return (
    <PaperFrame>
      <div className={s.column}>
        <h1 className={s.title}>Privacy</h1>
        <p className={s.updated}>Last updated: 14 November 2026</p>
        <p className={s.intro}>
          Kentcrosswise is a personal project with one account. This page says what the site does with
          data, and marks what is only planned.
        </p>

        <section aria-labelledby="account" className={s.section}>
          <h2 id="account" className={s.heading}>One account</h2>
          <p className={s.text}>
            Only the owner has an account, and signs in with Google. Visitors cannot create accounts,
            and the site asks visitors for no personal information.
          </p>
        </section>

        <section aria-labelledby="visitors" className={s.section}>
          <h2 id="visitors" className={s.heading}>What visitors send and what is stored</h2>
          <ul className={s.list}>
            <li>The site has no analytics, tracking or advertising scripts.</li>
            <li>
              The fonts are served from the site itself; the browser does not contact Google Fonts.
            </li>
            <li>
              The public pages set no cookies of their own. Every public page asks the site&apos;s
              sign-in service whether the owner is signed in, which only changes the header link
              between &quot;Sign in&quot; and &quot;Your hub&quot;. The sign-in pages, which only the
              owner needs, use cookies for the sign-in session.
            </li>
            <li>
              Like any web request, a page request reaches AWS (CloudFront and Lambda). The site&apos;s
              functions write operational logs to AWS CloudWatch Logs.
            </li>
            <li>
              The site does not store anything about logged-out visitors in its database.
            </li>
          </ul>
        </section>

        <section aria-labelledby="hosting" className={s.section}>
          <h2 id="hosting" className={s.heading}>Hosting</h2>
          <p className={s.text}>
            The site runs on AWS (CloudFront and Lambda). Its database is Postgres on Neon.
          </p>
        </section>

        <section aria-labelledby="public-data" className={s.section}>
          <h2 id="public-data" className={s.heading}>What the public pages show</h2>
          <ul className={s.list}>
            <li>The demo shows generated data, not real people.</li>
            <li>
              The agent office shows real but sanitized activity of the project&apos;s software agents:
              the agent, the time, the event type and a sanitized task title. Private tasks appear as
              &quot;Private task&quot;.
            </li>
          </ul>
        </section>

        <section aria-labelledby="private-data" className={s.section}>
          <h2 id="private-data" className={s.heading}>The owner&apos;s private data</h2>
          <p className={s.text}>
            The owner&apos;s own notes and other private data stay behind sign-in and are not shown on
            the public pages. The essay library is private: its texts are for the owner&apos;s reading
            and are not distributed.
          </p>
        </section>

        <section aria-labelledby="services" className={s.section}>
          <h2 id="services" className={s.heading}>Third-party services</h2>
          <p className={s.text}>In use today:</p>
          <ul className={s.list}>
            <li>
              Google sign-in for the owner, requesting only the basic profile information (identity and
              email address). See the{" "}
              <a href="https://policies.google.com/privacy">Google Privacy Policy</a>.
            </li>
          </ul>
          <p className={s.text}>
            Planned, not built yet. Each would read only the owner&apos;s own data and own account
            statistics, never visitors&apos; data:
          </p>
          <ul className={s.list}>
            <li>Google Calendar, to suggest and create the owner&apos;s own events.</li>
            <li>
              YouTube: the hub will read the owner&apos;s own channel statistics through YouTube API
              Services. By using it you are also bound by the{" "}
              <a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a>, and Google handles
              data under the{" "}
              <a href="https://policies.google.com/privacy">Google Privacy Policy</a>.
            </li>
            <li>Instagram, the owner&apos;s own account statistics only.</li>
            <li>TikTok, the owner&apos;s own account statistics only.</li>
          </ul>
        </section>

        <section aria-labelledby="changes" className={s.section}>
          <h2 id="changes" className={s.heading}>Changes</h2>
          <p className={s.text}>
            This page will be updated when the above changes; the date at the top shows the latest
            update. See also the <Link href="/terms">terms</Link>.
          </p>
        </section>

        <section aria-labelledby="contact" className={s.section}>
          <h2 id="contact" className={s.heading}>Contact</h2>
          <p className={s.text}>
            Questions about privacy: <a href="https://github.com/kentkodes/kentcrosswise/issues/new">open
            an issue</a> on the public GitHub repository. GitHub sign-in is required and issues are
            public, so do not include private information.
          </p>
        </section>
      </div>
    </PaperFrame>
  );
}
