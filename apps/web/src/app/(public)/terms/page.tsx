import type { Metadata } from "next";
import Link from "next/link";
import { PaperFrame } from "../_site/paper-frame";
import s from "./legal.module.css";

export const metadata: Metadata = {
  title: "Terms | Kentcrosswise",
  description: "Terms for using the Kentcrosswise website.",
};

export default function TermsPage() {
  return (
    <PaperFrame>
      <div className={s.column}>
        <h1 className={s.title}>Terms</h1>
        <p className={s.updated}>Last updated: 19 November 2026</p>
        <p className={s.intro}>
          Kentcrosswise is a personal project. By using this website you agree to these short terms.
        </p>

        <section aria-labelledby="project" className={s.section}>
          <h2 id="project" className={s.heading}>The project</h2>
          <p className={s.text}>
            Kentcrosswise is a personal, non-commercial project. It sells nothing and shows no
            advertising. It is provided as is, without any promise that it is available, correct or fit
            for a particular purpose, and it may change or go offline at any time.
          </p>
        </section>

        <section aria-labelledby="demo" className={s.section}>
          <h2 id="demo" className={s.heading}>What the public pages show</h2>
          <p className={s.text}>
            The public log shows sanitized copies of the owner&apos;s own entries and what the software did
            with them. Names and other personal details are replaced with placeholders, so the text is not a
            complete or exact record; do not rely on it. The essay ratings are simulated. The agent office
            shows real but sanitized activity of the project&apos;s software agents, as task titles and event
            types.
          </p>
        </section>

        <section aria-labelledby="use" className={s.section}>
          <h2 id="use" className={s.heading}>Acceptable use</h2>
          <p className={s.text}>Please do not:</p>
          <ul className={s.list}>
            <li>try to break into the site, its private areas or its accounts;</li>
            <li>overload the site or send automated traffic that degrades it;</li>
            <li>scrape the private areas, or try to get around the sign-in.</li>
          </ul>
          <p className={s.text}>
            Reading the public pages and the public source code is welcome. Automated access should
            stay light.
          </p>
        </section>

        <section aria-labelledby="links" className={s.section}>
          <h2 id="links" className={s.heading}>Third-party sites</h2>
          <p className={s.text}>
            The site links to other sites, such as GitHub. They are not under the owner&apos;s control,
            and their own terms and privacy policies apply when you use them.
          </p>
        </section>

        <section aria-labelledby="changes" className={s.section}>
          <h2 id="changes" className={s.heading}>Changes to these terms</h2>
          <p className={s.text}>
            These terms may change. The date at the top shows the latest update; using the site after a
            change means you accept the new text.
          </p>
        </section>

        <section aria-labelledby="privacy" className={s.section}>
          <h2 id="privacy" className={s.heading}>Privacy</h2>
          <p className={s.text}>
            What the site does with data is described in the <Link href="/privacy">privacy page</Link>.
          </p>
        </section>

        <section aria-labelledby="contact" className={s.section}>
          <h2 id="contact" className={s.heading}>Contact</h2>
          <p className={s.text}>
            Questions about these terms: <a href="https://github.com/kentkodes/kentcrosswise/issues/new">open
            an issue</a> on the public GitHub repository. GitHub sign-in is required and issues are
            public, so do not include private information.
          </p>
        </section>
      </div>
    </PaperFrame>
  );
}
