// Public: visitors. May import only @kcw/demo-data and @kcw/xray (ESLint enforces it).
// Home: shared header, hero, a static product still of the hub, three feature rows, shared footer.
import Link from "next/link";
import { ProductStill } from "./_home/product-still";
import s from "./_home/home.module.css";
import { geistMono, geistSans } from "./_site/fonts";
import { SiteFooter } from "./_site/site-footer";
import { SiteHeader } from "./_site/site-header";

// Hero copy, in one place. Default text from the home redesign spec; the owner may change it.
export const HERO = {
  headline: "Personal software, built by a team of AI agents.",
  subline:
    "Kentcrosswise is my hub for people, reading and notes. Agents plan, write, review and ship every change, and you can watch them work.",
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
    <div className={`${s.page} ${geistSans.variable} ${geistMono.variable}`}>
      <SiteHeader current="/" />
      <main className={s.main}>
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
      </main>
      <SiteFooter />
    </div>
  );
}
