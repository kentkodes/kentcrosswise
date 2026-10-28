// RUN-ID-MAPPING-SPEC §3: agent workflow runs map to tasks by run id (agent_dispatches), with the
// run title as a cross-check and fallback. The replay fixture holds only the fields the spec records
// for the task 3 delivery 60c99360-d217-11f1-9b86-3796395aa21c (never the full payload).
import { describe, expect, it } from "vitest";
import {
  DISPATCH_LOOKUPS,
  DISPATCH_LOOKUP_DELAY_MS,
  handleDelivery,
  normalize,
  signBody,
  type RelayDeps,
  type RelayRequest,
} from "../src/index";
import { ALLOWED, DELIVERY, FakeQueue, FakeStore, IDS, SECRET, fixture, type Payload } from "./helpers";

const RUN = 40526955264;
const SENDER = 346712150;
const REPO = 1430035147;

/** The task 3 replay. The spec records no sender login; the relay needs one, so a synthetic one is added here. */
function replay(): Payload {
  const p = fixture("workflow_run.requested.task3");
  p.sender.login = "synthetic-sender";
  return p;
}

/** A completed agent run like the one GitHub sent later, with the evaluated title. */
function completed(title = "developer task 3"): Payload {
  const p = replay();
  p.action = "completed";
  Object.assign(p.workflow_run, {
    display_title: title,
    status: "completed",
    conclusion: "success",
    run_started_at: "2026-10-28T10:00:02Z",
    updated_at: "2026-10-28T10:12:02Z",
  });
  return p;
}

function request(payload: unknown, delivery = DELIVERY): RelayRequest {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  return {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-github-event": "workflow_run",
      "x-github-delivery": delivery,
      "x-hub-signature-256": signBody(body, SECRET),
    },
  };
}

function setup() {
  const store = new FakeStore(new Map([[12, 42]]), new Map([[11, 41]]));
  const queue = new FakeQueue();
  const logs: string[] = [];
  const sleeps: number[] = [];
  const deps: RelayDeps = {
    secret: SECRET,
    allowedSenderIds: new Set([...ALLOWED, SENDER]),
    store,
    queue,
    log: (l) => logs.push(l),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { store, queue, logs, sleeps, run: (req: RelayRequest) => handleDelivery(req, deps) };
}

describe("normalize: agent_run identity", () => {
  it("the task 3 replay (title not yet evaluated) passes the guards: agent_run, no title task id", () => {
    const r = normalize("workflow_run", replay());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.event).toBe("workflow_run.requested");
    expect(r.value.hint.agent_run).toEqual({ run_id: RUN, role: "developer" });
    expect(r.value.hint.agent_task_id).toBeUndefined();
    expect(r.value.payload).not.toHaveProperty("agent_task_id");
    expect(JSON.stringify(r.value)).not.toContain("display_title");
  });

  it("a matching title keeps agent_task_id and also exposes agent_run", () => {
    const r = normalize("workflow_run", completed());
    expect(r.ok && r.value.hint).toMatchObject({ agent_task_id: 3, agent_run: { run_id: RUN, role: "developer" } });
  });

  it.each<[string, (p: Payload) => void]>([
    ["a non-agent path", (p) => (p.workflow_run.path = ".github/workflows/ci.yml")],
    ["a look-alike path", (p) => (p.workflow_run.path = ".github/workflows/agent-developer.yml@refs/heads/x")],
    ["a push event", (p) => (p.workflow_run.event = "push")],
    ["another branch", (p) => (p.workflow_run.head_branch = "kcw/task-3")],
    ["another head repository", (p) => (p.workflow_run.head_repository = { id: 999 })],
    ["no head repository", (p) => delete p.workflow_run.head_repository],
  ])("failed guards (%s): no agent_run, no title task id", (_label, edit) => {
    for (const p of [replay(), completed()]) {
      edit(p);
      const r = normalize("workflow_run", p);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.hint.agent_run).toBeUndefined();
      expect(r.value.hint.agent_task_id).toBeUndefined();
    }
  });
});

