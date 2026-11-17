// Replace mode of the public sanitizer (DESIGN §4.5 item 8, §4.6): turns one record's private text into
// public text by replacing personal identifiers with bracketed placeholders, or withholds the record.
//
// Deterministic rules find emails, links, handles, phone numbers, long digit runs and contact names.
// Names the contact list does not know, and specific places, come in as `terms` (proposed by a bounded
// model call or added by the owner on the review screen). Terms can only add replacements: nothing a
// caller passes can keep a deterministic match from being replaced. After replacing, the output is
// checked again with every rule; any hit, any error and any blocklisted term withholds the record.
// Results carry fixed failure codes only, never a piece of the text.

import type { ContactNames, SanitizerOptions } from "./index";
import { EMAIL, PHONE_MIN_DIGITS, URL_PATTERNS, fold, words } from "./patterns";

/** The placeholders public text may contain. People are numbered per record: `[Person 1]`, `[Person 2]`. */
export const PLACEHOLDERS = ["Person n", "place", "email", "link", "handle", "phone", "number"] as const;

/** Why a record was withheld. Codes only: never a piece of the (private) text. */
export const REDACT_FAILURES = ["control", "mixed_script", "blocklist", "recheck", "error"] as const;
export type RedactFailure = (typeof REDACT_FAILURES)[number];

export type RedactResult = { ok: true; text: string } | { ok: false; reason: RedactFailure };

/** Extra replacements for one field: exact mentions as they appear in the text. */
export interface RedactTerms {
  /** People's names (each word of a name is replaced wherever it appears in the record). */
  people?: readonly string[];
  /** Specific places, workplaces and addresses (replaced as whole phrases). */
  places?: readonly string[];
}

export interface RecordRedactor {
  /**
   * Public text for one field of the record. People keep the same filler across every field redacted
   * by this redactor, and a person term given for one field is also replaced in later fields.
   */
  redact(text: string, terms?: RedactTerms): RedactResult;
}

type Kind = "email" | "link" | "handle" | "phone" | "number" | "person" | "place";
// Which placeholder wins when two matches overlap.
const PRIORITY: Readonly<Record<Kind, number>> = { email: 7, link: 6, handle: 5, phone: 4, number: 3, person: 2, place: 1 };

interface Span {
  start: number;
  end: number;
  kind: Kind;
  /** For people: the identity that picks the filler number. */
  who?: string;
}

interface Token {
  start: number;
  end: number;
  folded: string;
}

// Global, Unicode-aware forms of the shared patterns (the title check is ASCII-only; public log text is not).
const EMAIL_G = new RegExp(EMAIL.source, "g");
const URL_G = URL_PATTERNS.map((re) => new RegExp(re.source, "gi"));
const HANDLE_G = /@[\p{L}\p{N}_]+/gu;
const PHONE_G = /\+?\(?\p{Nd}[\p{Nd}\s().\-/]*\p{Nd}/gu;
const NUMBER_G = /\p{Nd}{5,}/gu;
const TOKEN_G = /[\p{L}\p{N}]+/gu;
// Dates and clock times are not phone numbers ("2026-11-17", "12/04/2026", "10:30"): masked before the phone rule.
const DATE_TIME_G = /\b\p{Nd}{4}-\p{Nd}{1,2}-\p{Nd}{1,2}\b|\b\p{Nd}{1,2}[/.]\p{Nd}{1,2}[/.]\p{Nd}{2,4}\b|\b\p{Nd}{1,2}:\p{Nd}{2}\b/gu;
/** C0/C1 controls other than tab, line feed and carriage return. */
function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}
const LATIN = /\p{Script=Latin}/u;
const LOOKALIKE_SCRIPT = /[\p{Script=Cyrillic}\p{Script=Greek}]/u;
const PLACEHOLDER_G = /\[(?:Person \d+|place|email|link|handle|phone|number)\]/g;

/** NFKC (full-width and compatibility forms become plain ones) and no invisible format characters. */
function normalize(text: string): string {
  return text.normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/\r\n?/g, "\n");
}

function tokens(text: string): Token[] {
  return [...text.matchAll(TOKEN_G)].map((m) => ({ start: m.index, end: m.index + m[0].length, folded: fold(m[0]) }));
}

function digitCount(s: string): number {
  return s.match(/\p{Nd}/gu)?.length ?? 0;
}

function patternSpans(text: string): Span[] {
  const out: Span[] = [];
  const add = (re: RegExp, kind: Kind) => {
    for (const m of text.matchAll(re)) out.push({ start: m.index, end: m.index + m[0].length, kind });
  };
  add(EMAIL_G, "email");
  // A link covers the whole run of non-space characters around the match (scheme, host, path, query).
  for (const re of URL_G) {
    for (const m of text.matchAll(re)) {
      let start = m.index;
      let end = m.index + m[0].length;
      while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
      while (end < text.length && !/\s/.test(text[end]!)) end++;
      out.push({ start, end, kind: "link" });
    }
  }
  add(HANDLE_G, "handle");
  const masked = text.replace(DATE_TIME_G, (m) => " ".repeat(m.length));
  for (const m of masked.matchAll(PHONE_G)) {
    if (digitCount(m[0]) >= PHONE_MIN_DIGITS) out.push({ start: m.index, end: m.index + m[0].length, kind: "phone" });
  }
  add(NUMBER_G, "number");
  return out;
}

