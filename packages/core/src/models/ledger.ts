// Call records (AR3, migration 0019): the SQL that turns a provider's CallEvent into a usage_events
// row. The web (web_rw), the orchestrator (orch_rw) and the essay pipeline (pipeline_rw) all run
// these two statements, so the identity and the guard are the same everywhere.
//
//   start: INSERT outcome 'started', the requested model, NULL tokens; a second start writes nothing.
//   end:   INSERT the full row, or complete the started one. The update applies only while the
//          stored outcome is 'started', or 'unknown' and this end is 'reported' (a late report);
//          a duplicate end writes nothing, an end whose start was lost inserts the row.
// cost_usd stays NULL: readers price rows from model_prices. No prompt or reply text is stored.
import type { CallEvent, CallTag } from "./types";

/** dedupe_key of a call record. */
export const callKey = (callId: string) => `call:${callId}`;

const WORD = /^[a-z][a-z_]{0,31}$/;
const SUBJECT_ID = /^[A-Za-z0-9-]{1,64}$/;
const CALL_ID = /^[A-Za-z0-9-]{1,64}$/;

/** A tag the database would refuse (or that could carry text) is a programming error: thrown before any call. */
export function checkCallTag(tag: CallTag | undefined): void {
  if (!tag) return;
  if (tag.purpose !== undefined && !WORD.test(tag.purpose)) throw new Error("call purpose must be a lowercase word");
  if (tag.subject && (!WORD.test(tag.subject.kind) || !SUBJECT_ID.test(tag.subject.id))) {
    throw new Error("call subject must be a kind word and an id");
  }
  if (tag.taskId !== undefined && !Number.isSafeInteger(tag.taskId)) throw new Error("call task id must be an integer");
}

export interface SqlStatement {
  text: string;
  values: unknown[];
}

const START_SQL = `INSERT INTO usage_events
  (kind, agent, provider, model, input_tokens, output_tokens, task_id, purpose, subject_kind, subject_id, outcome, dedupe_key)
VALUES ('model', $1, $2, $3, NULL, NULL, $4, $5, $6, $7, 'started', $8)
ON CONFLICT (dedupe_key) DO NOTHING`;

const END_SQL = `INSERT INTO usage_events
  (kind, agent, provider, model, input_tokens, output_tokens, task_id, purpose, subject_kind, subject_id, outcome, dedupe_key)
VALUES ('model', $1, $2, $3, $9, $10, $4, $5, $6, $7, $11, $8)
ON CONFLICT (dedupe_key) DO UPDATE
  SET model = $3, input_tokens = $9, output_tokens = $10, outcome = $11
  WHERE usage_events.outcome = 'started' OR (usage_events.outcome = 'unknown' AND $11 = 'reported')`;
// The SET uses the parameters, not EXCLUDED: reading EXCLUDED columns needs SELECT on them, and
// pipeline_rw must not read tokens (0019 grants SELECT on dedupe_key and outcome only).

/** The statement that records one call event for `agent` (a usage_events agent value). */
export function callEventStatement(agent: string, e: CallEvent, defaults: CallTag = {}): SqlStatement {
  if (!CALL_ID.test(e.callId)) throw new Error("call id must be an id");
  const tag: CallTag = { ...defaults, ...e.tag };
  checkCallTag(tag);
  const common = [
    agent,
    e.provider,
    e.model,
    tag.taskId ?? null,
    tag.purpose ?? null,
    tag.subject?.kind ?? null,
    tag.subject?.id ?? null,
    callKey(e.callId),
  ];
  if (e.phase === "start") return { text: START_SQL, values: common };
  return { text: END_SQL, values: [...common, e.inputTokens, e.outputTokens, e.outcome] };
}

/** Minimal SQL surface: node-postgres Pool/Client, PGlite wrappers, the web Queryable. */
export type CallQuery = (text: string, values: unknown[]) => Promise<unknown>;

/** A CallCallback that writes every event through `query` as `agent`; `defaults` fill tag fields the call left unset. */
export function recordCallsWith(agent: string, query: CallQuery, defaults: CallTag = {}): (e: CallEvent) => Promise<void> {
  return async (e) => {
    const s = callEventStatement(agent, e, defaults);
    await query(s.text, s.values);
  };
}
