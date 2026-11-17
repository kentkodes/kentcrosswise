// AR6 active execution reservations: a worker run holds `status = 'waiting' AND waiting_on IN ('dev','qa')`,
// separate from the admitted-work slot. The store as orch_rw on PGlite, the machine through the SQS handler
// with the fake GitHub client. ACTIVE_EXECUTION_LIMIT (1 for rollout) is below IN_FLIGHT_LIMIT (4); the tests
// fill the reservations by SQL, or pass a limit argument of 1 to the store.
import { describe, expect, it } from "vitest";
import { capacitySummary } from "../../../apps/web/src/server/console";
import { ACTIVE_EXECUTION_LIMIT, IN_FLIGHT_LIMIT, WAIT_LIMIT_MINUTES } from "../src/graph";
import { harness } from "./revisions-harness";

describe("active execution reservations (AR6)", () => {
  const t = harness();

  const minutes = (n: number) => {
    t.h.clock = new Date(t.h.clock.getTime() + n * 60_000);
  };
  const row = async (id: number) =>
    (await t.sql<{ status: string; waiting_on: string | null; execution_wait: string | null }>("SELECT status, waiting_on, execution_wait FROM tasks WHERE id = $1", [id]))[0]!;
  const holders = async () =>
    Number((await t.sql<{ n: string }>("SELECT count(*) AS n FROM tasks WHERE status = 'waiting' AND waiting_on IN ('dev','qa')"))[0]!.n);
  /** A task row in a given state, without a graph thread. */
  async function seed(status: string, waitingOn: string | null): Promise<number> {
    const id = await t.newTask();
    await t.sql("UPDATE tasks SET status = $2, waiting_on = $3 WHERE id = $1", [id, status, waitingOn]);
    return id;
  }
  const queryable = { query: async <R>(text: string, params?: unknown[]) => ({ rows: (await t.sql(text, params)) as R[] }) };

  it("rolls out with one active worker under four admitted tasks (owner decision for AR9)", () => {
    expect([ACTIVE_EXECUTION_LIMIT, IN_FLIGHT_LIMIT]).toEqual([1, 4]);
  });

  // The harness serves PGlite over one connection, so the two claims run one after the other here: this pins the
  // outcome, not the advisory lock under real concurrency (claimSlot's lock and transaction shape, reused).
  it("two claims at limit 1: exactly one wins; the loser records its role in execution_wait", async () => {
    const a = await seed("planning", null);
    const b = await seed("planning", null);
    const results = await Promise.all([t.deps.store.claimExecution(a, "developer", 1), t.deps.store.claimExecution(b, "qa", 1)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const [winner, loser] = results[0] ? [a, b] : [b, a];
    expect(await row(winner)).toEqual({ status: "waiting", waiting_on: winner === a ? "dev" : "qa", execution_wait: null });
    expect(await row(loser)).toMatchObject({ status: "planning", execution_wait: loser === a ? "developer" : "qa" });
    expect(await holders()).toBe(1);
  });

  it("a task that holds a reservation claims nothing twice, even at the limit", async () => {
    const a = await seed("planning", null);
    const b = await seed("planning", null);
    expect(await t.deps.store.claimExecution(a, "developer", 1)).toBe(true);
    expect(await t.deps.store.claimExecution(a, "developer", 1)).toBe(true); // a re-run or redelivered step
    expect(await t.deps.store.claimExecution(a, "qa", 1)).toBe(true); // a redispatch of the holder
    expect(await holders()).toBe(1);
    expect(await t.deps.store.claimExecution(b, "developer", 1)).toBe(false);
  });

  it("four owner waits hold no reservation and do not block a worker dispatch; the capacity line shows active 0, owner 4", async () => {
    for (let i = 0; i < 4; i += 1) await seed("waiting", "owner");
    expect(await capacitySummary(queryable)).toMatchObject({ active: 0, admitted: 4, parked: { owner: 4, ci: 0, worker: 0 } });
    const fifth = await seed("planning", null);
    expect(await t.deps.store.claimExecution(fifth, "qa", 1)).toBe(true);
    expect(await capacitySummary(queryable)).toMatchObject({ active: 1, parked: { owner: 4 } });
  });

  it("a parent with children holds no reservation", async () => {
    const parent = await seed("waiting", "dev");
    await t.sql("UPDATE tasks SET parent_id = $1 WHERE id = $2", [parent, await seed("queued", null)]);
    const b = await seed("planning", null);
    expect(await t.deps.store.claimExecution(b, "developer", 1)).toBe(true);
  });

  it("backpressure: a refused Developer dispatch is queued, with no dispatch; when a holder moves on, the next sweep dispatches it", async () => {
    const holdersList = [];
    for (let i = 0; i < ACTIVE_EXECUTION_LIMIT; i += 1) holdersList.push(await seed("waiting", "dev"));
    const b = await t.newTask();
    await t.sql("UPDATE tasks SET status = 'planning' WHERE id = $1", [b]); // already admitted
    expect(await t.start(b)).toBe("queued");
    expect(t.dev()).toHaveLength(0);
    expect(await row(b)).toMatchObject({ status: "planning", execution_wait: "developer" });
    expect(await t.state(b)).toMatchObject({ pending_capacity: { role: "dev", mode: "implement", redispatched: false } });
    expect(await t.send(b, t.sweep(b))).toBe("queued"); // still full
    expect(t.dev()).toHaveLength(0);

    await t.sql("UPDATE tasks SET waiting_on = 'ci' WHERE id = $1", [holdersList[0]]); // a holder moves on
    expect(await t.send(b, t.sweep(b))).toBe("applied");
    expect(t.dev()).toHaveLength(1);
    expect(await row(b)).toEqual({ status: "waiting", waiting_on: "dev", execution_wait: null });
    expect(await t.state(b)).toMatchObject({ phase: "dev", pending_capacity: null });
    expect(await holders()).toBe(ACTIVE_EXECUTION_LIMIT);
  });

  it("a QA dispatch is refused the same way: no QA run, the task waits in CI with execution_wait qa; a later sweep dispatches it", async () => {
    const a = await t.newTask();
    await t.start(a);
    await t.openPr(a, 51, "a".repeat(40));
    expect(await row(a)).toMatchObject({ status: "waiting", waiting_on: "ci" });
    const others: number[] = [];
    for (let i = 0; i < ACTIVE_EXECUTION_LIMIT; i += 1) others.push(await seed("waiting", "qa"));
    expect(await t.send(a, t.ciEvent(a, 51, "a".repeat(40), "success"))).toBe("queued");
    expect(t.qa()).toHaveLength(0);
    expect(await row(a)).toEqual({ status: "waiting", waiting_on: "ci", execution_wait: "qa" });
    expect(await t.send(a, t.sweep(a))).toBe("queued"); // still full
    expect(t.qa()).toHaveLength(0);

    await t.sql("UPDATE tasks SET waiting_on = 'owner' WHERE id = $1", [others[0]]); // a holder moves on
    expect(await t.send(a, t.sweep(a))).toBe("applied");
    expect(t.qa()).toHaveLength(1);
    expect(await row(a)).toEqual({ status: "waiting", waiting_on: "qa", execution_wait: null });
    expect(await holders()).toBe(ACTIVE_EXECUTION_LIMIT);
  });

  it("a dispatch GitHub refuses (4xx) creates no run and keeps no reservation; the re-run of the step claims again", async () => {
    const a = await t.newTask();
    const msg = { type: "task.created", task_id: a };
    t.h.gh.failNext("dispatchWorkflow", 422);
    expect(await t.send(a, msg, `refused-${a}`)).toBe("failed");
    expect(t.dev()).toHaveLength(0);
    expect(await row(a)).toMatchObject({ status: "planning", waiting_on: null });
    expect(await holders()).toBe(0);
    expect(await t.send(a, msg, `refused-${a}`)).toBe("recovered"); // the redelivery uses the next dispatch key
    expect(t.dev()).toHaveLength(1);
    expect(await row(a)).toEqual({ status: "waiting", waiting_on: "dev", execution_wait: null });
    expect(await holders()).toBe(1);
  });

  it("pause and restart: a reservation survives a pause that cancels the run; the count stays 1 and a second task is still refused at limit 1", async () => {
    const a = await t.newTask();
    expect(await t.start(a)).toBe("started");
    expect(await holders()).toBe(1);
    t.h.gh.runningRuns.add(t.dev()[0]!.runId!);
    await t.sql("UPDATE system_flags SET value = 'true' WHERE key = 'agents_paused'");
    await t.h.gh.cancelRun(t.dev()[0]!.runId!); // the sweeper's pause-all
    minutes(5);
    expect(await t.send(a, t.sweep(a))).toBe("paused");
    await t.sql("UPDATE system_flags SET value = 'false' WHERE key = 'agents_paused'");
    // The rows are the record: the count and every claim read them, not a checkpoint or an in-memory state.
    expect(await holders()).toBe(1);
    expect(await row(a)).toMatchObject({ status: "waiting", waiting_on: "dev" });
    const b = await seed("planning", null);
    expect(await t.deps.store.claimExecution(b, "developer", 1)).toBe(false);
    expect(await t.deps.store.claimExecution(a, "developer", 1)).toBe(true);
    expect(await holders()).toBe(1);
  });

  it("missing completion: the run completed without a report; the timeout marks the attempt lost and redispatches within the same reservation", async () => {
    t.h.gh.registerRuns = true;
    const a = await t.newTask();
    await t.start(a);
    t.h.gh.workflowRuns[0]!.status = "completed";
    t.h.gh.workflowRuns[0]!.conclusion = "failure";
    expect(await holders()).toBe(1);
    minutes(WAIT_LIMIT_MINUTES.dev + 1);
    expect(await t.send(a, t.sweep(a))).toBe("applied");
    expect(t.h.gh.cancelled).toEqual([]);
    expect(t.dev()).toHaveLength(2);
    expect((await t.attempts(a)).map((r) => [r.op, r.outcome])).toEqual([[0, "lost"], [1, null]]);
    expect(await holders()).toBe(1);
    expect(await row(a)).toEqual({ status: "waiting", waiting_on: "dev", execution_wait: null });
  });

  it("a run that is not visible at the timeout is lost too, and redispatched", async () => {
    const a = await t.newTask();
    await t.start(a);
    t.h.gh.hideRuns = true;
    minutes(WAIT_LIMIT_MINUTES.dev + 1);
    expect(await t.send(a, t.sweep(a))).toBe("applied");
    expect(t.dev()).toHaveLength(2);
    expect((await t.attempts(a)).map((r) => r.outcome)).toEqual(["lost", null]);
    expect(await holders()).toBe(1);
  });

  it("a run still running at the timeout is cancelled and not replaced; a later sweep with the run completed redispatches exactly once", async () => {
    t.h.gh.registerRuns = true;
    const a = await t.newTask();
    await t.start(a);
    const runId = t.dev()[0]!.runId!;
    t.h.gh.runningRuns.add(runId);
    t.h.gh.workflowRuns[0]!.status = "in_progress";
    minutes(WAIT_LIMIT_MINUTES.dev + 1);
    expect(await t.send(a, t.sweep(a))).toBe("unchanged");
    expect(t.h.gh.cancelled).toEqual([runId]);
    expect(t.dev()).toHaveLength(1);
    expect((await t.attempts(a)).map((r) => r.outcome)).toEqual([null]);
    expect(await holders()).toBe(1); // the reservation is kept

    t.h.gh.workflowRuns[0]!.status = "completed";
    t.h.gh.workflowRuns[0]!.conclusion = "cancelled";
    expect(await t.send(a, t.sweep(a))).toBe("applied");
    expect(t.dev()).toHaveLength(2);
    expect((await t.attempts(a)).map((r) => r.outcome)).toEqual(["lost", null]);
    minutes(1);
    expect(await t.send(a, t.sweep(a))).toBe("unchanged"); // the redispatched run is within its limit
    expect(t.dev()).toHaveLength(2);
    expect(await holders()).toBe(1);
  });

  it("a redelivered start message dispatches and claims nothing twice", async () => {
    const a = await t.newTask();
    const msg = { type: "task.created", task_id: a };
    expect(await t.send(a, msg, "same")).toBe("started");
    expect(await t.send(a, msg, "same")).toBe("duplicate_start");
    expect(t.dev()).toHaveLength(1);
    expect(await holders()).toBe(1);
  });

  it("paths out of the Developer wait release the reservation: the PR moves the task to CI; a second timeout parks it for the owner; rejecting ends it", async () => {
    const a = await t.newTask();
    await t.start(a);
    await t.openPr(a, 61, "b".repeat(40));
    expect(await row(a)).toMatchObject({ waiting_on: "ci", execution_wait: null });
    expect(await holders()).toBe(0);
    const c = await t.newTask();
    await t.start(c);
    expect(await holders()).toBe(1);
    t.h.gh.hideRuns = true;
    minutes(WAIT_LIMIT_MINUTES.dev + 1);
    expect(await t.send(c, t.sweep(c))).toBe("applied"); // the one redispatch, within the reservation
    expect(await holders()).toBe(1);
    minutes(WAIT_LIMIT_MINUTES.dev + 1);
    expect(await t.send(c, t.sweep(c))).toBe("applied"); // the second timeout goes to the owner
    expect(await row(c)).toMatchObject({ status: "waiting", waiting_on: "owner" });
    expect(await holders()).toBe(0);
    expect(await t.decide(c, (await t.pendingApproval(c)).id, "rejected")).toBe("applied");
    expect(await row(c)).toMatchObject({ status: "failed", waiting_on: null });
  });
});
