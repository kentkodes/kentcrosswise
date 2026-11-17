// AR5b: when a stored result may complete a task revision (design section 3). One pure function, used
// by the review handler (before an approval is applied) and by the merge step (before it merges).
// Rows come from task_revisions, task_attempts and task_evidence (TaskStore.loadValidity).

/** One task_evidence row, as far as the rule reads it. */
export interface EvidenceRow {
  kind: "ci" | "qa";
  /** Null for a docs task (no contract, no revision). */
  revision: number | null;
  head_sha: string;
  outcome: "success" | "failure" | "approved" | "changes_requested";
  /** QA evidence: the dispatch key of the QA attempt that produced it. */
  attempt_key: string | null;
  superseded_at: string | null;
}

/** One QA task_attempts row. */
export interface AttemptRow {
  effect_key: string;
  revision: number | null;
  op: number;
  /** Set by the start report whose op and contract matched the attempt. */
  started_at: string | null;
}

export interface RevisionRow {
  revision: number;
  superseded_at: string | null;
}

/** What `loadValidity` returns: every revision of the task, its QA attempts and the evidence for the head. */
export interface ValidityRows {
  revisions: RevisionRow[];
  attempts: AttemptRow[];
  evidence: EvidenceRow[];
}

export interface ValidityQuery {
  /** The current contract revision; null for a docs task. */
  revision: number | null;
  /** The current PR head. */
  head: string;
}

/** The task's latest QA attempt of the revision (highest op), or null. */
export function latestQaAttempt(rows: Pick<ValidityRows, "attempts">, revision: number | null): AttemptRow | null {
  let latest: AttemptRow | null = null;
  for (const a of rows.attempts) if (a.revision === revision && (latest === null || a.op > latest.op)) latest = a;
  return latest;
}

/**
 * Whether a `ci` success or a `qa` approval is valid for the current head:
 * - CI is head-bound and contract-independent: a success row for the head is valid for any revision.
 * - A QA approval needs the same revision (not superseded, no row superseded), the same head, the
 *   revision's latest QA attempt as its `attempt_key`, and that attempt must have started (its start
 *   report arrived). For a docs task (null revision) no revision condition applies.
 */
export function evidenceValid(kind: "ci" | "qa", q: ValidityQuery, rows: ValidityRows): boolean {
  if (kind === "ci") {
    return rows.evidence.some((e) => e.kind === "ci" && e.outcome === "success" && e.head_sha === q.head && e.superseded_at === null);
  }
  if (q.revision !== null) {
    const current = rows.revisions.find((r) => r.revision === q.revision);
    if (current === undefined || current.superseded_at !== null) return false;
  }
  const latest = latestQaAttempt(rows, q.revision);
  if (latest === null || latest.started_at === null) return false;
  return rows.evidence.some(
    (e) =>
      e.kind === "qa" &&
      e.outcome === "approved" &&
      e.head_sha === q.head &&
      e.superseded_at === null &&
      e.revision === q.revision &&
      e.attempt_key === latest.effect_key,
  );
}
