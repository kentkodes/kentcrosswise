// View model for the /demo Essays tab: the static, link-only public-domain essays from @kcw/demo-data with their
// simulated ratings. Pure: no clock and no React. (The simulated hub tabs were removed in PL5; /demo leads with the
// public log, which the browser loads from the public API.)
import { DEMO_ESSAYS, DEMO_ESSAY_RATINGS, lengthBand, readingMinutes, recommend } from "@kcw/demo-data";

export interface DemoView {
  essays: EssaysView;
}

export interface EssayCard {
  id: string;
  title: string;
  author: string;
  /** "1895", or null when the seed list has no year. */
  year: string | null;
  type: string;
  length: string;
  minutes: string;
  hook: string;
  sourceUrl: string;
  /** The simulated earlier rating, if any. */
  stars: number | null;
}

export interface EssaysView {
  feed: EssayCard[];
  /** The recommended essay id and the plain reason line, or null. */
  recommended: { id: string; reason: string } | null;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Static, link-only essays from @kcw/demo-data with the simulated ratings. */
export function buildEssaysView(): EssaysView {
  const stars = new Map(DEMO_ESSAY_RATINGS.map((r) => [r.essayId, r.stars]));
  const feed = DEMO_ESSAYS.map((e) => ({
    id: e.id,
    title: e.title,
    author: e.author,
    year: e.year === null ? null : String(e.year),
    type: capitalise(e.type),
    length: lengthBand(e.words),
    minutes: `${readingMinutes(e.words)} min`,
    hook: e.hook,
    sourceUrl: e.sourceUrl,
    stars: stars.get(e.id) ?? null,
  }));
  const rec = recommend();
  const liked = rec ? DEMO_ESSAYS.find((e) => e.id === rec.likedId) : undefined;
  return { feed, recommended: rec && liked ? { id: rec.essayId, reason: `Because you liked ${liked.title}` } : null };
}

export function buildDemoView(): DemoView {
  return { essays: buildEssaysView() };
}
