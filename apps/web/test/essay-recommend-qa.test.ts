// QA probes for E3 (essay recommendations): length-answer ties, link answers and `because` with pushes. Pure: no database.
import { describe, expect, it } from "vitest";
import { rankRecommendations, type EssayMeta, type RatedEssay } from "../src/server/essay-recommend";

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
const scoreMap = (candidates: EssayMeta[], history: RatedEssay[]) =>
  Object.fromEntries(rankRecommendations(candidates, history).map((r) => [r.id, r.score]));

describe("QA probes: E3 length answer", () => {
  const short = essay("short", { lengthBand: "short" });
  const medium = essay("medium", { lengthBand: "medium" });
  const long = essay("long", { lengthBand: "long" });
  const link = essay("link", { kind: "link" });
  const all = [short, medium, long, link];

  it("breaks a tie on ratedAt by the larger id (too_long on 'b' beats too_short on 'a')", () => {
    const a = rated("a", 3, { lengthBand: "medium", lengthFelt: "too_short", ratedAt: 5 * day });
    const b = rated("b", 3, { lengthBand: "medium", lengthFelt: "too_long", ratedAt: 5 * day });
    expect(scoreMap(all, [a, b])).toEqual({ short: 0, medium: -1, long: -1, link: 0 });
    expect(scoreMap(all, [b, a])).toEqual({ short: 0, medium: -1, long: -1, link: 0 });
  });

  it("a link's length answer (no band) does not clear an earlier full-text length answer", () => {
    const fullTooLong = rated("full", 3, { lengthBand: "medium", lengthFelt: "too_long", ratedAt: 1 * day });
    const linkTooShort = rated("linkRated", 3, { kind: "link", lengthBand: null, lengthFelt: "too_short", ratedAt: 2 * day });
    expect(scoreMap(all, [fullTooLong, linkTooShort])).toEqual({ short: 0, medium: -1, long: -1, link: 0 });
  });
});

describe("QA probes: E3 because and push", () => {
  it("names the pulling liked essay even when a disliked essay pushes the same candidate down", () => {
    const liked = rated("liked", 5, { author: "Hurston", types: ["cultural"], title: "Liked" });
    const bad = rated("bad", 1, { author: "Other", types: ["cultural"], title: "Bad" });
    const [out] = rankRecommendations([essay("c", { author: "Hurston", types: ["cultural"] })], [liked, bad]);
    expect(out!.because).toEqual({ id: "liked", title: "Liked", author: "Hurston" });
    // pull 2 x (3 + 2) = 10, push 1 star: -(-2) x 3 = 6, score 4.
    expect(out!.score).toBe(4);
  });

  it("gives because only from liked essays, not from a 4-star essay whose tag is the only link", () => {
    // A 4-star essay with 'humor' pulls a comedic candidate by 1 x (0 + 1) = 1, and it is named.
    const [out] = rankRecommendations([essay("c", { types: ["comedic"], author: "X" })], [rated("four", 4, { worked: ["humor"], title: "Four", author: "Y" })]);
    expect(out!.because).toEqual({ id: "four", title: "Four", author: "Y" });
    expect(out!.score).toBe(1);
  });

  it("a candidate pushed below zero by a 1-star essay with no pull has because null", () => {
    const [out] = rankRecommendations([essay("c", { author: "Woolf", types: ["cultural"] })], [rated("bad", 1, { author: "Woolf", types: ["cultural"] })]);
    // 1 star: weight -2 x (author 2 + type 3) = -10.
    expect(out).toMatchObject({ score: -10, because: null });
  });
});
