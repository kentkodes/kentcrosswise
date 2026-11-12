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
    expect(names.length).toBe(7);
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

describe("clean essay text", () => {
  it("removes every stripped pattern from the dirty fixture", () => {
    const x = extractGutenbergText(read("dirty.txt"));
    expect(x).toMatchObject({ hasStart: true, hasEnd: true });
    expect(x.text.startsWith("Of Studies\nby Francis Bacon\n\nStudies serve for delight")).toBe(true);
    expect(x.text).not.toMatch(/\[\s*(?:Illustration|Image|Picture|Figure|Frontispiece|Sidenote|Transcriber|Editor)/i);
    expect(x.text).not.toMatch(/Transcriber|Synthetic Test Volunteers|Produced by|Transcribed from/i);
    expect(x.text).not.toMatch(/\[\s*(?:Pg|Page|p\.)\s*\d/i);
    expect(x.text).not.toMatch(/\{\d+\}/);
    expect(x.text).not.toContain("*");
    expect(x.text).not.toMatch(/[\u00AD\u200B-\u200D\u2060\uFEFF]/);
    expect(x.text).not.toContain("Synthetic footer");
    expect(verdict(read("dirty.txt"))).toEqual({ ok: true });
  });

  it("keeps the author's footnote markers and the footnote text", () => {
    const { text } = extractGutenbergText(read("dirty.txt"));
    expect(text).toContain("contend.[1]\n");
    expect(text).toContain("wit[A], but");
    expect(text.endsWith("[12] Cymini sectores: literally, cumin-seed cutters; a scornful name for pedants.\n")).toBe(true);
  });

  it("keeps emphasis words without their marks, and tokens with inner underscores or equals", () => {
    const { text } = extractGutenbergText(read("dirty.txt"));
    expect(text).toContain("use for delight, is in privateness");
    expect(text).toContain("The bold word and the token a_b,\nlike snake_case, stay as written.");
    expect(text).toContain("to prove and illustrate another\nthing, and to hold it fast, let him study");
    expect(text).not.toMatch(/_delight_|=bold=/);
  });

  it("turns the separator row into exactly one paragraph break", () => {
    const { text } = extractGutenbergText(read("dirty.txt"));
    expect(text).toContain("affairs, come best, from those that are learned.\n\nTo spend too much time");
    expect(text).not.toMatch(/\n{3,}/);
  });

  const inner = (body: string) => `*** START OF THE PROJECT GUTENBERG EBOOK X ***\n${body}\n*** END OF THE PROJECT GUTENBERG EBOOK X ***`;
  const cleaned = (body: string) => extractGutenbergText(inner(body)).text;

  it("joins words around an inline placeholder with one space", () => {
    expect(cleaned("The study [Illustration] of the ship.")).toBe("The study of the ship.\n");
    expect(cleaned("The study  [Image: a ship]  of the sea.")).toBe("The study of the sea.\n");
    expect(cleaned("Histories [Figure 3] poets witty.")).toBe("Histories poets witty.\n");
  });

  it("treats a placeholder on its own line as a blank line", () => {
    expect(cleaned("Alpha\n[Illustration]\nBeta")).toBe("Alpha\n\nBeta\n");
    expect(cleaned("Alpha\n\n[Frontispiece: a ruin]\n\nBeta")).toBe("Alpha\n\nBeta\n");
  });

  it("keeps numeric, letter and mixed footnote markers", () => {
    expect(cleaned("Note[12] here and [1] there, [A] too.")).toBe("Note[12] here and [1] there, [A] too.\n");
  });

  it("drops bracketed notes that span lines and hold a nested bracket", () => {
    expect(cleaned("Text.\n[Transcriber's Note: a line\n[sic] more\nend.]\nAfter.")).toBe("Text.\n\nAfter.\n");
    expect(cleaned("Text.\n[Editor’s note: changed.]\n\nAfter.")).toBe("Text.\n\nAfter.\n");
  });

  it("drops an unbracketed transcriber heading to the next blank line", () => {
    expect(cleaned("Transcriber’s Notes: a line\nand its continuation\n\nKept.")).toBe("Kept.\n");
    expect(cleaned("Transcriber's Note\nKept.")).toBe("");
  });

  it("drops a credit paragraph only where it starts a paragraph", () => {
    expect(cleaned("Produced by someone\nat a press\n\nBody.")).toBe("Body.\n");
    expect(cleaned("This eBook was produced by someone.\n\nBody.")).toBe("Body.\n");
    expect(cleaned("Hello there.\nProduced by someone\n\nLater.")).toBe("Hello there.\nProduced by someone\n\nLater.\n");
  });

  it("removes soft hyphens and zero-width characters", () => {
    expect(cleaned("co\u00ADmpany a\u200Bb\u2060c\uFEFFd")).toBe("company abcd\n");
  });

  it("removes emphasis marks only where they wrap word characters", () => {
    expect(cleaned("_word_ and _several words here_, =bold=, snake_case, a_b, x = y, __init__")).toBe(
      "word and several words here, bold, snake_case, a_b, x = y, __init__\n",
    );
  });

  it("turns separator rows into one break and keeps prose with dashes", () => {
    expect(cleaned("First.\n-----\nSecond.\n\n* * *\n\n\n = = =\nThird.\n\na - b")).toBe("First.\n\nSecond.\n\nThird.\n\na - b\n");
  });

  it("still rejects replacement characters after cleaning", () => {
    const words = Array.from({ length: 320 }, (_, i) => `w${i}`).join(" ");
    expect(verdict(inner(`${words} [Illustration] �`))).toEqual({ ok: false, reasons: ["bad_characters"] });
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
    expect(decodeUtf8(Uint8Array.from([0xef, 0xbb, 0xbf, 0x61]))).toBe("\uFEFFa");
  });
});
