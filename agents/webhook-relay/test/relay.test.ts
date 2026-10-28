import { describe, expect, it } from "vitest";
import {
  PACKAGE_NAME,
  actionsMinutesOf,
  handleDelivery,
  normalize,
  signBody,
  type RelayDeps,
  type RelayRequest,
} from "../src/index";
import { ALLOWED, DELIVERY, FakeQueue, FakeStore, IDS, SECRET, fixture, type Fixture, type Payload } from "./helpers";

function request(event: string, payload: unknown, over: Partial<RelayRequest> & { headers?: Record<string, string | undefined> } = {}): RelayRequest {
  const body = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
  return {
    method: "POST",
    body,
    ...over,
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": DELIVERY,
      "x-hub-signature-256": signBody(body, SECRET),
      ...over.headers,
    },
  };
}

function setup(opts: { store?: FakeStore } = {}) {
  const store = opts.store ?? new FakeStore(new Map([[12, 42]]), new Map([[11, 41]]));
  const queue = new FakeQueue();
  const logs: string[] = [];
  const deps: RelayDeps = { secret: SECRET, allowedSenderIds: ALLOWED, store, queue, log: (l) => logs.push(l) };
  return { store, queue, logs, deps, run: (req: RelayRequest) => handleDelivery(req, deps) };
}

const EVENT_OF: Record<Fixture, string> = {
  "issues.closed": "issues",
  "pull_request.opened": "pull_request",
  "pull_request_review.submitted": "pull_request_review",
  push: "push",
  "workflow_run.completed": "workflow_run",
  "workflow_run.requested.task3": "workflow_run",
};

describe("@kcw/webhook-relay", () => {
  it("is importable", () => {
    expect(PACKAGE_NAME).toBe("@kcw/webhook-relay");
  });
});

describe("signature", () => {
  it("valid: forwards", async () => {
    const t = setup();
    expect(await t.run(request("pull_request", fixture("pull_request.opened")))).toEqual({
      status: 200,
      body: { result: "forwarded" },
    });
  });

  it.each<[string, Record<string, string | undefined>, string]>([
    ["missing", { "x-hub-signature-256": undefined }, "signature_missing"],
    ["invalid", { "x-hub-signature-256": signBody("other body", SECRET) }, "signature_invalid"],
    ["wrong secret", { "x-hub-signature-256": signBody(JSON.stringify(fixture("push")), "nope") }, "signature_invalid"],
  ])("%s: 401 before anything else happens", async (_label, headers, reason) => {
    const t = setup();
    const r = await t.run(request("push", fixture("push"), { headers }));
    expect(r).toEqual({ status: 401, body: { result: "rejected", reason } });
    expect(t.store.calls).toEqual([]);
    expect(t.queue.sent).toEqual([]);
  });

  it("checks the signature before parsing the body", async () => {
    const t = setup();
    const r = await t.run(request("push", "{not json", { headers: { "x-hub-signature-256": "sha256=00" } }));
    expect(r.status).toBe(401);
  });

  it("finds headers in any case", async () => {
    const t = setup();
    const req = request("push", fixture("push"));
    const upper = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toUpperCase(), v]));
    expect((await t.run({ ...req, headers: upper })).body.result).toBe("forwarded");
  });
});

describe("request checks", () => {
  it.each<[string, Partial<RelayRequest> & { headers?: Record<string, string | undefined> }, number, string]>([
    ["GET", { method: "GET" }, 405, "method"],
    ["no event header", { headers: { "x-github-event": undefined } }, 400, "event_header"],
    ["odd event header", { headers: { "x-github-event": "Push;rm" } }, 400, "event_header"],
    ["no delivery header", { headers: { "x-github-delivery": undefined } }, 400, "delivery_header"],
    ["odd delivery header", { headers: { "x-github-delivery": "a b" } }, 400, "delivery_header"],
  ])("%s", async (_label, over, status, reason) => {
    const t = setup();
    expect(await t.run(request("push", fixture("push"), over))).toEqual({ status, body: { result: "rejected", reason } });
    expect(t.queue.sent).toEqual([]);
  });

  it("bad JSON with a valid signature: 400", async () => {
    const t = setup();
    expect(await t.run(request("push", "{not json"))).toEqual({ status: 400, body: { result: "rejected", reason: "json" } });
  });

  it("answers ping", async () => {
    const t = setup();
    expect(await t.run(request("ping", { zen: "Synthetic.", hook_id: 1 }))).toEqual({ status: 200, body: { result: "pong" } });
    expect(t.queue.sent).toEqual([]);
  });
});

