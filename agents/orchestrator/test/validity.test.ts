// AR5b: the evidence rule as a pure function (the graph-level cases are in attempts.test.ts and replan.test.ts).
import { describe, expect, it } from "vitest";
import { evidenceValid, type AttemptRow, type EvidenceRow, type ValidityRows } from "../src/graph/validity";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const ci = (outcome: "success" | "failure", head = HEAD, superseded = false): EvidenceRow => ({
  kind: "ci", revision: 1, head_sha: head, outcome, attempt_key: null, superseded_at: superseded ? "2026-11-17T10:00:00Z" : null,
});
const qa = (attempt: string, revision: number | null = 1, head = HEAD): EvidenceRow => ({
  kind: "qa", revision, head_sha: head, outcome: "approved", attempt_key: attempt, superseded_at: null,
});
const attempt = (op: number, started: boolean, revision: number | null = 1): AttemptRow => ({
  effect_key: `task-1/dispatch/${op}`, revision, op, started_at: started ? "2026-11-17T10:00:00Z" : null,
});
const rows = (r: Partial<ValidityRows>): ValidityRows => ({ revisions: [{ revision: 1, superseded_at: null }], attempts: [], evidence: [], ...r });

describe("evidenceValid (AR5b)", () => {
  it("ci: a success row of the head is valid for any revision, also beside a failure row of a re-run", () => {
    expect(evidenceValid("ci", { revision: 2, head: HEAD }, rows({ evidence: [ci("success"), ci("failure")] }))).toBe(true);
    expect(evidenceValid("ci", { revision: 1, head: HEAD }, rows({ evidence: [ci("failure")] }))).toBe(false);
    expect(evidenceValid("ci", { revision: 1, head: HEAD }, rows({ evidence: [ci("success", OTHER)] }))).toBe(false);
    expect(evidenceValid("ci", { revision: 1, head: HEAD }, rows({ evidence: [ci("success", HEAD, true)] }))).toBe(false);
  });

  it("qa: needs the current revision, the head, and the revision's latest QA attempt, started", () => {
    const q = { revision: 1, head: HEAD };
    const ok = rows({ attempts: [attempt(3, true), attempt(5, true)], evidence: [qa("task-1/dispatch/5")] });
    expect(evidenceValid("qa", q, ok)).toBe(true);
    expect(evidenceValid("qa", q, { ...ok, evidence: [qa("task-1/dispatch/3")] })).toBe(false); // an earlier attempt's approval
    expect(evidenceValid("qa", q, { ...ok, attempts: [attempt(5, false)] })).toBe(false); // not started
    expect(evidenceValid("qa", q, { ...ok, evidence: [qa("task-1/dispatch/5", 1, OTHER)] })).toBe(false); // another head
    expect(evidenceValid("qa", q, { ...ok, revisions: [{ revision: 1, superseded_at: "2026-11-17T10:00:00Z" }] })).toBe(false);
    expect(evidenceValid("qa", { revision: 2, head: HEAD }, { ...ok, revisions: [{ revision: 1, superseded_at: null }] })).toBe(false); // unknown revision
  });

  it("qa of a docs task (no revision): only the latest started attempt and the head count", () => {
    const docs = rows({ revisions: [], attempts: [attempt(2, true, null)], evidence: [qa("task-1/dispatch/2", null)] });
    expect(evidenceValid("qa", { revision: null, head: HEAD }, docs)).toBe(true);
    expect(evidenceValid("qa", { revision: null, head: HEAD }, { ...docs, attempts: [attempt(2, false, null)] })).toBe(false);
  });
});
