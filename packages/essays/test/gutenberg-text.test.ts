import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractGutenbergText } from "../src/extract/gutenberg-text";
import { bookDir, decodeUtf8, parseBookId, pickTextFile } from "../src/fetch/gutenberg-path";
import { validateExtraction } from "../src/validate/basic";

const DIR = new URL("./fixtures/gutenberg-text/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, DIR), "utf8");
const verdict = (raw: string) => validateExtraction(extractGutenbergText(raw));

describe("fixtures", () => {
  it("each text fixture carries a public-domain provenance line", () => {
    const names = readdirSync(DIR).filter((n) => n.endsWith(".txt"));
    expect(names.length).toBe(6);
    for (const n of names) expect(read(n)).toMatch(/^Provenance: .*public-domain/);
  });
});

describe("extractGutenbergText", () => {
  it("keeps only the body between the markers and keeps paragraph breaks", () => {
    const x = extractGutenbergText(read("essay.txt"));
    expect(x).toMatchObject({ hasStart: true, hasEnd: true });
    expect(x.text.startsWith("Of Studies\nby Francis Bacon\n\nStudies serve for delight")).toBe(true);
    expect(x.text.endsWith("special receipt.\n")).toBe(true);
    expect(x.text).not.toMatch(/Provenance|Title:|PROJECT GUTENBERG|Synthetic footer/);
    expect(x.text.split("\n\n").length).toBeGreaterThanOrEqual(8);
    expect(x.wordCount).toBeGreaterThanOrEqual(300);
    expect(verdict(read("essay.txt"))).toEqual({ ok: true });
  });

  it("strips a BOM and normalizes CRLF and CR to the same text", () => {
    const lf = read("essay.txt");
    const crlf = String.fromCharCode(0xfeff) + lf.replace(/\n/g, "\r\n");
    const cr = lf.replace(/\n/g, "\r");
    const base = extractGutenbergText(lf);
    expect(extractGutenbergText(crlf)).toEqual(base);
    expect(extractGutenbergText(cr)).toEqual(base);
  });

  it("collapses extra blank lines and trailing spaces", () => {
    const raw = "*** START OF THE PROJECT GUTENBERG EBOOK X ***\n\n\n\nOne  \nTwo\n\n\n\n\nThree\t\n\n\n*** END OF THE PROJECT GUTENBERG EBOOK X ***";
    expect(extractGutenbergText(raw).text).toBe("One\nTwo\n\nThree\n");
  });

  it("handles legacy marker wording", () => {
    const x = extractGutenbergText(read("legacy.txt"));
    expect(x).toMatchObject({ hasStart: true, hasEnd: true });
    expect(x.text).not.toMatch(/Project Gutenberg|Synthetic footer/i);
    expect(x.text).toBe(extractGutenbergText(read("essay.txt")).text);
    const smallPrint = "Etext header\n*END*THE SMALL PRINT! FOR PUBLIC DOMAIN ETEXTS*Ver.04.29.93*END*\nBody line\nEnd of the Project Gutenberg Etext of X\n";
    expect(extractGutenbergText(smallPrint)).toMatchObject({ text: "Body line\n", hasStart: true, hasEnd: true });
  });

  it("reports missing markers without inventing a body", () => {
    expect(extractGutenbergText("just some text")).toEqual({ text: "", wordCount: 0, hasStart: false, hasEnd: false });
    expect(extractGutenbergText(read("truncated.txt"))).toMatchObject({ hasStart: true, hasEnd: false });
  });
});

describe("validateExtraction", () => {
  it("rejects a truncated text (no end marker)", () => {
    expect(verdict(read("truncated.txt"))).toEqual({ ok: false, reasons: ["missing_end_marker"] });
  });
  it("rejects replacement characters", () => {
    expect(verdict(read("replacement.txt"))).toEqual({ ok: false, reasons: ["bad_characters"] });
  });
  it("rejects a stub", () => {
    expect(verdict(read("stub.txt"))).toEqual({ ok: false, reasons: ["too_short"] });
  });
  it("rejects a residual license block", () => {
    expect(verdict(read("license-residue.txt"))).toEqual({ ok: false, reasons: ["license_residue"] });
  });
  it("rejects a text with no markers at all", () => {
    expect(verdict("hello")).toEqual({ ok: false, reasons: ["missing_start_marker", "missing_end_marker"] });
  });
  it("rejects control characters and HTML tags but not prose with angle brackets", () => {
    const wrap = (s: string) => `*** START OF THE PROJECT GUTENBERG EBOOK X ***\n${s}\n*** END OF THE PROJECT GUTENBERG EBOOK X ***`;
    const words = Array.from({ length: 320 }, (_, i) => `w${i}`).join(" ");
    expect(verdict(wrap(words))).toEqual({ ok: true });
    expect(verdict(wrap(`${words} \u0007`))).toEqual({ ok: false, reasons: ["bad_characters"] });
    expect(verdict(wrap(`${words} <p>x</p>`))).toEqual({ ok: false, reasons: ["html_tags"] });
    expect(verdict(wrap(`${words} when a<b and c>d`))).toEqual({ ok: true });
  });
  it("has no language heuristic and no upper word limit", () => {
    const wrap = (s: string) => `*** START OF THE PROJECT GUTENBERG EBOOK X ***\n${s}\n*** END OF THE PROJECT GUTENBERG EBOOK X ***`;
    expect(verdict(wrap(Array.from({ length: 70_000 }, () => "ne").join(" ")))).toEqual({ ok: true });
  });
  it("accepts exactly 300 words and refuses 299", () => {
    const wrap = (n: number) =>
      `*** START OF THE PROJECT GUTENBERG EBOOK X ***\n${Array.from({ length: n }, () => "a").join(" ")}\n*** END OF THE PROJECT GUTENBERG EBOOK X ***`;
    expect(verdict(wrap(300))).toEqual({ ok: true });
    expect(verdict(wrap(299))).toEqual({ ok: false, reasons: ["too_short"] });
  });
});

describe("mirror paths", () => {
  it("maps book ids to main-collection directories", () => {
    expect(bookDir(12345)).toBe("1/2/3/4/12345/");
    expect(bookDir(1)).toBe("0/1/");
    expect(bookDir(9)).toBe("0/9/");
    expect(bookDir(10)).toBe("1/10/");
    expect(bookDir(1342)).toBe("1/3/4/1342/");
    expect(bookDir(9_999_999)).toBe("9/9/9/9/9/9/9999999/");
    for (const bad of [0, -1, 1.5, 10_000_000, Number.NaN]) expect(() => bookDir(bad)).toThrow("invalid_book_id");
  });
  it("accepts only plain book ids", () => {
    expect(parseBookId("1342")).toBe(1342);
    for (const bad of ["", "0", "01", "12345678", "12a", "1 2", "../1", "-1", "1e3"]) expect(parseBookId(bad)).toBeNull();
  });
  it("prefers <id>-0.txt, then <id>.txt, and never the latin-1 -8.txt", () => {
    expect(pickTextFile(["1342.txt", "1342-0.txt", "1342-8.txt"], 1342)).toBe("1342-0.txt");
    expect(pickTextFile(["1342.txt", "1342-8.txt"], 1342)).toBe("1342.txt");
    expect(pickTextFile(["1342-8.txt"], 1342)).toBeNull();
    expect(pickTextFile(["1342-h.htm", "other.txt", "13420.txt"], 1342)).toBeNull();
    expect(pickTextFile([], 1342)).toBeNull();
  });
  it("decodes strictly as UTF-8", () => {
    expect(decodeUtf8(new TextEncoder().encode("café"))).toBe("café");
    expect(decodeUtf8(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]))).toBeNull(); // latin-1 e-acute
    expect(decodeUtf8(Uint8Array.from([0xef, 0xbb, 0xbf, 0x61]))).toBe("﻿a");
  });
});
