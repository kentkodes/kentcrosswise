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
        <p className={s.updated}>Last updated: 17 November 2026</p>
        <p className={s.intro}>
          Kentcrosswise is a personal project with one account. This page says what the site does with
          data and which services it uses.
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
            The owner&apos;s own notes and other private data are not shown on the public pages. Notes
            are also sent to the language model service named under Third-party services. The essay
            library is private: its texts are for the owner&apos;s reading and are not distributed.
          </p>
        </section>

        <section aria-labelledby="services" className={s.section}>
          <h2 id="services" className={s.heading}>Third-party services</h2>
          <p className={s.text}>In use today:</p>
          <ul className={s.list}>
            <li>
              Google sign-in for the owner, requesting only the basic profile information (identity and
              email address). Connecting Calendar or YouTube, described below, asks for more. See
              the <a href="https://policies.google.com/privacy">Google Privacy Policy</a>.
            </li>
            <li>
              Language model services. The site sends the owner&apos;s own notes to DeepSeek to sort
              them, to score mood and to suggest calendar events; it sends no visitor data. When the
              project&apos;s software agents run, they send the owner&apos;s task text and the
              project&apos;s code to Anthropic and DeepSeek models.
            </li>
            <li>
              Web push, for the owner&apos;s own devices only. A device the owner enables stores a push
              subscription with the site. The site then sends a count of new inbox items, never their
              text, through the push service of that browser&apos;s maker (Apple, Google, Mozilla or
              Microsoft). Visitors are never asked for notification permission.
            </li>
          </ul>
          <p className={s.text}>
            The owner can connect Google Calendar and YouTube to the owner&apos;s own Google account.
            The connection asks Google for access to the owner&apos;s own calendar events and for
            read-only access to the owner&apos;s YouTube account, and stores a refresh token in the
            site&apos;s secret store. It can be disconnected at any time: the site asks Google to
            revoke the token and deletes its stored copy once Google confirms. It reads only the
            owner&apos;s own data, never visitors&apos; data. When the owner accepts a suggested
            event, the site adds that event to the owner&apos;s calendar; it reads no existing
            events. From YouTube the site reads only channel statistics (subscriber and view counts):
            once a day, for a channel the owner has marked for the daily job on the social page, and
            it stores them. YouTube is accessed through YouTube API Services. By using it you are also
            bound by the{" "}
            <a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a>, and Google handles
            data under the{" "}
            <a href="https://policies.google.com/privacy">Google Privacy Policy</a>.
          </p>
          <p className={s.text}>
            The site&apos;s use and transfer of information received from Google APIs adheres to the{" "}
            <a href="https://developers.google.com/terms/api-services-user-data-policy">
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements. Google data is used only for the two features
            above. It is not sold, not used for advertising, not sent to language model services and
            not used to train or improve any AI or machine learning model. It is not transferred to
            anyone else, except to the site&apos;s hosting and secret store to provide those features,
            or where the law requires it. No person reads it except the owner, or where needed for
            security or required by law. Stored YouTube statistics are deleted with the account on the
            social page; the refresh token is deleted when Google is disconnected.
          </p>
          <p className={s.text}>
            Instagram: for an account the owner has marked for the daily job, the site reads the
            follower count of the owner&apos;s own Instagram account once a day. It uses an access
            token the owner placed in the site&apos;s secret store and renews that token about every 25
            days. It reads no other account and no visitors&apos; data.
          </p>
          <p className={s.text}>
            TikTok is not connected. The owner types TikTok numbers in by hand, and the site does not
            contact TikTok.
          </p>
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
