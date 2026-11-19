// Publication of reviewed entries (public log slice PL4, DESIGN §4.6, migration 0027). Runs as web_rw.
// An entry is published once the owner has reviewed its route (review.ts): its snapshot in public_records holds the
// sanitized text (publicPreview: contacts, proposed and added terms, re-checked) and the public step lines
// (public-log.ts, codes only). Anything that is not safe withholds the whole record with a private reason code:
// a missing or failed name check, another person's private matters, a redaction failure, or a step that does not
// map to an allowed line. A later verdict, an added replacement or a new name check calls publishEntry again and
// replaces the snapshot. Nothing here runs before review, and nothing publishes a record review.ts would withhold.
// A published snapshot also carries the read-back checks (checks.ts, PL6) and the version of the check list.
// Logs carry codes and error classes, never text.
import { CHECKS_VERSION, type PublicCheck } from "./check-codes";
import { runChecks } from "./checks";
import type { Queryable } from "./db";
import { withDb } from "./db";
import { publicStep, type PublicStep } from "./public-log";
import { contactNames, LOGGED, publicPreview, REVIEWED, type PublicInputs } from "./review";
import { listSteps } from "./steps";

export type PublishResult = "published" | "withheld" | "not-reviewed" | "not-found";

/** Writes (or replaces) the snapshot of one reviewed entry in the caller's transaction. */
export async function publishEntry(db: Queryable, entryId: string): Promise<PublishResult> {
  const { rows } = await db.query<
    { raw_text: string; route_kind: string | null; reviewed: boolean; logged: boolean; has_public: boolean } & Partial<PublicInputs>
  >(
    `SELECT e.raw_text, e.route_kind, (${REVIEWED}) AS reviewed, (${LOGGED}) AS logged, p.entry_id IS NOT NULL AS has_public,
            p.spans_state, p.people, p.places, p.private_other, p.owner_people, p.owner_places
       FROM entries e LEFT JOIN entry_public p ON p.entry_id = e.id WHERE e.id = $1 FOR UPDATE OF e`,
    [entryId],
  );
  const row = rows[0];
  if (!row) return "not-found";
  if (!row.reviewed || !row.logged || row.route_kind === null) return "not-reviewed";

  const preview = publicPreview(row.raw_text, row.has_public ? (row as PublicInputs) : null, await contactNames(db));
  let reason: string | null = preview.state === "ready" ? null : preview.state === "pending" ? "pending" : preview.reason;
  const steps: PublicStep[] = [];
  let checks: PublicCheck[] = [];
  if (reason === null) {
    const rows = await listSteps(db, entryId);
    for (const s of rows) {
      const line = publicStep(s.step, s.ts, s.detail);
      if (!line) {
        reason = "step";
        break;
      }
      steps.push(line);
    }
    if (reason === null) checks = await runChecks(db, entryId, rows);
  }
  const published = reason === null && preview.state === "ready";
  await db.query(
    `INSERT INTO public_records (entry_id, state, withheld_reason, kind, captured_hour, body, steps, checks, checks_version, first_published)
     SELECT e.id, $2, $3, e.route_kind, date_trunc('hour', e.created_at), $4, $5::jsonb, $6::jsonb, $7, CASE WHEN $2 = 'published' THEN now() END
       FROM entries e WHERE e.id = $1
     ON CONFLICT (entry_id) DO UPDATE SET state = EXCLUDED.state, withheld_reason = EXCLUDED.withheld_reason,
       kind = EXCLUDED.kind, body = EXCLUDED.body, steps = EXCLUDED.steps, checks = EXCLUDED.checks,
       checks_version = EXCLUDED.checks_version, updated_at = now(),
       first_published = COALESCE(public_records.first_published, EXCLUDED.first_published)`,
    [
      entryId,
      published ? "published" : "withheld",
      published ? null : reason,
      published && preview.state === "ready" ? preview.text : null,
      JSON.stringify(published ? steps : []),
      JSON.stringify(published ? checks : []),
      published ? CHECKS_VERSION : null,
    ],
  );
  return published ? "published" : "withheld";
}

/** Publishes after an owner action, in its own transaction. Never throws ("failed" logs the error class). */
export async function publishNow(entryId: string | null | undefined): Promise<PublishResult | "failed"> {
  if (!entryId) return "not-found";
  try {
    return await withDb("web_rw", (db) => publishEntry(db, entryId));
  } catch (err) {
    console.error(`[publish] ${err instanceof Error ? err.name : "error"}`);
    return "failed";
  }
}

/** The entry a CRM note, a calendar suggestion or a diary row came from (null when none). Never throws. */
export async function entryOf(ref: "crm_note" | "suggestion" | "diary", id: string): Promise<string | null> {
  const sql = {
    crm_note: "SELECT entry_id FROM crm_notes WHERE id = $1",
    suggestion: "SELECT n.entry_id FROM calendar_suggestions s JOIN crm_notes n ON n.id = s.crm_note_id WHERE s.id = $1",
    diary: "SELECT entry_id FROM diary_entries WHERE id = $1",
  }[ref];
  try {
    return await withDb("web_rw", async (db) => (await db.query<{ entry_id: string | null }>(sql, [id])).rows[0]?.entry_id ?? null, {
      readOnly: true,
    });
  } catch (err) {
    console.error(`[publish] entry-${err instanceof Error ? err.name : "error"}`);
    return null;
  }
}

export interface WithheldItem {
  id: string;
  createdAt: string;
  rawText: string;
  reason: string;
}

/** Reviewed entries withheld for a reason a new name check can change (for "Find names again" on /hub). */
export async function listWithheldRetry(db: Queryable): Promise<WithheldItem[]> {
  const { rows } = await db.query<{ id: string; created_at: Date | string; raw_text: string; withheld_reason: string }>(
    `SELECT e.id, e.created_at, e.raw_text, r.withheld_reason FROM public_records r JOIN entries e ON e.id = r.entry_id
      WHERE r.state = 'withheld' AND r.withheld_reason IN ('pending', 'cap', 'failed', 'invalid', 'timeout')
      ORDER BY e.created_at, e.id`,
  );
  return rows.map((r) => ({ id: r.id, createdAt: new Date(r.created_at).toISOString(), rawText: r.raw_text, reason: r.withheld_reason }));
}
