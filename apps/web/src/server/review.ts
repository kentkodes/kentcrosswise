// Owner review of routed entries before publication (public log slice PL3, DESIGN §4.6, migration 0026).
// After a route, one bounded model call proposes the names and places in the entry text (public-spans.ts); its
// outcome is stored in entry_public. The /hub review screen shows the exact public text (createRecordRedactor with
// the contacts, the proposed terms and the owner's added terms), lets the owner add replacements, and takes the
// owner's verdict: "Correct" writes a `confirmed` step; a reassignment writes `corrected` or `routed` by owner
// (router.ts). A reviewed entry with safe public text is what publication (PL4) will publish; review never makes
// withheld text public. Owner pages only; runs as web_rw. Logs carry codes and error classes, never text.
import type { ModelProvider } from "@kcw/core/models";
import { createRecordRedactor, type ContactNames, type RedactFailure } from "@kcw/core/sanitize";
import type { RouteKind } from "./capture";
import { containsWord } from "./contacts";
import type { Queryable } from "./db";
import { proposeSpans, type SpanOutcome } from "./public-spans";
import type { DbRun } from "./router";

export type SpansState = SpanOutcome["state"];

/** Most replacements of each kind the owner can add to one entry (the table checks the same limit). */
export const MAX_OWNER_TERMS = 50;
/** Longest word or phrase the owner can add. */
export const MAX_TERM_LENGTH = 120;

/** SQL on `entries e`: the entry counts as reviewed (confirmed, corrected, or routed by the owner's own choice). Migration 0027 repeats this filter in v_public_log_counts. */
export const REVIEWED = `EXISTS (SELECT 1 FROM agent_events r WHERE r.entry_id = e.id
  AND (r.event_type IN ('confirmed', 'corrected') OR (r.event_type = 'routed' AND r.detail->>'by' = 'owner')))`;
/** Entries the public log can cover: captured since router steps exist (PL2; no backfill). */
export const LOGGED = "EXISTS (SELECT 1 FROM agent_events c WHERE c.entry_id = e.id AND c.event_type = 'captured')";
const AWAITING = `e.status = 'routed' AND e.route_kind IS NOT NULL AND ${LOGGED} AND NOT ${REVIEWED}`;

export type PrepareResult = SpansState | "kept" | "not-found";

/**
 * Runs the span proposal for an entry and stores its outcome, unless a valid proposal is already stored ("kept").
 * A new outcome replaces the proposed terms; the owner's added terms are kept. Never throws ("failed" on a database
 * error).
 */
export async function prepareSpans(run: DbRun, entryId: string, provider: ModelProvider): Promise<PrepareResult> {
  try {
    const before = await run(async (db) => {
      const { rows } = await db.query<{ raw_text: string; spans_state: string | null }>(
        "SELECT e.raw_text, p.spans_state FROM entries e LEFT JOIN entry_public p ON p.entry_id = e.id WHERE e.id = $1",
        [entryId],
      );
      return rows[0] ?? null;
    });
    if (!before) return "not-found";
    if (before.spans_state === "ok") return "kept";
    const out = await proposeSpans(run, entryId, before.raw_text, provider);
    const ok = out.state === "ok" ? out.proposal : null;
    await run((db) =>
      db.query(
        `INSERT INTO entry_public (entry_id, spans_state, people, places, private_other) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (entry_id) DO UPDATE SET spans_state = EXCLUDED.spans_state, people = EXCLUDED.people,
           places = EXCLUDED.places, private_other = EXCLUDED.private_other, proposed_at = now()
         WHERE entry_public.spans_state <> 'ok'`,
        [entryId, out.state, ok?.people ?? [], ok?.places ?? [], ok?.privateOther ?? false],
      ),
    );
    return out.state;
  } catch (err) {
    console.error(`[review] prepare-${err instanceof Error ? err.name : "error"}`);
    return "failed";
  }
}

/** Why an entry's public text is not shown: the span outcome, another person's private matters, or a redaction code. */
export type WithheldReason = Exclude<SpansState, "ok"> | "private-other" | RedactFailure;

export type PublicPreview = { state: "ready"; text: string } | { state: "pending" } | { state: "withheld"; reason: WithheldReason };

export interface PublicInputs {
  spans_state: SpansState;
  people: string[];
  places: string[];
  private_other: boolean;
  owner_people: string[];
  owner_places: string[];
}

/** The exact public text of one entry, or why there is none. Pure: a new redactor per record keeps fillers per record. */
export function publicPreview(rawText: string, p: PublicInputs | null, contacts: readonly ContactNames[]): PublicPreview {
  if (!p) return { state: "pending" };
  if (p.spans_state !== "ok") return { state: "withheld", reason: p.spans_state };
  if (p.private_other) return { state: "withheld", reason: "private-other" };
  const r = createRecordRedactor({ contacts }).redact(rawText, {
    people: [...p.people, ...p.owner_people],
    places: [...p.places, ...p.owner_places],
  });
  return r.ok ? { state: "ready", text: r.text } : { state: "withheld", reason: r.reason };
}

