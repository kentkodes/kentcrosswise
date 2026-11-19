// Public: visitors. May import only @kcw/demo-data and @kcw/xray (ESLint enforces it).
// Home (PL5): shared header, hero, the lead panel (latest from the public log, then agent activity), three feature
// rows, shared footer. The copy describes the personal helper as the MVP intends it (owner, 2026-11-19).
import Link from "next/link";
import { LogPreview } from "./_home/log-preview";
import s from "./_home/home.module.css";
import { PaperFrame } from "./_site/paper-frame";
import { Xray } from "./_site/xray";

// Hero copy, in one place (owner-approved direction, 2026-11-19).
export const HERO = {
  headline: "A personal helper you can inspect.",
  subline:
    "I write it quick notes. It works out what each one is and acts on it inside my own records: it attaches a note to the person it's about, scores the mood of a diary entry, or suggests a calendar event when a note mentions a plan. The log shows what it did with each entry, and whether I agreed.",
  privacy:
    "Entries are sanitized before they appear. Names become placeholders such as [Person 1], and anything that can't be shown safely is withheld and only counted.",
} as const;

const FEATURES = [
  {
    title: "The log",
    text: "Each published entry with how it was filed, every step it took, my corrections, and any failure with how it recovered.",
  },
  {
    title: "Built with AI agents",
    text: "A small team of AI agents plans, codes, reviews and ships changes to this site. The agent office shows their work.",
  },
  {
    title: "An essay library",
    text: "Classic public-domain essays, with a reader and recommendations.",
  },
];

export default function HomePage() {
  return (
    <PaperFrame current="/">
      <section className={s.hero}>
        <h1 className={s.headline}>{HERO.headline}</h1>
        <p className={s.subline}>{HERO.subline}</p>
        <p className={s.privacy}>{HERO.privacy}</p>
        <div className={s.ctas}>
          <Link className={s.primary} href="/demo">
            Read the log
          </Link>
          <Link className={s.secondary} href="/office">
            Agent office
          </Link>
        </div>
      </section>
      <Xray id="log-preview">
        <LogPreview />
      </Xray>
      <section className={s.features}>
        {FEATURES.map((f) => (
          <div key={f.title}>
            <h2 className={s.featureTitle}>{f.title}</h2>
            <p className={s.featureText}>{f.text}</p>
          </div>
        ))}
      </section>
    </PaperFrame>
  );
}