/** Overlapping spans become one (the higher-priority kind wins); a run of the same person joined by spaces becomes one. */
function merge(spans: Span[], text: string): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) {
      if (PRIORITY[s.kind] > PRIORITY[last.kind]) {
        last.kind = s.kind;
        last.who = s.who;
      }
      last.end = Math.max(last.end, s.end);
      continue;
    }
    if (last && s.kind === last.kind && s.who === last.who && (s.kind === "person" || s.kind === "place") && /^[ \t]+$/.test(text.slice(last.end, s.start))) {
      last.end = s.end;
      continue;
    }
    out.push({ ...s });
  }
  return out;
}

/** Folded word sequences of a phrase; empty phrases are dropped. */
function phrase(term: string): string[] {
  return words(term);
}

function findPhrase(toks: Token[], ws: readonly string[]): { start: number; end: number }[] {
  const hits: { start: number; end: number }[] = [];
  if (ws.length === 0) return hits;
  for (let i = 0; i + ws.length <= toks.length; i++) {
    if (ws.every((w, k) => toks[i + k]!.folded === w)) hits.push({ start: toks[i]!.start, end: toks[i + ws.length - 1]!.end });
  }
  return hits;
}

/**
 * Builds the redactor for one record. Contact matching follows the title check: every word of a
 * contact's name or alias (and the name written as one word) is replaced wherever it appears, so
 * over-replacement is possible and accepted (fail closed).
 */
export function createRecordRedactor(opts: SanitizerOptions): RecordRedactor {
  // word -> identity ("c<i>" for a contact, "t:<words>" for a person term)
  const personWords = new Map<string, string>();
  opts.contacts.forEach((c: ContactNames, i) => {
    for (const label of [c.name, ...(c.aliases ?? [])]) {
      const ws = words(label);
      for (const w of ws) if (!personWords.has(w)) personWords.set(w, `c${i}`);
      if (ws.length > 1 && !personWords.has(ws.join(""))) personWords.set(ws.join(""), `c${i}`);
    }
  });
  const blockTerms = (opts.blocklist ?? []).map((t) => words(t).join(" ")).filter((t) => t.length > 0);
  const places: string[][] = [];
  const fillers = new Map<string, number>();

  function addPeople(terms: readonly string[]): void {
    for (const term of terms) {
      const ws = phrase(term);
      if (ws.length === 0) continue;
      // A term that shares a word with a known identity is that identity (keeps "Sam" and "Sam Lee" one person).
      const who = ws.map((w) => personWords.get(w)).find((x) => x !== undefined) ?? `t:${ws.join(" ")}`;
      for (const w of ws) if (!personWords.has(w)) personWords.set(w, who);
      if (ws.length > 1 && !personWords.has(ws.join(""))) personWords.set(ws.join(""), who);
    }
  }

  function filler(who: string): string {
    let n = fillers.get(who);
    if (n === undefined) {
      n = fillers.size + 1;
      fillers.set(who, n);
    }
    return `[Person ${n}]`;
  }

  /** True when the public text still holds anything a rule would replace or block. */
  function leaks(publicText: string): boolean {
    const bare = publicText.replace(PLACEHOLDER_G, " ");
    if (patternSpans(bare).length > 0) return true;
    const toks = tokens(bare);
    if (toks.some((t) => personWords.has(t.folded))) return true;
    if (places.some((p) => findPhrase(toks, p).length > 0)) return true;
    const joined = ` ${toks.map((t) => t.folded).join(" ")} `;
    return blockTerms.some((t) => joined.includes(t));
  }

  function redact(raw: string, terms: RedactTerms = {}): RedactResult {
    try {
      const text = normalize(raw);
      if (hasControl(text)) return { ok: false, reason: "control" };
      const toks = tokens(text);
      if (toks.some((t) => LATIN.test(text.slice(t.start, t.end)) && LOOKALIKE_SCRIPT.test(text.slice(t.start, t.end)))) {
        return { ok: false, reason: "mixed_script" };
      }
      const joined = ` ${toks.map((t) => t.folded).join(" ")} `;
      if (blockTerms.some((t) => joined.includes(t))) return { ok: false, reason: "blocklist" };

      addPeople(terms.people ?? []);
      for (const p of terms.places ?? []) {
        const ws = phrase(p);
        if (ws.length > 0) places.push(ws);
      }

      const spans = patternSpans(text);
      for (const t of toks) {
        const who = personWords.get(t.folded);
        if (who !== undefined) spans.push({ start: t.start, end: t.end, kind: "person", who });
      }
      for (const p of places) for (const h of findPhrase(toks, p)) spans.push({ ...h, kind: "place" });

      let out = "";
      let at = 0;
      for (const s of merge(spans, text)) {
        out += text.slice(at, s.start) + (s.kind === "person" ? filler(s.who!) : `[${s.kind}]`);
        at = s.end;
      }
      out += text.slice(at);

      if (leaks(out)) return { ok: false, reason: "recheck" };
      return { ok: true, text: out };
    } catch {
      return { ok: false, reason: "error" };
    }
  }

  return { redact };
}