describe("sender allowlist", () => {
  it.each<[string, (p: Payload) => void]>([
    ["unknown user", (p) => (p.sender = { login: "someone", id: IDS.stranger, type: "User" })],
    ["login of an allowed bot but another id", (p) => (p.sender = { login: "kcw-qa[bot]", id: IDS.stranger, type: "Bot" })],
    ["no sender", (p) => delete p.sender],
    ["id as a string", (p) => (p.sender = { login: "kcw-qa[bot]", id: String(IDS.qa), type: "Bot" })],
  ])("%s: ignored, nothing stored or sent", async (_label, edit) => {
    const t = setup();
    const p = fixture("push");
    edit(p);
    expect(await t.run(request("push", p))).toEqual({ status: 202, body: { result: "ignored", reason: "sender" } });
    expect(t.store.calls).toEqual([]);
    expect(t.queue.sent).toEqual([]);
  });

  it("every allowlisted id passes", async () => {
    for (const id of ALLOWED) {
      const t = setup();
      const p = fixture("push");
      p.sender.id = id;
      expect((await t.run(request("push", p))).body.result).toBe("forwarded");
    }
  });
});

describe("normalization and task resolution", () => {
  it.each<[Fixture, string, number]>([
    ["pull_request.opened", "pull_request.opened", 42],
    ["pull_request_review.submitted", "pull_request_review.submitted", 42],
    ["workflow_run.completed", "workflow_run.completed", 42],
    ["push", "push", 42],
    ["issues.closed", "issues.closed", 41],
  ])("%s -> message for the task's thread", async (f, event, taskId) => {
    const t = setup();
    const p = fixture(f);
    const r = await t.run(request(EVENT_OF[f], p));
    expect(r.body.result).toBe("forwarded");
    expect(t.queue.sent).toHaveLength(1);
    const m = t.queue.sent[0]!;
    expect(m).toMatchObject({
      source: "github",
      delivery_id: DELIVERY,
      task_id: taskId,
      thread_id: `task-${taskId}`,
      resume: { event },
    });
    expect(m.resume.payload.type).toBe(EVENT_OF[f]);
  });

  it("branch kcw/task-<id> resolves without a database lookup", async () => {
    const t = setup();
    await t.run(request("push", fixture("push")));
    expect(t.store.calls).toEqual(["claim"]);
  });

  it("branch task-<id> also resolves", async () => {
    const t = setup();
    const p = fixture("push");
    p.ref = "refs/heads/task-77";
    await t.run(request("push", p));
    expect(t.queue.sent[0]).toMatchObject({ task_id: 77, thread_id: "task-77" });
  });

  it("falls back to the PR number when the branch is not a task branch", async () => {
    const t = setup();
    const p = fixture("pull_request.opened");
    p.pull_request.head.ref = "owner-hotfix";
    await t.run(request("pull_request", p));
    expect(t.store.calls).toEqual(["byPr", "claim"]);
    expect(t.queue.sent[0]).toMatchObject({ task_id: 42 });
  });

  it("a fork's task-like branch is not trusted; the PR number decides", async () => {
    const t = setup(); // PR 12 -> task 42 in the DB
    const p = fixture("pull_request.opened");
    p.pull_request.head.ref = "kcw/task-5";
    p.pull_request.head.repo = { id: 2000 };
    await t.run(request("pull_request", p));
    expect(t.queue.sent[0]).toMatchObject({ task_id: 42 });
  });

  it("workflow_run on a non-task branch resolves through its PR", async () => {
    const t = setup();
    const w = fixture("workflow_run.completed");
    w.workflow_run.head_branch = "owner-hotfix";
    await t.run(request("workflow_run", w));
    expect(t.queue.sent[0]).toMatchObject({ task_id: 42 });
  });

  it.each<[string, Fixture, (p: Payload) => void]>([
    ["push to main", "push", (p) => (p.ref = "refs/heads/main")],
    ["PR not linked to a task", "pull_request.opened", (p) => ((p.pull_request.head.ref = "x"), (p.pull_request.number = 99))],
    ["issue not linked to a task", "issues.closed", (p) => (p.issue.number = 99)],
    ["workflow_run on main without PRs", "workflow_run.completed", (p) => ((p.workflow_run.head_branch = "main"), (p.workflow_run.pull_requests = []))],
  ])("%s: ignored (no_task)", async (_label, f, edit) => {
    const t = setup();
    const p = fixture(f);
    edit(p);
    expect(await t.run(request(EVENT_OF[f], p))).toEqual({ status: 202, body: { result: "ignored", reason: "no_task" } });
    expect(t.store.claimed.size).toBe(0);
    expect(t.queue.sent).toEqual([]);
  });

  it("unsupported events and actions are ignored without touching the database", async () => {
    const t = setup();
    expect((await t.run(request("issue_comment", fixture("issues.closed")))).body).toEqual({ result: "ignored", reason: "event_type" });
    const p = fixture("pull_request.opened");
    p.action = "labeled";
    expect((await t.run(request("pull_request", p))).body).toEqual({ result: "ignored", reason: "action" });
    expect(t.store.calls).toEqual([]);
  });
});

