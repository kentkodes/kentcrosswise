import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isMetadataDuplicate, MINHASH_SIZE, minhash, minhashSimilarity, normalizeForHash, normalizedTextHash,
} from "../src/validate/duplicates";

const BASE = readFileSync(new URL("./fixtures/gutenberg-text/essay.txt", import.meta.url), "utf8");
// Two unrelated word streams: no shared 5-shingle, so their similarity should be near zero.
const streamA = Array.from({ length: 400 }, (_, i) => `w${(i * i * 7 + 3) % 997}`).join(" ");
const streamB = Array.from({ length: 400 }, (_, i) => `v${(i * i * 13 + 11) % 991}`).join(" ");

describe("normalization and the exact hash", () => {
  it("drops case, punctuation and whitespace differences", () => {
    expect(normalizeForHash("  Of   Studies,\n  by Francis Bacon!  ")).toBe("of studies by francis bacon");
    expect(normalizedTextHash("Of Studies, by Francis Bacon.")).toBe(normalizedTextHash("of studies by FRANCIS bacon"));
    expect(normalizedTextHash("Of Studies")).not.toBe(normalizedTextHash("Of Truth"));
  });

  it("applies NFKC before lowercasing (compatibility forms hash equal)", () => {
    expect(normalizedTextHash("ﬁne words")).toBe(normalizedTextHash("fine words")); // "ﬁ" ligature
  });

  it("ignores the case and line breaks of a whole text", () => {
    expect(normalizedTextHash(BASE)).toBe(normalizedTextHash(BASE.replace(/\s+/g, " ").toUpperCase()));
  });
});

describe("minhash", () => {
  it("is deterministic and has MINHASH_SIZE signed 32-bit integers", () => {
    const a = minhash(BASE);
    expect(a).toHaveLength(MINHASH_SIZE);
    expect(minhash(BASE)).toEqual(a);
    for (const v of a) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(-(2 ** 31));
      expect(v).toBeLessThanOrEqual(2 ** 31 - 1);
      expect(v | 0).toBe(v);
    }
  });

  it("gives similarity 1 for identical text and ignores case and punctuation", () => {
    expect(minhashSimilarity(minhash(BASE), minhash(BASE))).toBe(1);
    expect(minhashSimilarity(minhash(BASE), minhash(BASE.toUpperCase()))).toBe(1);
  });

  it("gives a small edit to a long text at least the near-duplicate threshold", () => {
    const edited = BASE.replace("Studies serve", "Studies truly serve");
    expect(edited).not.toBe(BASE);
    expect(minhashSimilarity(minhash(BASE), minhash(edited))).toBeGreaterThanOrEqual(0.9);
  });

  it("gives unrelated texts a similarity below 0.5", () => {
    expect(minhashSimilarity(minhash(streamA), minhash(streamB))).toBeLessThan(0.5);
    expect(minhashSimilarity(minhash(BASE), minhash(streamA))).toBeLessThan(0.5);
  });

  it("handles texts under five words (one shingle) and the similarity edge cases", () => {
    expect(minhash("one two three")).toEqual(minhash("One, two three!"));
    expect(minhashSimilarity(minhash("one two three"), minhash("four five six"))).toBe(0);
    expect(minhashSimilarity([], [])).toBe(0);
    expect(minhashSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });
});

describe("isMetadataDuplicate", () => {
  const bacon = "Francis Bacon";
  it("matches the same work written differently by the same author", () => {
    expect(isMetadataDuplicate({ title: "Of Studies", author: bacon }, { title: "of studies.", author: bacon })).toBe(true);
    expect(
      isMetadataDuplicate(
        { title: "Self-Reliance", author: "Emerson, Ralph Waldo" },
        { title: "Self-Reliance", author: "Ralph Waldo Emerson" },
      ),
    ).toBe(true);
    expect(
      isMetadataDuplicate(
        { title: "Of Studies", author: "Emerson, Ralph Waldo" },
        { title: "Of Studies", author: "Ralph Waldo Emerson" },
      ),
    ).toBe(true);
  });

  it("does not match different works by the same author, or the same title by different authors", () => {
    expect(isMetadataDuplicate({ title: "Of Studies", author: bacon }, { title: "Of Truth", author: bacon })).toBe(false);
    // The closest distinct same-author pair in the approved seed list (0.861) stays below the threshold.
    expect(
      isMetadataDuplicate(
        { title: "Politics vs. Literature: An Examination of Gulliver's Travels", author: "George Orwell" },
        { title: "Politics and the English Language", author: "George Orwell" },
      ),
    ).toBe(false);
    expect(isMetadataDuplicate({ title: "Of Cannibals", author: "Michel de Montaigne" }, { title: "Of Cannibales", author: "Montaigne, Michel de" })).toBe(true);
    expect(isMetadataDuplicate({ title: "Of Studies", author: bacon }, { title: "Of Studies", author: "Michel de Montaigne" })).toBe(false);
  });

  it("does not match when either title is empty after normalization", () => {
    expect(isMetadataDuplicate({ title: "", author: bacon }, { title: "", author: bacon })).toBe(false);
  });
});
