// AR5b evidence: the replan. Attempts exhausted asks the owner to replan; approving supersedes the
// previous revision's attempts and QA evidence, reuses CI for an unchanged head, and continues by what
// the PR has. Obsolete reports and the previous revision's approvals never complete the new revision.
import { parseContract } from "@kcw/core/contract";
import { describe, expect, it } from "vitest";
import { MAX_ATTEMPTS } from "../src/graph";
import { harness, sha } from "./revisions-harness";

const REPLAN_TEXT =
  "Approve to replan the task (new contract revision; the PR is kept, CI is reused for an unchanged head, QA reviews again); reject to mark it failed.";
const NEW_PLAN = { title: "Add a healthz page", body: "Add a /healthz route that returns ok, with a test.", acceptance: ["It works.", "It is tested."], scope: ["apps/web/src/app/healthz"], context: [] };
const line = (input: number) => ({ kind: "model", provider: "anthropic", model: "synthetic-model", input_tokens: input, output_tokens: 1, call: { job: "review", index: 0 } });

describe("replan (AR5b)", () => {
  const t = harness();

  /** QA asks for changes on MAX_ATTEMPTS heads in a row: CI is green at the last head, the owner has the task. */
  async function exhaustedByQa(pr: number) {
    const id = await t.newTask();
    await t.start(id);
    let head = "";
    for (let n = 1; n <= MAX_ATTEMPTS; n++) {
      head = sha(`${id}-qa-${n}`);
      if (n === 1) await t.openPr(id, pr, head);
      else await t.push(id, pr, head);
      expect(await t.send(id, t.ciEvent(id, pr, head, "success"))).toBe("applied");
      const op = Number(t.qa().at(-1)!.inputs.op);
      // A review counts only from a QA attempt that has started (its start report arrived).
      if (n === 1) expect(await t.send(id, t.reviewEvent(id, pr, head, "changes_requested"))).toBe("stale");
      expect(await t.startQa(id, op)).toBe("applied");
      expect(await t.send(id, t.reviewEvent(id, pr, head, "changes_requested"))).toBe("applied");
    }
    expect(await t.task(id)).toMatchObject({ waiting_on: "owner", attempts: MAX_ATTEMPTS });
    return { id, head };
  }

  /** The CI fails on MAX_ATTEMPTS heads in a row. */
  async function exhaustedByCi(pr: number) {
    const id = await t.newTask();
    await t.start(id);
    let head = "";
    for (let n = 1; n <= MAX_ATTEMPTS; n++) {
      head = sha(`${id}-ci-${n}`);
      if (n === 1) await t.openPr(id, pr, head);
      else await t.push(id, pr, head);
      expect(await t.send(id, t.ciEvent(id, pr, head, "failure"))).toBe("applied");
    }
    expect(await t.task(id)).toMatchObject({ waiting_on: "owner", attempts: MAX_ATTEMPTS });
    return { id, head };
  }

  it("attempts exhausted: the owner approval is a replan with the new text; rejecting still fails the task", async () => {
    const { id } = await exhaustedByCi(51);
    const a = await t.pendingApproval(id);
    expect(a.kind).toBe("critical_pr");
    expect(a.reasons).toEqual([`Task failed: CI failed; ${MAX_ATTEMPTS} failed attempts.`, REPLAN_TEXT]);
    expect(await t.state(id)).toMatchObject({ owner_wait: "failure", retry: "plan" });
    expect(await t.decide(id, a.id, "rejected")).toBe("applied");
    expect(await t.task(id)).toMatchObject({ status: "failed", waiting_on: null });
    expect(await t.revisions(id)).toEqual([expect.objectContaining({ revision: 1, superseded: false })]);
  });

  it("a replan with CI success at the head: revision 2, revision 1 superseded, QA dispatched with the new contract, no Developer, CI reused", async () => {
    const { id, head } = await exhaustedByQa(52);
    const before = await t.state(id);
    const c1 = before.contract!;
    const devBefore = t.dev().length;
    const qaBefore = t.qa().length;
    const ciBefore = (await t.evidence(id)).filter((e) => e.kind === "ci");
    t.h.replanPlan = NEW_PLAN;
    t.h.gh.calls.length = 0;

    const a = await t.pendingApproval(id);
    expect(a.reasons[1]).toBe(REPLAN_TEXT);
    expect(await t.decide(id, a.id, "approved")).toBe("applied");

    // The planner: only the public-title node, with the previous contract and one fixed failure line from counts.
    expect(t.h.splitCalls).toBe(1); // the first planning only
    const request = t.h.planRequests.at(-1)!;
    expect(request.previous).toEqual(c1);
    expect(request.failure).toBe(`Revision 1 used ${MAX_ATTEMPTS} of ${MAX_ATTEMPTS} attempts without an approved QA review.`);
    // The issue is neither created nor edited.
    expect(t.h.gh.issues).toHaveLength(1);
    expect(t.h.gh.calls.map((c) => c.method)).not.toContain("createIssue");
    // The new contract: same issue, base and prerequisites, revision 2, the new public text.
    const after = await t.state(id);
    expect(after.contract).toMatchObject({ revision: 2, issue: c1.issue, base: c1.base, prerequisites: c1.prerequisites, task: id, goal: NEW_PLAN.body, acceptance: NEW_PLAN.acceptance, scope: NEW_PLAN.scope });
    expect(after).toMatchObject({ revision: 2, attempts: 0, phase: "qa", pending_contract: null, pending_revision: null });
    expect(await t.task(id)).toMatchObject({ waiting_on: "qa", attempts: 0 });
    // Records: revision 1 superseded with every open attempt and its QA evidence; CI evidence untouched.
    const revs = await t.revisions(id);
    expect(revs.map((r) => [r.revision, r.superseded])).toEqual([[1, true], [2, false]]);
    expect(revs[1]!.contract_hash).not.toBe(revs[0]!.contract_hash);
    const rows = await t.attempts(id);
    expect(rows.filter((r) => r.revision === 1).every((r) => r.outcome === "superseded" && r.ended)).toBe(true);
    expect(rows.filter((r) => r.revision === 2).map((r) => [r.role, r.outcome])).toEqual([["qa", null]]);
    const ev = await t.evidence(id);
    expect(ev.filter((e) => e.kind === "qa" && e.revision === 1).every((e) => e.superseded)).toBe(true);
    expect(ev.filter((e) => e.kind === "ci")).toEqual(ciBefore);
    expect(ev.filter((e) => e.kind === "ci" && !e.superseded && e.head_sha === head && e.outcome === "success")).toHaveLength(1);
    // QA reviews again, with the new contract; no Developer run, no new CI.
    expect(t.dev()).toHaveLength(devBefore);
    expect(t.qa()).toHaveLength(qaBefore + 1);
    expect(parseContract(t.qa().at(-1)!.inputs.contract).revision).toBe(2);
  });

  it("a replan with CI failure at the head: Developer fix under revision 2, attempts reset to 0", async () => {
    const { id } = await exhaustedByCi(53);
    t.h.replanPlan = NEW_PLAN;
    const qaBefore = t.qa().length;
    const a = await t.pendingApproval(id);
    expect(await t.decide(id, a.id, "approved")).toBe("applied");
    expect(await t.task(id)).toMatchObject({ waiting_on: "dev", attempts: 0 });
    expect((await t.state(id)).contract).toMatchObject({ revision: 2 });
    const last = t.dev().at(-1)!;
    expect(last.inputs).toMatchObject({ mode: "fix", pr: "53" });
    expect(parseContract(last.inputs.contract).revision).toBe(2);
    expect(t.qa()).toHaveLength(qaBefore);
    expect((await t.attempts(id)).at(-1)).toMatchObject({ role: "developer", revision: 2 });
    expect((await t.revisions(id)).map((r) => r.superseded)).toEqual([true, false]);
  });

  it("obsolete reports and the previous revision's approvals never complete the new revision", async () => {
    const { id, head } = await exhaustedByQa(54);
    const oldHash = await t.hashOf(id);
    const oldQaOp = Number(t.qa().at(-1)!.inputs.op);
    t.h.replanPlan = NEW_PLAN;
    expect(await t.decide(id, (await t.pendingApproval(id)).id, "approved")).toBe("applied");
    const newHash = await t.hashOf(id);
    expect(newHash).not.toBe(oldHash);
    const newQaOp = Number(t.qa().at(-1)!.inputs.op);
    expect(newQaOp).toBeGreaterThan(oldQaOp);

    // The old revision's QA run reports late: usage is recorded, the event is not, nothing moves.
    const events = async () => (await t.sql<{ n: number }>("SELECT count(*)::int AS n FROM agent_events WHERE task_id = $1", [id]))[0]!.n;
    const eventsBefore = await events();
    expect(await t.send(id, t.report(id, { agent: "qa", job: "end", op: oldQaOp, event_type: "approved", contract: oldHash, usage: [line(11)] }))).toBe("stale");
    expect(await t.usageRows(id)).toHaveLength(1);
    expect(await events()).toBe(eventsBefore);
    // A report of the new op under the old hash is obsolete too, and does not start the new attempt.
    expect(await t.send(id, t.report(id, { agent: "qa", job: "start", op: newQaOp, event_type: "qa_reviewing", contract: oldHash }))).toBe("stale");
    expect((await t.attempts(id)).at(-1)).toMatchObject({ revision: 2, started: false });
    expect(await events()).toBe(eventsBefore);

    // An approval now (the new attempt has not started) is not applied; the task is still waiting on QA.
    expect(await t.send(id, t.reviewEvent(id, 54, head, "approved"))).toBe("stale");
    expect(t.h.gh.merges).toHaveLength(0);
    expect(await t.state(id)).toMatchObject({ phase: "qa" });
    // After the matching start report of the new revision, the same approval is applied.
    expect(await t.startQa(id, newQaOp)).toBe("applied");
    expect(await t.send(id, t.reviewEvent(id, 54, head, "approved"))).toBe("applied");
    expect(t.h.gh.merges).toHaveLength(1);
    expect((await t.evidence(id)).filter((e) => e.kind === "qa" && e.outcome === "approved").map((e) => [e.revision, e.attempt_key])).toEqual([[2, `task-${id}/dispatch/${newQaOp}`]]);
  });

  it("a replan whose contract text fails the sanitizer goes to the owner first; approving releases it without publishing anything", async () => {
    await t.sql("INSERT INTO contacts (name, aliases) VALUES ('Jane Doe', '{Janie}') ON CONFLICT DO NOTHING");
    const { id } = await exhaustedByQa(55);
    t.h.replanPlan = { ...NEW_PLAN, body: "Ask Jane Doe about the route." };
    expect(await t.decide(id, (await t.pendingApproval(id)).id, "approved")).toBe("applied");
    const text = await t.pendingApproval(id);
    expect(text.kind).toBe("issue_text");
    expect(await t.state(id)).toMatchObject({ phase: "owner", owner_wait: "issue_text", pending_revision: 2 });
    expect((await t.revisions(id)).map((r) => r.superseded)).toEqual([false]); // nothing superseded before the release
    const qaBefore = t.qa().length;
    expect(await t.decide(id, text.id, "approved")).toBe("applied");
    expect(t.h.gh.issues).toHaveLength(1);
    expect((await t.state(id)).contract).toMatchObject({ revision: 2, goal: "Ask Jane Doe about the route." });
    expect((await t.revisions(id)).map((r) => r.superseded)).toEqual([true, false]);
    expect(t.qa()).toHaveLength(qaBefore + 1);
  });

  it("a task without an issue plans again as before (no revision records)", async () => {
    t.h.plan = { ...NEW_PLAN, acceptance: [] }; // not a valid contract: the owner gets a planning failure with no PR and no issue
    const id = await t.newTask();
    await t.start(id);
    const a = await t.pendingApproval(id);
    expect(a.reasons[1]).toBe("Approve to plan the task again; reject to mark the task failed.");
    expect(await t.revisions(id)).toEqual([]);
  });
});