export interface ReviewItem {
  id: string;
  createdAt: string;
  rawText: string;
  routeKind: RouteKind;
  preview: PublicPreview;
}

export async function contactNames(db: Queryable): Promise<ContactNames[]> {
  const { rows } = await db.query<{ name: string; aliases: string[] | null }>("SELECT name, aliases FROM contacts ORDER BY id");
  return rows.map((r) => ({ name: r.name, aliases: r.aliases ?? [] }));
}

/** Every entry awaiting the owner's review, oldest first, with its public text. */
export async function listAwaitingReview(db: Queryable): Promise<ReviewItem[]> {
  const { rows } = await db.query<{ id: string; created_at: Date | string; raw_text: string; route_kind: RouteKind } & Partial<PublicInputs>>(
    `SELECT e.id, e.created_at, e.raw_text, e.route_kind,
            p.spans_state, p.people, p.places, p.private_other, p.owner_people, p.owner_places
       FROM entries e LEFT JOIN entry_public p ON p.entry_id = e.id
      WHERE ${AWAITING}
      ORDER BY e.created_at, e.id`,
  );
  if (rows.length === 0) return [];
  const contacts = await contactNames(db);
  return rows.map((r) => ({
    id: r.id,
    createdAt: new Date(r.created_at).toISOString(),
    rawText: r.raw_text,
    routeKind: r.route_kind,
    preview: publicPreview(r.raw_text, r.spans_state ? (r as PublicInputs) : null, contacts),
  }));
}

/**
 * "Correct": the owner confirms the model's route. Writes the `confirmed` step in the caller's transaction; unlike
 * other steps a failure here throws, because the step is the verdict. "already" when the entry was reviewed,
 * "not-found" when it is gone, not routed, or older than the public log.
 */
export async function confirmEntry(db: Queryable, entryId: string): Promise<"ok" | "already" | "not-found"> {
  const { rows } = await db.query<{ route_kind: RouteKind; awaiting: boolean; reviewed: boolean }>(
    `SELECT e.route_kind, (${AWAITING}) AS awaiting, (${REVIEWED}) AS reviewed FROM entries e WHERE e.id = $1 FOR UPDATE OF e`,
    [entryId],
  );
  const row = rows[0];
  if (!row) return "not-found";
  if (row.reviewed) return "already";
  if (!row.awaiting) return "not-found";
  await db.query("INSERT INTO agent_events (agent, event_type, entry_id, detail) VALUES ('router', 'confirmed', $1, $2)", [
    entryId,
    JSON.stringify({ kind: row.route_kind }),
  ]);
  return "ok";
}

export type TermKind = "person" | "place";
export type AddTermResult = "ok" | "exists" | "invalid" | "not-ready" | "full" | "not-found";

export function isTermKind(v: unknown): v is TermKind {
  return v === "person" || v === "place";
}

/**
 * Adds one word or phrase the owner tapped to the entry's replacements. It must occur in the entry text as a whole
 * word or phrase; replacements can only be added, never removed. Needs a valid span proposal first ("not-ready").
 */
export async function addOwnerTerm(db: Queryable, entryId: string, rawTerm: unknown, kind: TermKind): Promise<AddTermResult> {
  if (typeof rawTerm !== "string") return "invalid";
  const term = rawTerm.normalize("NFC").trim().replace(/\s+/g, " ");
  if (term.length === 0 || term.length > MAX_TERM_LENGTH || !/[\p{L}\p{N}]/u.test(term)) return "invalid";
  const { rows } = await db.query<{ raw_text: string; spans_state: string | null; terms: string[] | null }>(
    `SELECT e.raw_text, p.spans_state, ${kind === "person" ? "p.owner_people" : "p.owner_places"} AS terms
       FROM entries e LEFT JOIN entry_public p ON p.entry_id = e.id WHERE e.id = $1 FOR UPDATE OF e`,
    [entryId],
  );
  const row = rows[0];
  if (!row) return "not-found";
  if (row.spans_state !== "ok") return "not-ready";
  if (!containsWord(row.raw_text, term)) return "invalid";
  const terms = row.terms ?? [];
  if (terms.some((t) => t.toLowerCase() === term.toLowerCase())) return "exists";
  if (terms.length >= MAX_OWNER_TERMS) return "full";
  const column = kind === "person" ? "owner_people" : "owner_places";
  await db.query(`UPDATE entry_public SET ${column} = array_append(${column}, $2) WHERE entry_id = $1`, [entryId, term]);
  return "ok";
}

/** How many entries await review (for the count beside the list and, later, the public log). */
export async function countAwaitingReview(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ n: string | number }>(`SELECT count(*) AS n FROM entries e WHERE ${AWAITING}`);
  return Number(rows[0]!.n);
}
