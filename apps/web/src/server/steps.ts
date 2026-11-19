// Router step rows (public log slice PL2, DESIGN §4.6, migration 0025). Each step of a capture writes one
// agent_events row: agent "router", the entry's id, the step type and a private detail of fixed codes and ids.
// A detail never holds entry text, note bodies, names or model replies; the sanitized public copy of a record is
// made at publication (PL4) from the stored rows, not from this detail.
// A step is written in the caller's transaction inside a savepoint: if the insert fails, only the step is rolled
// back and its error class is logged, so recording a step can never fail a capture, a route or a reassignment.
// A record with a missing step is incomplete, and publication treats it so (fail closed).
import type { RouterStep } from "@kcw/core/events";
import type { RouteError, RouteKind } from "./capture";
import type { Queryable } from "./db";

/** The private detail of each step: codes and ids only. */
export interface StepDetail {
  captured: { source: "web" | "shortcut" };
  routed: { kind: RouteKind; by: "model" | "owner"; confidence?: number; model?: string; guess?: RouteKind | null };
  needs_owner: { kind: RouteKind; confidence: number; model: string };
  route_failed: { code: RouteError; attempt: number };
  derived: { kind: RouteKind; row_id: string; moved_from?: RouteKind | null };
  contact_linked: { outcome: "linked" | "ambiguous" | "none" | "failed"; note_id: string };
  mood_scored: { outcome: "scored" | "cap" | "failed" | "changed"; diary_entry_id: string; model?: string };
  calendar_suggested: { outcome: "created" | "none" | "no-zone" | "cap" | "invalid" | "failed" | "timeout"; note_id: string; suggestion_id?: string };
  corrected: { from: RouteKind; to: RouteKind };
  confirmed: { kind: RouteKind };
  /** kept: the owner kept the contact the note was already linked to (PL6b: a confirmed automatic link). */
  contact_chosen: { note_id: string; linked: boolean; kept?: boolean };
  calendar_added: { suggestion_id: string };
  calendar_dismissed: { suggestion_id: string };
}

/** Writes one step for an entry in the caller's transaction. Never throws. */
export async function recordStep<S extends RouterStep>(db: Queryable, entryId: string, step: S, detail: StepDetail[S]): Promise<void> {
  try {
    await db.query("SAVEPOINT router_step");
  } catch (err) {
    console.error(`[steps] ${step}-${errorClass(err)}`);
    return;
  }
  try {
    await db.query("INSERT INTO agent_events (agent, event_type, entry_id, detail) VALUES ('router', $1, $2, $3)", [step, entryId, JSON.stringify(detail)]);
    await db.query("RELEASE SAVEPOINT router_step");
  } catch (err) {
    console.error(`[steps] ${step}-${errorClass(err)}`);
    try {
      await db.query("ROLLBACK TO SAVEPOINT router_step");
      await db.query("RELEASE SAVEPOINT router_step");
    } catch (inner) {
      console.error(`[steps] rollback-${errorClass(inner)}`);
    }
  }
}

/** One stored step, oldest first (for the owner's review screen and publication). */
export interface StepRow {
  id: string;
  ts: string;
  step: RouterStep;
  detail: Record<string, unknown>;
}

/** The steps of one entry, in the order they were written. */
export async function listSteps(db: Queryable, entryId: string): Promise<StepRow[]> {
  const { rows } = await db.query<{ id: string | number; ts: Date | string; event_type: RouterStep; detail: Record<string, unknown> }>(
    "SELECT id, ts, event_type, detail FROM agent_events WHERE entry_id = $1 ORDER BY id",
    [entryId],
  );
  return rows.map((r) => ({ id: String(r.id), ts: new Date(r.ts).toISOString(), step: r.event_type, detail: r.detail }));
}

function errorClass(err: unknown): string {
  return err instanceof Error ? err.name : "error";
}
