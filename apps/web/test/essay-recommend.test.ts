import { describe, expect, it } from "vitest";
import { LIKED_MIN_STARS, rankRecommendations, similarity, weightOf, type EssayMeta, type RatedEssay } from "../src/server/essay-recommend";

const day = 86_400_000;
const essay = (id: string, over: Partial<EssayMeta> = {}): EssayMeta => ({
  id,
  author: "Anon",
  year: null,
  types: [],
  createdAt: 1_700_000_000_000,
  ...over,
});
const rated = (id: string, stars: number, over: Partial<EssayMeta> = {}): RatedEssay => ({ ...essay(id, over), stars });
const ids = <T extends EssayMeta>(xs: readonly T[]) => xs.map((x) => x.id);

describe("similarity", () => {
  it("adds shared type, same author and era (same or adjacent decade) when years are known", () => {
    const liked = essay("L", { author: "Woolf", year: 1923, types: ["cultural"] });
    expect(similarity(essay("c", { types: ["cultural"] }), liked)).toBe(3);
    expect(similarity(essay("c", { author: "  woolf " }), liked)).toBe(2);
    expect(similarity(essay("c", { year: 1921 }), liked)).toBe(2);
    expect(similarity(essay("c", { year: 1931 }), liked)).toBe(1);
    expect(similarity(essay("c", { year: 1950 }), liked)).toBe(0);
    expect(similarity(essay("c", { types: ["cultural"], author: "Woolf", year: 1923 }), liked)).toBe(7);
  });

  it("ignores era when either year is unknown", () => {
    expect(similarity(essay("c", { author: "A", year: null }), essay("L", { author: "B", year: 1923 }))).toBe(0);
    expect(similarity(essay("c", { author: "A", year: 1923 }), essay("L", { author: "B", year: null }))).toBe(0);
  });
});

describe("rankRecommendations", () => {
  const newest = essay("newest", { createdAt: 3 * day });
  const middle = essay("middle", { createdAt: 2 * day });
  const oldest = essay("oldest", { createdAt: 1 * day });

  it("orders by newest first when nothing is rated", () => {
    expect(ids(rankRecommendations([oldest, newest, middle], []))).toEqual(["newest", "middle", "oldest"]);
  });

  it("orders by newest first when ratings exist but none is 4 stars or more", () => {
    const low = rated("rated-low", 3, { types: ["travel"], author: "Anon", createdAt: 9 * day });
    const out = rankRecommendations([oldest, newest, middle], [low]);
    expect(ids(out)).toEqual(["newest", "middle", "oldest"]);
    expect(out.every((r) => r.score === 0)).toBe(true);
  });

  it("drops rated essays even when they are passed as candidates", () => {
    const liked = rated("newest", 5, { types: ["cultural"] });
    expect(ids(rankRecommendations([newest, middle], [liked]))).toEqual(["middle"]);
  });

  it("ranks a candidate sharing type and author with a liked essay above unrelated ones", () => {
    const liked = rated("liked", 5, { author: "Hurston", types: ["personal_memoir"], year: 1937 });
    const match = essay("match", { author: "Hurston", types: ["personal_memoir"], year: 1939, createdAt: 1 * day });
    const typeOnly = essay("type", { types: ["personal_memoir"], createdAt: 5 * day });
    const none = essay("none", { types: ["travel"], author: "Other", year: 1800, createdAt: 9 * day });
    const out = rankRecommendations([none, typeOnly, match], [liked]);
    expect(ids(out)).toEqual(["match", "type", "none"]);
    // 5-star weight 2 x similarity (type 3 + author 2 + same decade 2 = 7) = 14; type only = 2 x 3 = 6.
    expect(out.map((r) => r.score)).toEqual([14, 6, 0]);
  });

  it("weights 5-star ratings above 4-star ones", () => {
    expect(weightOf(LIKED_MIN_STARS)).toBe(1);
    expect(weightOf(5)).toBe(2);
    const fiveStar = rated("five", 5, { types: ["cultural"] });
    const fourStar = rated("four", 4, { types: ["comedic"] });
    const out = rankRecommendations(
      [essay("from-four", { types: ["comedic"], createdAt: 9 * day }), essay("from-five", { types: ["cultural"], createdAt: 1 * day })],
      [fourStar, fiveStar],
    );
    expect(ids(out)).toEqual(["from-five", "from-four"]);
    // Both pairs share the default author (2) and the type (3): 5 x weight 2 vs 5 x weight 1.
    expect(out.map((r) => r.score)).toEqual([10, 5]);
  });

  it("uses the best match across liked essays, not the sum", () => {
    const a = rated("a", 4, { author: "Thoreau", types: ["nature"] });
    const b = rated("b", 4, { author: "Thoreau", types: ["nature"] });
    const [only] = rankRecommendations([essay("c", { author: "Thoreau", types: ["nature"] })], [a]);
    const [twice] = rankRecommendations([essay("c", { author: "Thoreau", types: ["nature"] })], [a, b]);
    expect(only!.score).toBe(twice!.score);
  });

  it("breaks ties by newest, then by id", () => {
    const a = essay("b-id", { createdAt: 2 * day });
    const b = essay("a-id", { createdAt: 2 * day });
    const c = essay("z-newer", { createdAt: 3 * day });
    expect(ids(rankRecommendations([a, b, c], []))).toEqual(["z-newer", "a-id", "b-id"]);
  });

  it("does not mutate its inputs", () => {
    const input = [oldest, newest];
    rankRecommendations(input, []);
    expect(ids(input)).toEqual(["oldest", "newest"]);
  });
});