describe("relay: run id mapping", () => {
  it("forwards the task 3 replay to the task of its stored dispatch row", async () => {
    const t = setup();
    t.store.byRun.set(RUN, { task_id: 3, role: "developer" });
    const r = await t.run(request(replay()));
    expect(r).toEqual({ status: 200, body: { result: "forwarded" } });
    expect(t.store.calls).toEqual(["dispatch", "claim"]);
    expect(t.sleeps).toEqual([]);
    expect(t.queue.sent).toHaveLength(1);
    const m = t.queue.sent[0]!;
    expect(m).toMatchObject({ task_id: 3, thread_id: "task-3", resume: { event: "workflow_run.requested", head_sha: null } });
    // The orchestrator's recordRun requires the relay-derived task id on the payload (unchanged contract).
    expect(m.resume.payload).toMatchObject({ type: "workflow_run", run_id: RUN, run_attempt: 1, agent_task_id: 3, trigger: "workflow_dispatch", head_branch: "main" });
    expect(t.logs).toEqual([`relay: forwarded event=workflow_run delivery=${DELIVERY} task-3 workflow_run.requested map=dispatch`]);
  });

  it(`without a row: ${DISPATCH_LOOKUPS} lookups ~${DISPATCH_LOOKUP_DELAY_MS} ms apart, then 503 dispatch_pending with no claim`, async () => {
    const t = setup();
    const r = await t.run(request(replay()));
    expect(r).toEqual({ status: 503, body: { result: "error", reason: "dispatch_pending" } });
    expect(DISPATCH_LOOKUPS).toBe(3);
    expect(t.store.dispatchLookups).toBe(3);
    expect(t.sleeps).toEqual([DISPATCH_LOOKUP_DELAY_MS, DISPATCH_LOOKUP_DELAY_MS]);
    expect(DISPATCH_LOOKUP_DELAY_MS).toBe(1000);
    expect(t.store.calls).toEqual(["dispatch", "dispatch", "dispatch"]);
    expect(t.store.claimed.size).toBe(0);
    expect(t.queue.sent).toEqual([]);
    expect(t.logs).toEqual([`relay: error (dispatch_pending) event=workflow_run delivery=${DELIVERY} role=developer action=requested`]);
    // GitHub's redelivery (same delivery id) is then processed normally once the row exists.
    t.store.byRun.set(RUN, { task_id: 3, role: "developer" });
    expect((await t.run(request(replay()))).body.result).toBe("forwarded");
  });

  it("a never-mapped completed run (no row, no title) logs fixed role and action fields only", async () => {
    const t = setup();
    const p = completed("agent-scraper");
    p.workflow_run.path = ".github/workflows/agent-scraper.yml";
    const r = await t.run(request(p));
    expect(r).toEqual({ status: 503, body: { result: "error", reason: "dispatch_pending" } });
    expect(t.logs).toEqual([
      `relay: error (dispatch_pending) event=workflow_run delivery=${DELIVERY} role=scraper action=completed minutes=12`,
    ]);
    expect(t.logs[0]).not.toContain("agent-scraper");
    expect(t.store.claimed.size).toBe(0);
  });

  it("a row that appears during the lookups is used", async () => {
    const t = setup();
    t.store.onDispatchLookup = (n) => {
      if (n === 2) t.store.byRun.set(RUN, { task_id: 3, role: "developer" });
    };
    expect((await t.run(request(replay()))).body.result).toBe("forwarded");
    expect(t.store.dispatchLookups).toBe(2);
    expect(t.sleeps).toEqual([DISPATCH_LOOKUP_DELAY_MS]);
    expect(t.queue.sent[0]).toMatchObject({ task_id: 3 });
  });

  it("a row whose role differs from the path role: 202 dispatch_mismatch, no claim", async () => {
    const t = setup();
    t.store.byRun.set(RUN, { task_id: 3, role: "qa" });
    expect(await t.run(request(replay()))).toEqual({ status: 202, body: { result: "ignored", reason: "dispatch_mismatch" } });
    expect(t.store.claimed.size).toBe(0);
    expect(t.queue.sent).toEqual([]);
  });

  it("a title task id that conflicts with the row: 202 dispatch_mismatch, no claim", async () => {
    const t = setup();
    t.store.byRun.set(RUN, { task_id: 3, role: "developer" });
    const p = replay();
    p.workflow_run.display_title = "developer task 4";
    expect(await t.run(request(p))).toEqual({ status: 202, body: { result: "ignored", reason: "dispatch_mismatch" } });
    expect(t.store.claimed.size).toBe(0);
    expect(t.queue.sent).toEqual([]);
  });

  it("a title that agrees with the row is forwarded once, without retries", async () => {
    const t = setup();
    t.store.byRun.set(RUN, { task_id: 3, role: "developer" });
    expect((await t.run(request(completed()))).body.result).toBe("forwarded");
    expect(t.store.dispatchLookups).toBe(1);
    expect(t.queue.sent[0]).toMatchObject({ task_id: 3, resume: { event: "workflow_run.completed", payload: { agent_task_id: 3 } } });
  });

  it("no row but a title: the title decides, as before (one lookup, no wait)", async () => {
    const t = setup();
    const r = await t.run(request(completed()));
    expect(r.body.result).toBe("forwarded");
    expect(t.store.dispatchLookups).toBe(1);
    expect(t.sleeps).toEqual([]);
    expect(t.queue.sent[0]).toMatchObject({ task_id: 3, resume: { payload: { agent_task_id: 3 } } });
    expect(t.logs[0]).toMatch(/ task-3 workflow_run\.completed .*map=title$/);
  });

  it.each<[string, (p: Payload) => void]>([
    ["wrong path", (p) => (p.workflow_run.path = ".github/workflows/ci.yml")],
    ["push event", (p) => (p.workflow_run.event = "push")],
    ["another branch", (p) => (p.workflow_run.head_branch = "feature")],
    ["another head repository", (p) => (p.workflow_run.head_repository = { id: 999 })],
    ["another repository", (p) => (p.repository = { id: 999 })],
  ])("failed guards (%s) are never looked up in agent_dispatches", async (_label, edit) => {
    const t = setup();
    t.store.byRun.set(RUN, { task_id: 3, role: "developer" });
    const p = replay();
    edit(p);
    const r = await t.run(request(p));
    expect(r).toEqual({ status: 202, body: { result: "ignored", reason: "no_task" } });
    expect(t.store.calls).not.toContain("dispatch");
    expect(t.sleeps).toEqual([]);
    expect(t.queue.sent).toEqual([]);
  });

  it("a stranger sender is dropped before any lookup", async () => {
    const t = setup();
    const p = replay();
    p.sender.id = IDS.stranger;
    expect(await t.run(request(p))).toEqual({ status: 202, body: { result: "ignored", reason: "sender" } });
    expect(t.store.calls).toEqual([]);
  });

  it("a database failure during the lookup is a 500 and nothing is claimed", async () => {
    const t = setup();
    t.store.failWith = Object.assign(new Error("synthetic"), { name: "DatabaseError" });
    expect(await t.run(request(replay()))).toEqual({ status: 500, body: { result: "error", reason: "db" } });
    expect(t.store.claimed.size).toBe(0);
    expect(t.sleeps).toEqual([]);
  });

  it("Actions minutes of a completed run are recorded as before, also on a mismatch", async () => {
    const t = setup();
    t.store.byRun.set(RUN, { task_id: 3, role: "developer" });
    await t.run(request(completed(), "5f1a0c2e-0000-4000-8000-000000000101"));
    expect(t.store.minutes.get(`github:workflow_run:${RUN}:1`)).toMatchObject({ taskId: 3, usage: { agent: "developer", minutes: 12 } });

    const m = setup();
    m.store.byRun.set(RUN, { task_id: 3, role: "developer" });
    const r = await m.run(request(completed("developer task 4")));
    expect(r.body).toEqual({ result: "ignored", reason: "dispatch_mismatch" });
    expect(m.store.minutes.get(`github:workflow_run:${RUN}:1`)).toMatchObject({ taskId: null, usage: { minutes: 12 } });
  });

  it("uses the synthetic repository ids of the fixture only through the guards", () => {
    expect(replay().repository.id).toBe(REPO);
    expect(replay().workflow_run.head_repository.id).toBe(REPO);
  });
});
