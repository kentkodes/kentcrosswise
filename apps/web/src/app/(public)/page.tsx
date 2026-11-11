// Public: visitors. May import only @kcw/demo-data and @kcw/xray (ESLint enforces it).
// Home: shared header, hero, a static product still of the hub, three feature rows, shared footer.
import Link from "next/link";
import { ProductStill } from "./_home/product-still";
import s from "./_home/home.module.css";
import { PaperFrame } from "./_site/paper-frame";

// Hero copy, in one place. Default text from the home redesign spec; the owner may change it.
export const HERO = {
  headline: "Watch AI agents build my personal hub.",
  subline:
    "Every change to Kentcrosswise is planned, coded, reviewed and shipped by a small team of agents. The office shows the work as it happens.",
} as const;

const FEATURES = [
  {
    title: "Your people, reading and notes",
    text: "Contacts, moods, essays and notes in one quiet place.",
  },
  {
    title: "An essay library",
    text: "Three hundred classic and modern essays, with a reader and recommendations.",
  },
  {
    title: "Built in the open",
    text: "A small team of AI agents plans, writes, reviews and ships every change. Watch them in the agent office.",
  },
];

export default function HomePage() {
  return (
    <PaperFrame current="/">
      <section className={s.hero}>
        <h1 className={s.headline}>{HERO.headline}</h1>
        <p className={s.subline}>{HERO.subline}</p>
        <div className={s.ctas}>
          <Link className={s.primary} href="/demo">
            Explore the demo
          </Link>
          <Link className={s.secondary} href="/office">
            Agent office
          </Link>
        </div>
      </section>
      <ProductStill />
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
