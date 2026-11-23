// AR9a: a Developer run that ends without new commits goes to the owner at once (a replan for a task
// with a contract) instead of waiting out the timeout and a blind redispatch. Only a run whose end report
// arrived counts; the first sweep that sees it completed only marks it, so a late push still wins; a run
// without an end report (lost), a cancelled run and a running one keep the timeout.
import { describe, expect, it } from "vitest";
import { MAX_ATTEMPTS, WAIT_LIMIT_MINUTES } from "../src/graph";
import { replanFailure } from "../src/graph/machine";
import { harness, sha } from "./revisions-harness";

const REPLAN_TEXT =
  "Approve to replan the task (new contract revision; the PR is kept, CI is reused for an unchanged head, QA reviews again); reject to mark it failed.";

describe("a Developer run that ends without new commits (AR9a)", () => {
  const t = harness();
  const advance = (minutes: number) => {
    t.h.clock = new Date(t.h.clock.getTime() + minutes * 60_000);
  };
  /** The registered run of the latest Developer dispatch. */
  const devRun = () => {
    const op = t.dev().at(-1)!.inputs.op;
    return t.h.gh.workflowRuns.find((r) => r.workflow === "agent-developer.yml" && r.displayTitle.endsWith(` op ${op}`))!;
  };

  /** The end report of the latest Developer dispatch (what the run's report job sends). */
  const endReport = async (id: number, fields: Record<string, unknown>) => {
    const op = Number(t.dev().at(-1)!.inputs.op);
    return t.send(id, t.report(id, { agent: "developer", job: "end", op, contract: await t.hashOf(id), ...fields }));
  };
  const usage = [{ kind: "model", provider: "deepseek", model: "synthetic-model", input_tokens: 10, output_tokens: 1, call: { job: "work", index: 0 } }];

  /** QA requested changes once; the Developer fix run is dispatched and registered. */
  async function fixDispatched(pr: number) {
    t.h.gh.registerRuns = true;
    const id = await t.newTask();
    await t.start(id);
    const head = sha(`${id}-1`);
    await t.openPr(id, pr, head);
    expect(await t.send(id, t.ciEvent(id, pr, head, "success"))).toBe("applied");
    const op = Number(t.qa().at(-1)!.inputs.op);
    expect(await t.startQa(id, op)).toBe("applied");
    expect(await t.send(id, t.reviewEvent(id, pr, head, "changes_requested"))).toBe("applied");
    expect(t.dev().at(-1)!.inputs.mode).toBe("fix");
    expect(await t.task(id)).toMatchObject({ waiting_on: "dev", attempts: 1 });
    return { id, head };
  }

  it("the second sweep that sees the completed run asks the owner to replan, with a fixed failure line", async () => {
    const { id } = await fixDispatched(61);
    const devBefore = t.dev().length;
    advance(5);
    expect(await t.send(id, t.sweep(id))).toBe("unchanged"); // still running
    Object.assign(devRun(), { status: "completed", conclusion: "failure" });
    t.h.gh.calls.length = 0;
    expect(await t.send(id, t.sweep(id))).toBe("unchanged"); // no end report yet: not looked up
    expect(t.h.gh.calls.map((c) => c.method)).not.toContain("findWorkflowRun");
    expect(await endReport(id, { event_type: "failed" })).toBe("applied");
    expect(await t.send(id, t.sweep(id))).toBe("applied"); // marked only
    expect(await t.task(id)).toMatchObject({ waiting_on: "dev" });
    advance(15);
    expect(await t.send(id, t.sweep(id))).toBe("applied");
    expect(await t.task(id)).toMatchObject({ waiting_on: "owner" });
    const a = await t.pendingApproval(id);
    expect(a.reasons).toEqual([
      "Task failed: The Developer run ended (failure) without new commits on PR #61. It may need paths outside the task contract, or it ran out of turns.",
      REPLAN_TEXT,
    ]);
    expect(await t.state(id)).toMatchObject({ owner_wait: "failure", retry: "plan", failure_note: "no_commits", dev_run_ended: null });
    // Nothing was redispatched: one Developer run of the same contract is enough.
    expect(t.dev()).toHaveLength(devBefore);

    expect(await t.decide(id, a.id, "approved")).toBe("applied");
    const request = t.h.planRequests.at(-1)!;
    expect(request.failure).toBe(replanFailure(1, 1, "no_commits"));
    expect(request.failure).toContain("widen the scope");
    expect(await t.state(id)).toMatchObject({ revision: 2 });
  });

  it("a successful run without a push (the Developer stopped on a contract conflict) goes the same way", async () => {
    const { id } = await fixDispatched(62);
    Object.assign(devRun(), { status: "completed", conclusion: "success" });
    await endReport(id, { usage }); // a successful end sends usage only
    await t.send(id, t.sweep(id));
    advance(15);
    await t.send(id, t.sweep(id));
    expect((await t.pendingApproval(id)).reasons[0]).toContain("The Developer run ended (success) without new commits");
  });

  it("a push that arrives after the first sweep wins: CI runs, no owner", async () => {
    const { id } = await fixDispatched(63);
    Object.assign(devRun(), { status: "completed", conclusion: "success" });
    await endReport(id, { usage });
    expect(await t.send(id, t.sweep(id))).toBe("applied");
    await t.push(id, 63, sha(`${id}-2`));
    expect(await t.task(id)).toMatchObject({ waiting_on: "ci" });
    advance(15);
    expect(await t.send(id, t.sweep(id))).toBe("unchanged");
    expect(await t.task(id)).toMatchObject({ waiting_on: "ci" });
  });

  it("a cancelled run keeps the timeout and its one redispatch", async () => {
    const { id } = await fixDispatched(64);
    Object.assign(devRun(), { status: "completed", conclusion: "cancelled" });
    await endReport(id, { event_type: "failed" });
    const devBefore = t.dev().length;
    expect(await t.send(id, t.sweep(id))).toBe("unchanged");
    advance(WAIT_LIMIT_MINUTES.dev + 1);
    expect(await t.send(id, t.sweep(id))).toBe("applied");
    expect(t.dev()).toHaveLength(devBefore + 1);
    expect(await t.task(id)).toMatchObject({ waiting_on: "dev" });
  });

  it("a run that completed without an end report is lost: the timeout redispatches it", async () => {
    const { id } = await fixDispatched(65);
    Object.assign(devRun(), { status: "completed", conclusion: "failure" });
    const devBefore = t.dev().length;
    advance(15);
    expect(await t.send(id, t.sweep(id))).toBe("unchanged");
    advance(WAIT_LIMIT_MINUTES.dev);
    expect(await t.send(id, t.sweep(id))).toBe("applied");
    expect(t.dev()).toHaveLength(devBefore + 1);
    expect(await t.task(id)).toMatchObject({ waiting_on: "dev" });
  });

  it("an end report of an earlier Developer dispatch does not count", async () => {
    const { id } = await fixDispatched(66);
    const earlier = Number(t.dev().at(-2)!.inputs.op);
    Object.assign(devRun(), { status: "completed", conclusion: "failure" });
    expect(await t.send(id, t.report(id, { agent: "developer", job: "end", op: earlier, event_type: "failed", contract: await t.hashOf(id) }))).toBe("stale");
    await t.send(id, t.sweep(id));
    advance(15);
    await t.send(id, t.sweep(id));
    expect(await t.task(id)).toMatchObject({ waiting_on: "dev" });
  });

  it("the attempts line is unchanged when attempts ran out", () => {
    expect(replanFailure(2, MAX_ATTEMPTS, null)).toBe(`Revision 2 used ${MAX_ATTEMPTS} of ${MAX_ATTEMPTS} attempts without an approved QA review.`);
  });
});