describe("delivery dedupe (inbound_events)", () => {
  it("the same delivery id is forwarded once", async () => {
    const t = setup();
    const req = request("push", fixture("push"));
    expect(await t.run(req)).toEqual({ status: 200, body: { result: "forwarded" } });
    expect(await t.run(req)).toEqual({ status: 200, body: { result: "duplicate" } });
    expect(t.queue.sent).toHaveLength(1);
  });

  it("a different delivery id of the same event is forwarded again", async () => {
    const t = setup();
    await t.run(request("push", fixture("push")));
    await t.run(request("push", fixture("push"), { headers: { "x-github-delivery": "5f1a0c2e-0000-4000-8000-000000000002" } }));
    expect(t.queue.sent).toHaveLength(2);
  });

  it("a failed queue send releases the claim, so a redelivery goes through", async () => {
    const t = setup();
    t.queue.failWith = Object.assign(new Error("synthetic"), { name: "QueueDoesNotExist" });
    const req = request("push", fixture("push"));
    expect(await t.run(req)).toEqual({ status: 502, body: { result: "error", reason: "queue" } });
    expect(t.store.claimed.size).toBe(0);
    t.queue.failWith = undefined;
    expect((await t.run(req)).body.result).toBe("forwarded");
    expect(t.queue.sent).toHaveLength(1);
  });

  it("a database failure is a 500 and nothing is sent", async () => {
    const store = new FakeStore();
    store.failWith = Object.assign(new Error("postgres://user:pw@host/db is down"), { name: "DatabaseError" });
    const t = setup({ store });
    expect(await t.run(request("push", fixture("push")))).toEqual({ status: 500, body: { result: "error", reason: "db" } });
    expect(t.queue.sent).toEqual([]);
    expect(t.logs.join("\n")).not.toMatch(/postgres:|pw@/);
  });
});

