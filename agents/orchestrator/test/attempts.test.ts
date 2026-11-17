// AR5b evidence: a retry keeps the logical task and records a separate attempt; reports of an obsolete
// run have no lifecycle effect; a QA approval is applied only when it is valid evidence for the
// current revision and head; the merge step re-checks the stored evidence. On the real store as
// orch_rw (PGlite), through the SQS handler.
import { describe, expect, it } from "vitest";
import { WAIT_LIMIT_MINUTES } from "../src/graph";
import { harness, sha } from "./revisions-harness";

const line = (input: number) => ({ kind: "model", provider: "anthropic", model: "synthetic-model", input_tokens: input, output_tokens: 1, call: { job: "work", index: 0 } });

describe("attempts and result evidence (AR5b)", () => {
  const t = harness();

  /** Task started, PR opened at `head`, CI green: QA dispatched (op 1). */
  async function toQa(pr: number, head: string) {
    const id = await t.newTask();
    expect(await t.start(id)).toBe("started");
    expect(await t.openPr(id, pr, head)).toBe("applied");
    expect(await t.send(id, t.ciEvent(id, pr, head, "success"))).toBe("applied");
    expect((await t.task(id)).waiting_on).toBe("qa");
    return id;
  }

  it("a CI failure then a Developer fix leaves two attempts of one task, revision, branch and issue; redeliveries add no row", async () => {
    const id = await t.newTask();
    const h1 = sha("r1");
    await t.start(id);
    await t.openPr(id, 41, h1);
    const hash = await t.hashOf(id);
    const ci = t.ciEvent(id, 41, h1, "failure");
    expect(await t.send(id, ci, "ci-1")).toBe("applied"); // attempt 1 failed: Developer fix = dispatch op 1
    expect(await t.send(id, ci, "ci-1")).toBe("duplicate"); // the same message again: nothing is applied or written
    const rows = await t.attempts(id);
    expect(rows.map((r) => [r.effect_key, r.op, r.role, r.revision, r.contract_hash])).toEqual([
      [`task-${id}/dispatch/0`, 0, "developer", 1, hash],
      [`task-${id}/dispatch/1`, 1, "developer", 1, hash],
    ]);
    expect(rows[0]!.base_sha).toMatch(/^[a-f0-9]{40}$/);
    expect(rows[1]!.base_sha).toBe(rows[0]!.base_sha);
    // The runs are linked to their attempts; the task row is the same logical task.
    expect(rows.map((r) => r.run_id)).toEqual(t.dev().map((d) => String(d.runId)));
    expect(await t.task(id)).toMatchObject({ github_issue: t.h.gh.issues[0]!.number, branch: `kcw/task-${id}` });
    expect(await t.revisions(id)).toEqual([{ revision: 1, contract_hash: hash, superseded: false }]);
    // Writing the same attempt again (a re-run step) writes nothing.
    const store = t.deps.store;
    await store.recordAttempt({ effectKey: `task-${id}/dispatch/1`, taskId: id, revision: 1, role: "developer", op: 1, contractHash: hash, baseSha: rows[0]!.base_sha, createdAt: t.h.clock.toISOString() });
    await store.recordRevision({ taskId: id, revision: 1, contractHash: hash, contract: {} });
    expect(await t.attempts(id)).toHaveLength(2);
    expect(await t.revisions(id)).toHaveLength(1);
    // CI evidence: the failure at the head, once.
    expect((await t.evidence(id)).map((e) => [e.kind, e.head_sha, e.outcome])).toEqual([["ci", h1, "failure"]]);
  });

  it("start and end reports fill the attempt once; a start under another contract does not start it", async () => {
    const id = await t.newTask();
    await t.start(id);
    const hash = await t.hashOf(id);
    const other = "f".repeat(64);
    expect(await t.send(id, t.report(id, { job: "start", op: 0, event_type: "coding", contract: other }))).toBe("stale");
    expect((await t.attempts(id))[0]).toMatchObject({ started: false });
    expect(await t.send(id, t.report(id, { job: "start", op: 0, event_type: "coding", contract: hash }))).toBe("applied");
    expect((await t.attempts(id))[0]).toMatchObject({ started: true, ended: false, outcome: null });
    expect(await t.send(id, t.report(id, { job: "end", op: 0, event_type: "failed", contract: hash }))).toBe("applied");
    expect((await t.attempts(id))[0]).toMatchObject({ ended: true, outcome: "failed" });
  });

  it("a report of an obsolete op records its usage but changes neither the task nor the attempt of the current op", async () => {
    const id = await t.newTask();
    await t.start(id);
    const hash = await t.hashOf(id);
    t.h.clock = new Date(t.h.clock.getTime() + (WAIT_LIMIT_MINUTES.dev + 1) * 60_000);
    expect(await t.send(id, t.sweep(id))).toBe("applied"); // timeout: redispatch = op 1; the op 0 attempt is lost
    expect((await t.attempts(id)).map((r) => [r.op, r.outcome])).toEqual([[0, "lost"], [1, null]]);
    const before = await t.state(id);
    expect(await t.send(id, t.report(id, { job: "end", op: 0, event_type: "coding", contract: hash, usage: [line(7)] }))).toBe("stale");
    expect(await t.usageRows(id)).toHaveLength(1);
    expect(await t.state(id)).toMatchObject({ phase: before.phase, attempts: before.attempts });
    expect((await t.attempts(id))[1]).toMatchObject({ started: false, ended: false });
  });

  it("a QA approval before the attempt's start report, or under another contract, is not applied; after the matching start it is", async () => {
    const id = await toQa(42, sha("a1"));
    const h1 = sha("a1");
    expect(await t.send(id, t.reviewEvent(id, 42, h1, "approved"))).toBe("stale");
    expect(await t.evidence(id)).toEqual([expect.objectContaining({ kind: "ci" })]);
    expect((await t.task(id)).status).not.toBe("merged");
    // A start report that carries another contract does not start the attempt.
    await t.startQa(id, 1, "e".repeat(64));
    expect(await t.send(id, t.reviewEvent(id, 42, h1, "approved"))).toBe("stale");
    // The matching start report: the same approval is applied and merges.
    await t.startQa(id, 1);
    expect((await t.attempts(id)).find((r) => r.role === "qa")).toMatchObject({ started: true });
    expect(await t.send(id, t.reviewEvent(id, 42, h1, "approved"))).toBe("applied");
    expect((await t.task(id)).status).toBe("merged");
    expect((await t.evidence(id)).filter((e) => e.kind === "qa").map((e) => [e.outcome, e.attempt_key, e.revision])).toEqual([["approved", `task-${id}/dispatch/1`, 1]]);
  });

  it("changed reviewed code: an approval at H1, then a push of H2, merges only after fresh CI and a valid approval at H2", async () => {
    const [h1, h2] = [sha("c1"), sha("c2")];
    const id = await toQa(43, h1);
    t.h.gh.artifacts.delete(h1); // merge-rules input missing: the approval is kept, the merge waits
    await t.startQa(id, 1);
    expect(await t.send(id, t.reviewEvent(id, 43, h1, "approved"))).toBe("applied");
    expect((await t.state(id)).phase).toBe("merge");
    expect(t.h.gh.merges).toHaveLength(0);

    await t.push(id, 43, h2);
    expect((await t.state(id)).phase).toBe("ci");
    expect(await t.send(id, t.sweep(id))).toBe("unchanged");
    expect(t.h.gh.merges).toHaveLength(0);
    expect(await t.send(id, t.ciEvent(id, 43, h2, "success"))).toBe("applied"); // fresh CI: QA again (op 2)
    expect(t.qa()).toHaveLength(2);
    expect(await t.send(id, t.reviewEvent(id, 43, h2, "approved"))).toBe("stale"); // attempt 2 has not started
    expect(await t.send(id, t.reviewEvent(id, 43, h1, "approved"))).toBe("stale"); // the old head
    expect(t.h.gh.merges).toHaveLength(0);
    await t.startQa(id, 2);
    expect(await t.send(id, t.reviewEvent(id, 43, h2, "approved"))).toBe("applied");
    expect(t.h.gh.merges).toHaveLength(1);
    expect(t.h.gh.merges[0]!.pr).toBe(43);
    expect((await t.evidence(id)).filter((e) => e.kind === "qa").map((e) => [e.head_sha, e.attempt_key])).toEqual([
      [h1, `task-${id}/dispatch/1`],
      [h2, `task-${id}/dispatch/2`],
    ]);
  });

  it("the merge step refuses and dispatches QA again when the stored QA evidence is invalid, whatever the checkpoint says", async () => {
    const h1 = sha("m1");
    const id = await toQa(44, h1);
    t.h.gh.artifacts.delete(h1);
    await t.startQa(id, 1);
    expect(await t.send(id, t.reviewEvent(id, 44, h1, "approved"))).toBe("applied");
    expect(await t.state(id)).toMatchObject({ phase: "merge" }); // the checkpoint says: approved, waiting for merge-rules input
    // The stored approval is no longer valid (superseded); the merge-rules input arrives.
    await t.sql("UPDATE task_evidence SET superseded_at = now() WHERE task_id = $1 AND kind = 'qa'", [id]);
    t.h.gh.artifacts.set(h1, { pr: 44, headSha: h1, planSummary: { format: 1, infra: [], artifact: { count: 1, kinds: { create: 0, update: 1, delete: 0, replace: 0 } } }, lockDiff: { added: [], existing: [] }, uncoveredPaths: [] });
    expect(await t.send(id, t.sweep(id))).toBe("applied");
    expect(t.h.gh.merges).toHaveLength(0);
    expect(await t.state(id)).toMatchObject({ phase: "qa" });
    expect(t.qa()).toHaveLength(2); // QA again for the same revision, no owner step
    expect(await t.sql("SELECT 1 FROM approvals WHERE task_id = $1", [id])).toEqual([]);
    expect(t.qa()[1]!.inputs.contract).toBe(t.qa()[0]!.inputs.contract);
  });

  it("a docs task's attempts carry no revision, hash or base; its approval needs the latest QA attempt to have started", async () => {
    const id = await toQa(45, sha("d1"));
    await t.startQa(id, 1);
    await t.send(id, t.reviewEvent(id, 45, sha("d1"), "approved"));
    const [docs] = await t.sql<{ id: string }>("SELECT id FROM tasks WHERE parent_id = $1", [id]);
    const rows = await t.attempts(Number(docs!.id));
    expect(rows).toEqual([expect.objectContaining({ role: "docs", revision: null, contract_hash: null, base_sha: null, op: 0 })]);
  });
});
