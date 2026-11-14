import { describe, expect, it } from "vitest";
import { LIKED_MIN_STARS, rankRecommendations, similarity, weightOf, type EssayMeta, type RatedEssay } from "../src/server/essay-recommend";

const day = 86_400_000;
const essay = (id: string, over: Partial<EssayMeta> = {}): EssayMeta => ({
  id,
  author: "Anon",
  year: null,
  types: [],
  kind: "full",
  lengthBand: null,
  createdAt: 1_700_000_000_000,
  ...over,
});
const rated = (id: string, stars: number, over: Partial<RatedEssay> = {}): RatedEssay => ({
  ...essay(id),
  title: `Title ${id}`,
  stars,
  worked: [],
  lengthFelt: null,
  ratedAt: 1_700_000_000_000,
  ...over,
});
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

  it("orders by newest first when ratings exist but none is 4 stars or more (a 3-star rating is neutral)", () => {
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

  it("breaks ties by full text first, then newest, then id", () => {
    const a = essay("b-id", { createdAt: 2 * day });
    const b = essay("a-id", { createdAt: 2 * day });
    const c = essay("z-newer", { createdAt: 3 * day });
    expect(ids(rankRecommendations([a, b, c], []))).toEqual(["z-newer", "a-id", "b-id"]);
    const link = essay("link-newest", { kind: "link", createdAt: 9 * day });
    const full = essay("full-oldest", { createdAt: 1 * day });
    expect(ids(rankRecommendations([link, full], []))).toEqual(["full-oldest", "link-newest"]);
  });

  it("does not mutate its inputs", () => {
    const input = [oldest, newest];
    rankRecommendations(input, []);
    expect(ids(input)).toEqual(["oldest", "newest"]);
  });

  it("adds one for each liked 'what worked' tag whose hinted types the candidate has", () => {
    // Candidates have their own author, so the only shared signal is the tag (the liked essay's author is "Anon").
    const comedy = essay("comedy", { types: ["comedic"], author: "Other", createdAt: 1 * day });
    const plain = essay("plain", { types: ["travel"], author: "Other", createdAt: 9 * day });
    const out = rankRecommendations([plain, comedy], [rated("liked", 4, { types: ["cultural"], worked: ["humor"] })]);
    expect(ids(out)).toEqual(["comedy", "plain"]);
    expect(out.map((r) => r.score)).toEqual([1, 0]);
  });

  it("counts one per tag, not per matching type, and a tag with no hinted types adds nothing", () => {
    const liked = rated("liked", 4, { types: ["cultural"], worked: ["argument", "humor"] });
    const [both] = rankRecommendations([essay("c", { types: ["argumentative", "political", "comedic"], author: "Other" })], [liked]);
    // argument matches (argumentative, political) and humor matches (comedic): 2 tags, 2 points.
    expect(both!.score).toBe(2);
    const [surprised] = rankRecommendations([essay("s", { types: ["comedic"], author: "Other" })], [rated("s5", 5, { worked: ["surprise"] })]);
    expect(surprised!.score).toBe(0);
  });

  it("subtracts the push of 1 or 2 star essays from the pull of liked ones", () => {
    const liked = rated("liked", 5, { author: "Woolf", types: ["cultural"] });
    const disliked = rated("bad", 1, { author: "Other", types: ["cultural"] });
    const [out] = rankRecommendations([essay("c", { author: "Woolf", types: ["cultural"] })], [liked, disliked]);
    // Pull: 5 stars x (author 2 + type 3) = 10. Push: 1 star x -2 weight x shared type 3 = 6. Score 4.
    expect(out!.score).toBe(4);
  });

  it("a 1 or 2 star essay pushes a same-author candidate below an unrelated one", () => {
    const bad = rated("bad", 1, { author: "Woolf", types: ["cultural"] });
    const same = essay("same", { author: "Woolf", types: ["travel"], createdAt: 9 * day });
    const other = essay("other", { author: "Other", types: ["travel"], createdAt: 1 * day });
    const out = rankRecommendations([same, other], [bad]);
    expect(ids(out)).toEqual(["other", "same"]);
    // 1 star weighs -2 and the shared author is worth 2: the same-author candidate is pushed by 4.
    expect(out.map((r) => r.score)).toEqual([0, -4]);
    const [meh] = rankRecommendations([same], [rated("meh", 2, { author: "Woolf" })]);
    // 2 stars weighs -1: the shared author pushes by 2.
    expect(meh!.score).toBe(-2);
  });

  it("treats a 3-star rating as neutral", () => {
    const mid = rated("mid", 3, { author: "Woolf", types: ["cultural"] });
    const [out] = rankRecommendations([essay("same", { author: "Woolf", types: ["cultural"] })], [mid]);
    expect(out!.score).toBe(0);
  });

  describe("length felt", () => {
    const short = essay("short", { lengthBand: "short" });
    const medium = essay("medium", { lengthBand: "medium" });
    const long = essay("long", { lengthBand: "long" });
    const link = essay("link", { kind: "link" });
    const scores = (history: RatedEssay[]) => Object.fromEntries(rankRecommendations([short, medium, long, link], history).map((r) => [r.id, r.score]));

    it("too long on a medium essay sinks medium and long, and a later 'right' clears it", () => {
      const tooLong = rated("tooLong", 3, { lengthBand: "medium", lengthFelt: "too_long", ratedAt: 1 * day });
      expect(scores([tooLong])).toEqual({ short: 0, medium: -1, long: -1, link: 0 });
      const right = rated("right", 3, { lengthBand: "long", lengthFelt: "right", ratedAt: 2 * day });
      expect(scores([tooLong, right])).toEqual({ short: 0, medium: 0, long: 0, link: 0 });
    });

    it("too short on a medium essay sinks short and medium", () => {
      const tooShort = rated("tooShort", 3, { lengthBand: "medium", lengthFelt: "too_short", ratedAt: 1 * day });
      expect(scores([tooShort])).toEqual({ short: -1, medium: -1, long: 0, link: 0 });
    });

    it("uses the latest answer, skipping ratings that have none", () => {
      const tooLong = rated("tooLong", 3, { lengthBand: "medium", lengthFelt: "too_long", ratedAt: 1 * day });
      const tooShort = rated("tooShort", 3, { lengthBand: "medium", lengthFelt: "too_short", ratedAt: 2 * day });
      const noAnswer = rated("noAnswer", 3, { lengthBand: "short", lengthFelt: null, ratedAt: 3 * day });
      expect(scores([tooLong, tooShort, noAnswer])).toEqual({ short: -1, medium: -1, long: 0, link: 0 });
    });

    it("an answer on an essay with no length band gives no penalty, and link-only candidates are never penalised", () => {
      const linkTooLong = rated("linkTooLong", 3, { kind: "link", lengthBand: null, lengthFelt: "too_long", ratedAt: 1 * day });
      expect(scores([linkTooLong])).toEqual({ short: 0, medium: 0, long: 0, link: 0 });
    });
  });

  describe("because", () => {
    it("names the liked essay that gave the best pull, and the first one on a tie", () => {
      const fourStar = rated("four", 4, { author: "Hurston", types: ["cultural"], title: "Four Star" });
      const fiveStar = rated("five", 5, { author: "Hurston", types: ["cultural"], title: "Five Star" });
      const twin = rated("twin", 5, { author: "Hurston", types: ["cultural"], title: "Twin" });
      const match = essay("match", { author: "Hurston", types: ["cultural"] });
      const [top] = rankRecommendations([match], [fourStar, fiveStar]);
      expect(top!.because).toEqual({ id: "five", title: "Five Star", author: "Hurston" });
      const [tie] = rankRecommendations([match], [fiveStar, twin]);
      expect(tie!.because).toEqual({ id: "five", title: "Five Star", author: "Hurston" });
    });

    it("is null when no liked essay pulls the candidate", () => {
      const fiveStar = rated("five", 5, { author: "Hurston", types: ["cultural"], title: "Five Star" });
      const unrelated = essay("unrelated", { author: "Other", types: ["travel"] });
      const [none] = rankRecommendations([unrelated], [fiveStar]);
      expect(none).toMatchObject({ score: 0, because: null });
    });
  });
});
