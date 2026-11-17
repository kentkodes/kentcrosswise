// An in-memory copy of the AR5b store methods (revisions, attempts, evidence) for tests that use a
// fake TaskStore. It follows the SQL in graph/store.ts: keyed inserts write once, updates set a
// field once, supersession touches only open rows.
import type { AttemptWrite, EvidenceWrite, RevisionWrite, TaskStore } from "../src/graph/store";
import type { ValidityRows } from "../src/graph/validity";

type AttemptRecord = AttemptWrite & { runId: number | null; startedAt: string | null; endedAt: string | null; outcome: string | null };
type EvidenceRecord = EvidenceWrite & { supersededAt: string | null };

export function memoryEvidence(): Pick<TaskStore, "recordRevision" | "supersedeRevision" | "recordAttempt" | "updateAttempt" | "recordEvidence" | "loadValidity"> & {
  revisions: Map<string, RevisionWrite & { supersededAt: string | null }>;
  attempts: Map<string, AttemptRecord>;
  evidence: Map<string, EvidenceRecord>;
} {
  const revisions = new Map<string, RevisionWrite & { supersededAt: string | null }>();
  const attempts = new Map<string, AttemptRecord>();
  const evidence = new Map<string, EvidenceRecord>();
  const now = () => new Date().toISOString();
  const addRevision = (r: RevisionWrite) => {
    const key = `${r.taskId}/${r.revision}`;
    if (!revisions.has(key)) revisions.set(key, { ...r, supersededAt: null });
  };
  return {
    revisions,
    attempts,
    evidence,
    recordRevision: async (r) => addRevision(r),
    supersedeRevision: async (taskId, from, next) => {
      const old = revisions.get(`${taskId}/${from}`);
      if (old && old.supersededAt === null) old.supersededAt = now();
      for (const a of attempts.values()) if (a.taskId === taskId && a.revision === from && a.outcome === null) Object.assign(a, { outcome: "superseded", endedAt: now() });
      for (const e of evidence.values()) if (e.taskId === taskId && e.revision === from && e.kind === "qa" && e.supersededAt === null) e.supersededAt = now();
      addRevision(next);
    },
    recordAttempt: async (a) => {
      if (!attempts.has(a.effectKey)) attempts.set(a.effectKey, { ...a, runId: null, startedAt: null, endedAt: null, outcome: null });
    },
    updateAttempt: async (key, f) => {
      const a = attempts.get(key);
      if (!a) return;
      a.runId ??= f.runId ?? null;
      if (f.startedAt !== undefined && a.contractHash === (f.startContract ?? null)) a.startedAt ??= f.startedAt;
      a.endedAt ??= f.endedAt ?? null;
      a.outcome ??= f.outcome ?? null;
    },
    recordEvidence: async (e) => {
      if (!evidence.has(e.effectKey)) evidence.set(e.effectKey, { ...e, supersededAt: null });
    },
    loadValidity: async (taskId, revision, head): Promise<ValidityRows> => ({
      revisions: [...revisions.values()].filter((r) => r.taskId === taskId).map((r) => ({ revision: r.revision, superseded_at: r.supersededAt })),
      attempts: [...attempts.values()]
        .filter((a) => a.taskId === taskId && a.role === "qa" && a.revision === revision)
        .sort((a, b) => a.op - b.op)
        .map((a) => ({ effect_key: a.effectKey, revision: a.revision, op: a.op, started_at: a.startedAt })),
      evidence: [...evidence.values()]
        .filter((e) => e.taskId === taskId && e.headSha === head)
        .map((e) => ({ kind: e.kind, revision: e.revision, head_sha: e.headSha, outcome: e.outcome, attempt_key: e.attemptKey, superseded_at: e.supersededAt })),
    }),
  };
}
