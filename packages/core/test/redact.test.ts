import { describe, expect, it } from "vitest";
import { REDACT_FAILURES, createRecordRedactor, type ContactNames, type RedactResult } from "../src/sanitize/index";

// Synthetic contacts only (AGENTS.md rule 1).
const CONTACTS: ContactNames[] = [
  { name: "Jane Doe", aliases: ["Janie"] },
  { name: "José Álvarez", aliases: ["Pepe"] },
  { name: "Mara Quill", aliases: null },
];
const BLOCKLIST = ["tax return"];

const redactor = () => createRecordRedactor({ contacts: CONTACTS, blocklist: BLOCKLIST });
const text = (r: RedactResult) => (r.ok ? r.text : `withheld:${r.reason}`);

describe("createRecordRedactor: people", () => {
  it("replaces a contact's full name with one filler", () => {
    expect(text(redactor().redact("Lunch with Jane Doe on Friday"))).toBe("Lunch with [Person 1] on Friday");
  });

  it("replaces every word of a contact's name and aliases, folding case and accents", () => {
    const r = redactor();
    expect(text(r.redact("jane said hi, then JOSE and pepe left"))).toBe("[Person 1] said hi, then [Person 2] and [Person 2] left");
    expect(text(r.redact("janedoe wrote back"))).toBe("[Person 1] wrote back");
  });

  it("keeps a person's filler stable across fields of one record and numbers new people in order", () => {
    const r = redactor();
    expect(text(r.redact("Mara called"))).toBe("[Person 1] called");
    expect(text(r.redact("Jane and Mara"))).toBe("[Person 2] and [Person 1]");
  });

  it("starts numbering again for a new record", () => {
    redactor().redact("Mara and Jane");
    expect(text(redactor().redact("Jane"))).toBe("[Person 1]");
  });

  it("replaces names the contact list does not know when they come in as terms, including lowercase ones", () => {
    const r = redactor();
    expect(text(r.redact("lunch with sam next tuesday", { people: ["sam"] }))).toBe("lunch with [Person 1] next tuesday");
    // a term given for one field is also replaced in later fields of the record
    expect(text(r.redact("Sam liked it"))).toBe("[Person 1] liked it");
  });

  it("treats every word of a multi-word term as that person", () => {
    const r = redactor();
    expect(text(r.redact("Met Sam Lee. Later Lee called", { people: ["Sam Lee"] }))).toBe("Met [Person 1]. Later [Person 1] called");
  });

  it("joins a term to a contact it shares a word with", () => {
    expect(text(redactor().redact("Jane D. and Jane", { people: ["Jane D."] }))).toBe("[Person 1]. and [Person 1]");
  });

  it("ignores a term that is not in the text and empty terms", () => {
    expect(text(redactor().redact("A quiet day", { people: ["Nobody", "", "  "], places: [""] }))).toBe("A quiet day");
  });

  it("catches a name split by an invisible character", () => {
    expect(text(redactor().redact("Ja​ne came by"))).toBe("[Person 1] came by");
  });
});

describe("createRecordRedactor: places", () => {
  it("replaces a place as a whole phrase, every time it appears", () => {
    const r = redactor();
    expect(text(r.redact("Coffee at Blue Door Cafe, then back to blue door cafe", { places: ["Blue Door Cafe"] }))).toBe(
      "Coffee at [place], then back to [place]",
    );
    expect(text(r.redact("The door was blue"))).toBe("The door was blue");
    expect(text(r.redact("Blue Door Cafe again"))).toBe("[place] again");
  });

  it("lets a person win over a place that overlaps it", () => {
    expect(text(redactor().redact("Mara's shop", { places: ["Mara"] }))).toBe("[Person 1]'s shop");
  });
});

describe("createRecordRedactor: identifiers", () => {
  const cases: [string, string][] = [
    ["Email a.b+c@example.com today", "Email [email] today"],
    ["Email someone＠example.com", "Email [email]"], // full-width @ is normalized first
    ["See https://example.com/x?y=1 and www.example.org", "See [link] and [link]"],
    ["Read about Node.js", "Read about [link]"],
    ["(see example.com/a/b, then)", "(see [link] then)"],
    ["Server at 10.0.0.12", "Server at [link]"],
    ["Ping @dev_42 and @Ünal", "Ping [handle] and [handle]"],
    ["Call +1 (555) 012-3456 later", "Call [phone] later"],
    ["Order 123456 shipped", "Order [number] shipped"],
    ["Meet at 3pm in 2026, room 12", "Meet at 3pm in 2026, room 12"],
    ["Due 2026-11-17 10:30", "Due 2026-11-17 10:30"],
    ["Due 12/04/2026, 9:15", "Due 12/04/2026, 9:15"],
    ["Already public: [Person 1] and [place]", "Already public: [Person 1] and [place]"],
    ["Line one\nLine two\tok", "Line one\nLine two\tok"],
    ["Café crème with Zoë", "Café crème with Zoë"],
  ];
  it.each(cases)("%j", (input, expected) => {
    expect(text(redactor().redact(input))).toBe(expected);
  });

  it("joins an email that holds a contact's name into one placeholder", () => {
    expect(text(redactor().redact("Write to jane.doe@example.com"))).toBe("Write to [email]");
  });
});

describe("createRecordRedactor: withholds", () => {
  it("withholds a record with a blocklisted term", () => {
    expect(redactor().redact("Finish the tax returns")).toEqual({ ok: false, reason: "blocklist" });
  });

  it("withholds control characters other than tab and line breaks", () => {
    expect(redactor().redact("bell\u0007here")).toEqual({ ok: false, reason: "control" });
  });

  it("withholds a word that mixes Latin with Cyrillic or Greek letters (lookalikes)", () => {
    expect(redactor().redact("Jаne came by")).toEqual({ ok: false, reason: "mixed_script" }); // Cyrillic a
    expect(redactor().redact("Μara came by")).toEqual({ ok: false, reason: "mixed_script" }); // Greek M + Latin "ara"
    expect(redactor().redact("Μαρα came by")).toEqual({ ok: true, text: "Μαρα came by" }); // all Greek: not mixed
  });

  it("returns fixed codes only, never text", () => {
    const r = redactor().redact("Finish the tax return for Jane");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(REDACT_FAILURES).toContain(r.reason);
    expect(JSON.stringify(r)).not.toMatch(/jane|tax/i);
  });

  it("withholds instead of throwing on unexpected input", () => {
    // @ts-expect-error a non-string field
    expect(redactor().redact(undefined)).toEqual({ ok: false, reason: "error" });
  });
});

describe("createRecordRedactor: output never holds what a rule replaces", () => {
  const inputs = [
    "Jane Doe and José met Sam at Blue Door Cafe; mail jd@example.com or call 555-012-3456.",
    "janie, PEPE, mara quill, alvarez, sam, @sam_l, https://x.example/a",
    "Notes: Doe 99999 Quill",
  ];
  it.each(inputs)("%j", (input) => {
    const r = redactor().redact(input, { people: ["Sam"], places: ["Blue Door Cafe"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).not.toMatch(/jane|doe|jos[eé]|alvarez|pepe|mara|quill|sam|blue door|@|example|\d{5,}|555/i);
  });
});
