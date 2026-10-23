import { PGlite } from "@electric-sql/pglite";
import { fromPglite, migrate } from "@kcw/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as core from "../src/index";
import {
  CONTACT_NAMES_SQL,
  MAX_TITLE_LENGTH,
  PRIVATE_TITLE,
  VIOLATIONS,
  checkPublicTitle,
  createSanitizer,
  loadContactNames,
  type ContactNames,
  type Violation,
} from "../src/sanitize/index";

// Synthetic contacts only (AGENTS.md rule 1).
const CONTACTS: ContactNames[] = [
  { name: "Jane Doe", aliases: ["JD", "Janie"] },
  { name: "José Álvarez", aliases: ["Pepe"] },
  { name: "Zoë O'Brien", aliases: [] },
  { name: "Søren Łukasz", aliases: null },
  { name: "李小龍", aliases: ["Bruce"] },
];
const BLOCKLIST = ["tax return", "Therapy"];

const s = createSanitizer({ contacts: CONTACTS, blocklist: BLOCKLIST });

// [title, expected violations ([] = passes)]
const CASES: [string, Violation[]][] = [
  // passes
  ["Add a /healthz page that returns ok", []],
  ["Fix the essay reader on small screens", []],
  ["Show 3 new charts on the hub (v2)", []],
  ["Upgrade to Next 16, e.g. faster builds", []],
  ["Add year 2026 filter", []], // 4 digits is not a run > 4
  ["x".repeat(MAX_TITLE_LENGTH), []],
  ["Fix the @ sign in search", []], // a lone @ is neither an email nor a handle
  ["Make the docs page load faster", []], // "doe" is not a substring match: "docs" is fine

  // length and emptiness
  ["", ["empty"]],
  ["   ", ["empty"]],
  ["x".repeat(MAX_TITLE_LENGTH + 1), ["too_long"]],

  // non-ASCII
  ["Café menu page", ["non_ascii"]],
  ["Add dark mode 🌙", ["non_ascii"]],
  ["Fix lаyout", ["non_ascii"]], // Cyrillic a (homoglyph)
  ["Zero​width space", ["non_ascii"]],
  ["Line one\nline two", ["non_ascii"]],
  ["Tab\tinside", ["non_ascii"]],
  ["Non breaking space", ["non_ascii"]],

  // emails and handles
  ["Email someone@example.com about it", ["email", "url"]],
  ["Reply to a.b+c@sub.example.invalid", ["email", "url"]],
  ["Ping @someone on the PR", ["handle"]],
  ["Thanks @dev_42", ["handle"]],

  // URLs
  ["See https://example.com/page", ["url"]],
  ["Open http://localhost:3000", ["url"]],
  ["Mirror ftp://files", ["url"]],
  ["Link www.example", ["url"]],
  ["Add example.com to the list", ["url"]],
  ["Use foo.co.uk", ["url"]],
  ["Block 10.0.0.1", ["url"]],
  ["Port the Node.js script", ["url"]], // dotted words fail closed

  // phone numbers and digit runs
  ["Call 555-123-4567", ["phone"]],
  ["Call (555) 123 4567", ["phone"]],
  ["Call +1 555 123 4567", ["phone"]],
  ["Text 555.123.4567", ["phone"]],
  ["Call 5551234567", ["phone", "digit_run"]],
  ["Order 12345 arrived", ["digit_run"]],
  ["Ticket 2026-10-22", ["phone"]], // 8 digits with separators: fails closed

  // contact names and aliases (case-insensitive, per word, accent-folded)
  ["Plan Jane Doe birthday", ["contact"]],
  ["Plan jane's birthday", ["contact"]],
  ["Plan DOE party", ["contact"]],
  ["Ask JD about the hub", ["contact"]],
  ["Gift for janie", ["contact"]],
  ["Lunch with Jose", ["contact"]], // José folded to jose
  ["Lunch with ALVAREZ", ["contact"]],
  ["Call pepe", ["contact"]],
  ["Card for Zoe", ["contact"]], // Zoë
  ["Card for O'Brien", ["contact"]],
  ["Visit Soren", ["contact"]], // Søren
  ["Visit Lukasz", ["contact"]], // Łukasz
  ["Meet Bruce", ["contact"]],
  ["Write to JaneDoe", ["contact"]], // name written as one word
  ["Plan jane-doe page", ["contact"]],

  // blocklist (case-insensitive, normalized words, substring)
  ["File the Tax Return page", ["blocklist"]],
  ["Fix tax-returns import", ["blocklist"]],
  ["Book THERAPY slot", ["blocklist"]],

  // several at once, in VIOLATIONS order
  ["Email jane@example.com", ["email", "url", "contact"]],
  ["Ping @JD at 555 123 4567 or https://x.example", ["handle", "url", "phone", "contact"]],
];