describe("Actions minutes (workflow_run.completed)", () => {
  const DELIVERY_2 = "5f1a0c2e-0000-4000-8000-000000000002";

  it("records the run's duration once per run attempt, linked to the task", async () => {
    const t = setup();
    expect((await t.run(request("workflow_run", fixture("workflow_run.completed")))).body.result).toBe("forwarded");
    expect([...t.store.minutes.values()]).toEqual([
      {
        usage: {
          dedupeKey: "github:workflow_run:30000001:1",
          agent: "orchestrator",
          minutes: 7.5,
          ts: "2026-10-22T10:07:30.000Z",
        },
        taskId: 42,
      },
    ]);
    expect(t.logs[0]).toMatch(/ minutes=7\.5$/);
  });

  it("a redelivery (same or new delivery id) does not count the run again", async () => {
    const t = setup();
    const req = request("workflow_run", fixture("workflow_run.completed"));
    await t.run(req);
    expect(await t.run(req)).toEqual({ status: 200, body: { result: "duplicate" } });
    await t.run(request("workflow_run", fixture("workflow_run.completed"), { headers: { "x-github-delivery": DELIVERY_2 } }));
    expect(t.store.minutes.size).toBe(1);
    expect(t.logs[1]).toMatch(/minutes=duplicate$/);
  });

  it("a re-run (next attempt) is counted separately", async () => {
    const t = setup();
    await t.run(request("workflow_run", fixture("workflow_run.completed")));
    const p = fixture("workflow_run.completed");
    p.workflow_run.run_attempt = 2;
    await t.run(request("workflow_run", p, { headers: { "x-github-delivery": DELIVERY_2 } }));
    expect([...t.store.minutes.keys()]).toEqual(["github:workflow_run:30000001:1", "github:workflow_run:30000001:2"]);
  });

  it("runs without a task (deploys) are still counted, then ignored", async () => {
    const t = setup();
    const p = fixture("workflow_run.completed");
    p.workflow_run.head_branch = "main";
    p.workflow_run.pull_requests = [];
    p.workflow_run.path = ".github/workflows/deploy.yml";
    expect((await t.run(request("workflow_run", p))).body).toEqual({ result: "ignored", reason: "no_task" });
    expect([...t.store.minutes.values()]).toMatchObject([{ taskId: null, usage: { agent: "orchestrator" } }]);
    expect(t.store.claimed.size).toBe(0);
  });

  it("not for requested runs, stranger senders or runs without times", async () => {
    const t = setup();
    const requested = fixture("workflow_run.completed");
    requested.action = "requested";
    await t.run(request("workflow_run", requested));
    const stranger = fixture("workflow_run.completed");
    stranger.sender.id = IDS.stranger;
    await t.run(request("workflow_run", stranger));
    const noStart = fixture("workflow_run.completed");
    delete noStart.workflow_run.run_started_at;
    await t.run(request("workflow_run", noStart, { headers: { "x-github-delivery": DELIVERY_2 } }));
    expect(t.store.minutes.size).toBe(0);
    expect(t.store.calls).not.toContain("minutes");
  });

  it("a database failure while recording is a 500 and nothing is claimed or sent", async () => {
    const store = new FakeStore(new Map([[12, 42]]));
    store.recordActionsMinutes = async () => {
      throw Object.assign(new Error("synthetic"), { name: "DatabaseError" });
    };
    const t = setup({ store });
    expect(await t.run(request("workflow_run", fixture("workflow_run.completed")))).toEqual({
      status: 500,
      body: { result: "error", reason: "db" },
    });
    expect(t.store.claimed.size).toBe(0);
    expect(t.queue.sent).toEqual([]);
  });
});

describe("actionsMinutesOf", () => {
  function normalized(p: Payload) {
    const n = normalize("workflow_run", p);
    if (!n.ok || n.value.payload.type !== "workflow_run") throw new Error("fixture did not normalize");
    return n.value.payload;
  }

  it.each<[string, string]>([
    [".github/workflows/agent-developer.yml", "developer"],
    [".github/workflows/agent-qa.yml", "qa"],
    [".github/workflows/agent-scraper.yml", "scraper"],
    [".github/workflows/agent-docs.yml", "docs"],
    [".github/workflows/ci.yml", "orchestrator"],
    [".github/workflows/preview-gc.yml", "orchestrator"],
  ])("%s -> %s", (path, agent) => {
    const p = fixture("workflow_run.completed");
    p.workflow_run.path = path;
    expect(actionsMinutesOf(normalized(p))?.agent).toBe(agent);
  });

  it("rounds to 2 decimals and defaults the attempt to 1", () => {
    const p = fixture("workflow_run.completed");
    p.workflow_run.updated_at = "2026-10-22T10:00:20Z"; // 20 s
    delete p.workflow_run.run_attempt;
    expect(actionsMinutesOf(normalized(p))).toMatchObject({ minutes: 0.33, dedupeKey: "github:workflow_run:30000001:1" });
  });

  it.each<[string, (p: Payload) => void]>([
    ["end before start", (p) => (p.workflow_run.updated_at = "2026-10-22T09:00:00Z")],
    ["unparseable time", (p) => (p.workflow_run.run_started_at = "yesterday")],
    ["longer than a day", (p) => (p.workflow_run.updated_at = "2026-10-24T10:00:00Z")],
  ])("%s -> null", (_label, edit) => {
    const p = fixture("workflow_run.completed");
    edit(p);
    expect(actionsMinutesOf(normalized(p))).toBeNull();
  });
});

describe("logging", () => {
  it("logs one line per delivery with ids only, never payload text or header values", async () => {
    const t = setup();
    await t.run(request("pull_request", fixture("pull_request.opened")));
    await t.run(request("push", fixture("push"), { headers: { "x-github-delivery": "evil\nline" } }));
    expect(t.logs).toEqual([
      `relay: forwarded event=pull_request delivery=${DELIVERY} task-42 pull_request.opened`,
      "relay: rejected (delivery_header) event=push delivery=?",
    ]);
  });
});
