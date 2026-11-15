import { describe, expect, it } from "vitest";
import { DEMO_ESSAYS, DEMO_ESSAY_RATINGS, lengthBand, readingMinutes, recommend } from "../src/index";

describe("demo essays", () => {
  it("has 5 or 6 link-only essays with source links and short original hooks", () => {
    expect(DEMO_ESSAYS.length).toBeGreaterThanOrEqual(5);
    expect(DEMO_ESSAYS.length).toBeLessThanOrEqual(6);
    for (const e of DEMO_ESSAYS) {
      expect(e.sourceUrl).toBe(`https://www.gutenberg.org/ebooks/${e.id}`);
      expect(e.hookWrittenForDemo).toBe(true);
      expect(e.hook.length).toBeLessThanOrEqual(120);
      expect(e.hook).not.toContain(e.title);
      expect(e.hook).not.toContain(e.author);
      expect(e.year === null || /^\d{4}$/.test(String(e.year))).toBe(true);
    }
  });

  it("shows a mix of types and all three length bands", () => {
    expect(new Set(DEMO_ESSAYS.map((e) => lengthBand(e.words)))).toEqual(new Set(["Short", "Medium", "Long"]));
    expect(new Set(DEMO_ESSAYS.map((e) => e.type)).size).toBeGreaterThanOrEqual(4);
  });

  it("bands and reading time follow the SPEC and the 230 wpm constant", () => {
    expect(lengthBand(1999)).toBe("Short");
    expect(lengthBand(2000)).toBe("Medium");
    expect(lengthBand(5999)).toBe("Medium");
    expect(lengthBand(6000)).toBe("Long");
    expect(readingMinutes(612)).toBe(3);
    expect(readingMinutes(12114)).toBe(53);
    expect(readingMinutes(1)).toBe(1);
  });

  it("recommends an unrated essay that follows a liked one, deterministically", () => {
    const rec = recommend();
    expect(rec).toEqual(recommend());
    expect(rec).not.toBeNull();
    const rated = DEMO_ESSAY_RATINGS.map((r) => r.essayId);
    expect(rated).not.toContain(rec?.essayId);
    expect(rated).toContain(rec?.likedId);
    expect(rec?.essayId).toBe("78663");
    expect(rec?.likedId).toBe("3172");
  });

  it("recommends nothing when nothing is liked", () => {
    expect(recommend(DEMO_ESSAYS, [{ essayId: "3172", stars: 2 }])).toBeNull();
  });
});