describe("sanitize (§4.5)", () => {
  it.each(CASES)("%j -> %j", (title, expected) => {
    const r = s.check(title);
    expect(r.violations).toEqual(expected);
    expect(r.ok).toBe(expected.length === 0);
  });

  it("publicTitle returns the title when it passes, otherwise Private task", () => {
    expect(s.publicTitle("Add a /healthz page that returns ok")).toBe("Add a /healthz page that returns ok");
    expect(s.publicTitle("Plan Jane Doe birthday")).toBe(PRIVATE_TITLE);
    expect(s.publicTitle("Café")).toBe(PRIVATE_TITLE);
    expect(s.publicTitle(null)).toBe(PRIVATE_TITLE);
    expect(s.publicTitle(undefined)).toBe(PRIVATE_TITLE);
    expect(PRIVATE_TITLE).toBe("Private task");
  });

  it("the replacement itself passes the check", () => {
    expect(s.check(PRIVATE_TITLE).ok).toBe(true);
  });

  it("reasons are codes only and never quote the matched text", () => {
    const r = s.check("Plan Jane Doe birthday with someone@example.com");
    expect(r.violations.every((v) => (VIOLATIONS as readonly string[]).includes(v))).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/jane|doe|example/i);
  });

  it("works without contacts or blocklist", () => {
    expect(checkPublicTitle("Plan Jane Doe birthday", { contacts: [] }).ok).toBe(true);
    expect(checkPublicTitle("Book therapy slot", { contacts: [] }).ok).toBe(true);
    expect(checkPublicTitle("Call 555-123-4567", { contacts: [] }).violations).toEqual(["phone"]);
  });

  it("ignores empty blocklist terms and contacts whose words are all punctuation", () => {
    const t = createSanitizer({ contacts: [{ name: "--", aliases: [" "] }], blocklist: ["", "  ", "!!"] });
    expect(t.check("Add a page").ok).toBe(true);
  });

  it("is exported from @kcw/core", () => {
    expect(core.createSanitizer).toBe(createSanitizer);
    expect(core.PRIVATE_TITLE).toBe(PRIVATE_TITLE);
  });
});

describe("loadContactNames", () => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = new PGlite();
    const db = fromPglite(pg);
    await migrate(db);
    await db.query("INSERT INTO contacts (name, aliases, notes) VALUES ($1, $2, $3), ($4, DEFAULT, NULL)", [
      "Jane Doe",
      ["JD"],
      "private note",
      "Zoë O'Brien",
    ]);
  });
  afterAll(async () => {
    await pg.close();
  });

  it("reads names and aliases as orch_rw (column grants are enough)", async () => {
    await pg.exec("SET ROLE orch_rw");
    try {
      const contacts = await loadContactNames(fromPglite(pg));
      expect(contacts).toEqual(
        expect.arrayContaining([
          { name: "Jane Doe", aliases: ["JD"] },
          { name: "Zoë O'Brien", aliases: [] },
        ]),
      );
      expect(contacts).toHaveLength(2);
      expect(createSanitizer({ contacts }).publicTitle("Ask jd")).toBe(PRIVATE_TITLE);
      // orch_rw still cannot read other contact columns.
      await expect(pg.query("SELECT notes FROM contacts")).rejects.toThrow(/permission denied/);
    } finally {
      await pg.exec("RESET ROLE");
    }
  });

  it("queries only name and aliases", () => {
    expect(CONTACT_NAMES_SQL).toBe("SELECT name, aliases FROM contacts");
  });
});
