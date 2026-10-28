// The sweeper (P2-17) on fakes: windows and dedupe ids, task selection (PGlite as orch_rw),
// redelivery filtering, one run's parts, the Octokit request shapes (mocked fetch) and the handler.
import { generateKeyPairSync } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { fromPglite, migrate } from "@kcw/db";
import { createFakeSecrets } from "@kcw/secrets";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppOctokit } from "../src/github";
import { parseTaskMessage } from "../src/graph";
import {
  NIGHTLY_GC,
  OctokitSweeperGitHub,
  PREVIEW_GC_WORKFLOW,
  REDELIVERY_DEFAULTS,
  STALE_PLANNING_MINUTES,
  SWEEP_STATUSES,
  SweepFailedError,
  createSweeperHandler,
  describeError,
  isAgentWorkflowPath,
  redact,
  nightlyGcWindow,
  runSweep,
  scheduledTimeOf,
  selectRedeliveries,
  sqlSweeperStore,
  sweepDedupeId,
  windowStart,
  type ActiveRun,
  type QueuedMessage,
  type SendMessageInput,
  type SweepTask,
  type SweeperGitHub,
  type SweeperStore,
  type WebhookDelivery,
} from "../src/sweeper";
import { GitHubApiError, type CancelResult, type DispatchWorkflowInput } from "../src/github";

describe("describeError / redact", () => {
  it("chains causes with class, status and code, at most three deep", () => {
    const inner = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const mid = Object.assign(new Error("request failed", { cause: inner }), { name: "HttpError", status: 502 });
    const outer = new GitHubApiError("listDeliveries", 502, { cause: mid });
    expect(describeError(outer)).toBe(
      "GitHubApiError 502: listDeliveries failed: GitHub returned 502 <- HttpError 502: request failed <- Error [ECONNREFUSED]: connect ECONNREFUSED",
    );
    const deep = new Error("4", { cause: new Error("3", { cause: new Error("2", { cause: new Error("1") }) }) });
    expect(describeError(deep).split(" <- ")).toHaveLength(3);
    expect(describeError("x")).toBe("string");
  });

  it("redacts credentials and shortens long messages", () => {
    const secretish = [
      "token ghs_abcdefghijklmnop1234",
      "Authorization: bearer eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJ4In0.c2ln",
      "postgres://kcw_orch:hunter2hunter2@ep-x.neon.tech/db failed",
      "-----BEGIN RSA PRIVATE KEY-----MIIEsecretbody-----END RSA PRIVATE KEY-----",
    ].join(" ");
    const out = redact(secretish);
    for (const leak of ["ghs_abcdefghijklmnop1234", "eyJhbGci", "hunter2", "MIIEsecretbody"]) expect(out).not.toContain(leak);
    expect(out).toContain("://<redacted>@ep-x.neon.tech");
    expect(redact("a".repeat(500))).toHaveLength(163);
  });
});

const T = (iso: string) => new Date(iso);

// ---------------------------------------------------------------- windows

describe("windows and dedupe ids", () => {
  it("floors to the 15-minute window (UTC, :00/:15/:30/:45)", () => {
    expect(windowStart(T("2026-10-23T06:14:59.999Z")).toISOString()).toBe("2026-10-23T06:00:00.000Z");
    expect(windowStart(T("2026-10-23T06:15:00Z")).toISOString()).toBe("2026-10-23T06:15:00.000Z");
    expect(windowStart(T("2026-10-23T06:29:30Z")).toISOString()).toBe("2026-10-23T06:15:00.000Z");
  });

  it("dedupe id = task + window: a retried run repeats it, the next window and other tasks do not", () => {
    const first = sweepDedupeId(7, T("2026-10-23T06:15:00Z"));
    expect(first).toBe("sweep-7-2026-10-23T06:15Z");
    expect(sweepDedupeId(7, T("2026-10-23T06:15:42Z"))).toBe(first);
    expect(sweepDedupeId(7, T("2026-10-23T06:30:00Z"))).not.toBe(first);
    expect(sweepDedupeId(8, T("2026-10-23T06:15:00Z"))).not.toBe(first);
    // SQS: max 128 chars of alphanumerics and punctuation.
    expect(sweepDedupeId(Number.MAX_SAFE_INTEGER, T("2026-10-23T06:15:00Z"))).toMatch(/^[\x21-\x7e]{1,128}$/);
  });

  it("nightly GC window is [06:15, 07:15) UTC", () => {
    expect(NIGHTLY_GC).toEqual({ hourUtc: 6, minuteUtc: 15, durationMinutes: 60 });
    expect(nightlyGcWindow(T("2026-10-23T06:00:00Z"))).toBeNull();
    expect(nightlyGcWindow(T("2026-10-23T06:15:00Z"))).toEqual({ start: T("2026-10-23T06:15:00Z"), end: T("2026-10-23T07:15:00Z") });
    expect(nightlyGcWindow(T("2026-10-23T07:00:00Z"))?.start).toEqual(T("2026-10-23T06:15:00Z"));
    expect(nightlyGcWindow(T("2026-10-23T07:15:00Z"))).toBeNull();
    expect(nightlyGcWindow(T("2026-10-23T18:15:00Z"))).toBeNull();
  });

  it("takes the run time from the Scheduler input, else now", () => {
    const now = T("2026-10-23T06:16:03Z");
    expect(scheduledTimeOf({ scheduled_time: "2026-10-23T06:15:00Z" }, now)).toEqual(T("2026-10-23T06:15:00Z"));
    expect(scheduledTimeOf({}, now)).toEqual(now);
    expect(scheduledTimeOf(null, now)).toEqual(now);
    expect(scheduledTimeOf({ scheduled_time: "<aws.scheduler.scheduled-time>" }, now)).toEqual(now);
    expect(scheduledTimeOf({ scheduled_time: "2026-10-20T06:15:00Z" }, now)).toEqual(now); // too far off
    expect(scheduledTimeOf({ scheduled_time: 12 }, now)).toEqual(now);
  });
});

// ---------------------------------------------------------------- task selection (PGlite)

describe("task selection (orch_rw on PGlite)", () => {
  let db: PGlite;
  const ids: Record<string, number> = {};
  const statuses = ["queued", "planning", "in_progress", "waiting", "merged", "done", "failed", "cancelled"] as const;

  beforeAll(async () => {
    db = await PGlite.create();
    await migrate(fromPglite(db));
    for (const s of [...statuses, "waiting"]) {
      const { rows } = await db.query<{ id: number }>(
        "INSERT INTO tasks (source, owner_text, status) VALUES ('console', 'synthetic', $1) RETURNING id",
        [s],
      );
      const id = Number(rows[0]!.id);
      ids[ids[s] === undefined ? s : `${s}2`] = id;
    }
    // A start that failed 16 min ago (stale) and one at the 15-min edge (not yet).
    for (const [key, minutes] of [["stalePlanning", 16], ["edgePlanning", 14]] as const) {
      const { rows } = await db.query<{ id: number }>(
        `INSERT INTO tasks (source, owner_text, status, updated_at)
         VALUES ('console', 'synthetic', 'planning', now() - make_interval(mins => $1)) RETURNING id`,
        [minutes],
      );
      ids[key] = Number(rows[0]!.id);
    }
    await db.query("INSERT INTO inbound_events (delivery_id, source) VALUES ('guid-known', 'github')");
    await db.exec("SET SESSION AUTHORIZATION orch_rw");
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  const store = (): SweeperStore => sqlSweeperStore(fromPglite(db));

  it("selects waiting and queued tasks, and planning ones untouched for 15 min, oldest first", async () => {
    expect(SWEEP_STATUSES).toEqual(["waiting", "queued"]);
    expect(STALE_PLANNING_MINUTES).toBe(15);
    const tasks = await store().listSweepTasks(100);
    // Not: the fresh planning task, the one at 14 min, in_progress, merged, done, failed, cancelled.
    expect(tasks).toEqual([{ id: ids.queued }, { id: ids.waiting }, { id: ids.waiting2 }, { id: ids.stalePlanning }]);
  });

  it("honours the limit", async () => {
    expect(await store().listSweepTasks(1)).toEqual([{ id: ids.queued }]);
  });

  it("reads agents_paused", async () => {
    expect(await store().isAgentsPaused()).toBe(false);
    await db.exec("UPDATE system_flags SET value = 'true' WHERE key = 'agents_paused'");
    expect(await store().isAgentsPaused()).toBe(true);
    await db.exec("UPDATE system_flags SET value = 'false' WHERE key = 'agents_paused'");
  });

  it("finds delivery ids already in inbound_events", async () => {
    expect(await store().knownDeliveries(["guid-known", "guid-new"])).toEqual(new Set(["guid-known"]));
    expect(await store().knownDeliveries([])).toEqual(new Set());
  });
});

// ---------------------------------------------------------------- redelivery filter

const NOW = T("2026-10-23T12:00:00Z");
let nextId = 1000;
const delivery = (guid: string, status_code: number, minutesAgo: number, over: Partial<WebhookDelivery> = {}): WebhookDelivery => ({
  id: nextId++,
  guid,
  delivered_at: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
  redelivery: false,
  status_code,
  event: "pull_request",
  ...over,
});
const opts = { now: NOW, lookbackMinutes: 180, maxAttempts: 4, maxPerRun: 20 };

describe("selectRedeliveries", () => {
  it("redelivers 5xx and unanswered (status 0) deliveries, newest attempt of each guid, oldest guid first", () => {
    const a1 = delivery("a", 502, 50);
    const a2 = delivery("a", 500, 20, { redelivery: true });
    const b = delivery("b", 0, 40);
    const plan = selectRedeliveries([a2, b, a1], new Set(), opts);
    expect(plan.redeliver).toEqual([
      { id: b.id, guid: "b" },
      { id: a2.id, guid: "a" },
    ]);
  });

  it("skips a guid that succeeded once (2xx/3xx, incl. the relay's 202 ignored)", () => {
    const plan = selectRedeliveries([delivery("a", 502, 30), delivery("a", 200, 10), delivery("c", 202, 5)], new Set(), opts);
    expect(plan.redeliver).toEqual([]);
    expect(plan.skipped.succeeded).toBe(2);
  });

  it("skips 4xx (refused by the relay: signature, headers, JSON) when it is the newest attempt", () => {
    const plan = selectRedeliveries([delivery("a", 401, 30), delivery("b", 502, 40), delivery("b", 400, 10)], new Set(), opts);
    expect(plan.redeliver).toEqual([]);
    expect(plan.skipped.rejected).toBe(2);
  });

  it("skips guids recorded in inbound_events", () => {
    const plan = selectRedeliveries([delivery("known", 502, 30)], new Set(["known"]), opts);
    expect(plan.redeliver).toEqual([]);
    expect(plan.skipped.recorded).toBe(1);
  });

  it("gives up after maxAttempts attempts within the lookback", () => {
    const attempts = [1, 2, 3, 4].map((i) => delivery("a", 502, 100 - i * 10));
    expect(selectRedeliveries(attempts, new Set(), opts).skipped.attempts).toBe(1);
    expect(selectRedeliveries(attempts.slice(1), new Set(), opts).redeliver).toHaveLength(1);
  });

  it("ignores attempts outside the lookback", () => {
    const old = delivery("old", 502, 181);
    const plan = selectRedeliveries([old, delivery("x", 502, 200), delivery("x", 502, 190), delivery("x", 502, 185), delivery("x", 502, 10)], new Set(), opts);
    expect(plan.redeliver.map((d) => d.guid)).toEqual(["x"]); // only one attempt of x counts
  });

  it("caps redeliveries per run", () => {
    const many = Array.from({ length: 25 }, (_, i) => delivery(`g${i}`, 502, 100 - i));
    const plan = selectRedeliveries(many, new Set(), opts);
    expect(plan.redeliver).toHaveLength(20);
    expect(plan.redeliver[0]!.guid).toBe("g0");
    expect(plan.skipped.limit).toBe(5);
  });

  it("has bounded defaults", () => {
    expect(REDELIVERY_DEFAULTS).toEqual({ lookbackMinutes: 180, maxAttempts: 4, maxPages: 5, maxPerRun: 20 });
  });
});

// ---------------------------------------------------------------- one run on fakes

class FakeStore implements SweeperStore {
  tasks: SweepTask[] = [];
  paused = false;
  known = new Set<string>();
  failTasks = false;
  async listSweepTasks(limit: number) {
    if (this.failTasks) throw new TypeError("db down");
    return this.tasks.slice(0, limit);
  }
  async isAgentsPaused() {
    return this.paused;
  }
  async knownDeliveries(ids: readonly string[]) {
    return new Set(ids.filter((i) => this.known.has(i)));
  }
}

class FakeQueue {
  sent: QueuedMessage[] = [];
  async send(m: QueuedMessage) {
    this.sent.push(m);
  }
}

class FakeSweeperGitHub implements SweeperGitHub {
  runs: ActiveRun[] = [];
  cancelled: number[] = [];
  dispatched: DispatchWorkflowInput[] = [];
  dispatchedSince: { workflow: string; since: Date }[] = [];
  existingDispatches = 0;
  deliveries: WebhookDelivery[] = [];
  listedSince: Date[] = [];
  redelivered: number[] = [];
  async listActiveAgentRuns() {
    return this.runs;
  }
  async cancelRun(id: number): Promise<CancelResult> {
    this.cancelled.push(id);
    return id === 99 ? "not_running" : "cancelled";
  }
  async dispatchWorkflow(input: DispatchWorkflowInput) {
    this.dispatched.push(input);
    return { runId: null };
  }
  async countDispatchedRuns(workflow: string, since: Date) {
    this.dispatchedSince.push({ workflow, since });
    return this.existingDispatches;
  }
  async listDeliveries(since: Date) {
    this.listedSince.push(since);
    return this.deliveries;
  }
  async redeliver(id: number) {
    this.redelivered.push(id);
  }
}

function setup(scheduled = "2026-10-23T12:00:00Z") {
  const store = new FakeStore();
  const queue = new FakeQueue();
  const gh = new FakeSweeperGitHub();
  const logs: string[] = [];
  const deps = {
    store,
    queue,
    github: async () => gh,
    scheduledTime: T(scheduled),
    now: T(scheduled),
    log: (l: string) => logs.push(l),
  };
  return { store, queue, gh, logs, deps };
}

describe("runSweep", () => {
  it("sends one sweep message per selected task, which the graph's parser accepts", async () => {
    const { store, queue, deps } = setup("2026-10-23T12:00:07Z");
    store.tasks = [{ id: 3 }, { id: 11 }];
    const r = await runSweep(deps);
    expect(r.swept).toBe(2);
    expect(queue.sent).toEqual([
      { body: JSON.stringify({ type: "sweep", task_id: 3, thread_id: "task-3" }), groupId: "task-3", dedupeId: "sweep-3-2026-10-23T12:00Z" },
      { body: JSON.stringify({ type: "sweep", task_id: 11, thread_id: "task-11" }), groupId: "task-11", dedupeId: "sweep-11-2026-10-23T12:00Z" },
    ]);
    for (const m of queue.sent) {
      expect(parseTaskMessage(m.body, m.groupId, "m-1").input.kind).toBe("sweep");
    }
  });

  it("a retried run (same scheduled time) sends the same dedupe ids", async () => {
    const a = setup("2026-10-23T12:15:00Z");
    const b = setup("2026-10-23T12:15:00Z");
    a.store.tasks = b.store.tasks = [{ id: 5 }];
    await runSweep(a.deps);
    await runSweep({ ...b.deps, now: T("2026-10-23T12:21:00Z") });
    expect(b.queue.sent.map((m) => m.dedupeId)).toEqual(a.queue.sent.map((m) => m.dedupeId));
  });

  it("not paused: cancels nothing", async () => {
    const { gh, deps } = setup();
    gh.runs = [{ id: 1, path: ".github/workflows/agent-developer.yml", status: "in_progress" }];
    const r = await runSweep(deps);
    expect(r.paused).toBe(false);
    expect(gh.cancelled).toEqual([]);
  });

  it("paused: cancels every active agent run; still sweeps (the graph answers paused)", async () => {
    const { store, gh, queue, deps } = setup();
    store.paused = true;
    store.tasks = [{ id: 1 }];
    gh.runs = [
      { id: 1, path: ".github/workflows/agent-developer.yml", status: "in_progress" },
      { id: 99, path: ".github/workflows/agent-qa.yml", status: "queued" },
    ];
    const r = await runSweep(deps);
    expect(gh.cancelled).toEqual([1, 99]);
    expect(r.cancelled).toBe(1); // 99 had finished meanwhile
    expect(queue.sent).toHaveLength(1);
  });

  it("dispatches preview-gc.yml (no dry run) in the nightly window unless already dispatched", async () => {
    const a = setup("2026-10-23T06:15:00Z");
    expect((await runSweep(a.deps)).gc).toBe("dispatched");
    expect(a.gh.dispatched).toEqual([{ workflow: PREVIEW_GC_WORKFLOW, ref: "main", inputs: { dry_run: "false", max_age_hours: "24" } }]);
    expect(a.gh.dispatchedSince).toEqual([{ workflow: "preview-gc.yml", since: T("2026-10-23T06:15:00Z") }]);

    const b = setup("2026-10-23T06:45:00Z");
    b.gh.existingDispatches = 1;
    expect((await runSweep(b.deps)).gc).toBe("already_dispatched");
    expect(b.gh.dispatched).toEqual([]);

    const c = setup("2026-10-23T07:15:00Z");
    expect((await runSweep(c.deps)).gc).toBe("outside_window");
    expect(c.gh.dispatchedSince).toEqual([]);
  });

  it("redelivers the selected failed deliveries, skipping recorded ones", async () => {
    const { store, gh, deps } = setup();
    const failed = delivery("fail", 502, 10);
    const known = delivery("known", 502, 10);
    gh.deliveries = [failed, known, delivery("ok", 200, 5)];
    store.known.add("known");
    const r = await runSweep(deps);
    expect(gh.redelivered).toEqual([failed.id]);
    expect(r.redelivered).toBe(1);
    expect(r.redeliverySkipped).toMatchObject({ recorded: 1, succeeded: 1 });
    expect(gh.listedSince).toEqual([T("2026-10-23T09:00:00Z")]); // 180 min lookback
  });

  it("one failing part does not stop the others; the report names the class, the log the error chain", async () => {
    const { store, gh, deps, logs } = setup("2026-10-23T06:15:00Z");
    store.failTasks = true;
    gh.deliveries = [delivery("x", 500, 1)];
    const r = await runSweep(deps);
    expect(r.failed).toEqual({ tasks: "TypeError" });
    expect(r.gc).toBe("dispatched");
    expect(r.redelivered).toBe(1);
    expect(logs).toContain("sweeper: tasks failed (TypeError) TypeError: db down");
  });

  it("logs the cause of a status-less GitHubApiError (the P2-17 live failure)", async () => {
    const { gh, deps, logs } = setup();
    const keyError = Object.assign(new Error("error:1E08010C:DECODER routines::unsupported"), { code: "ERR_OSSL_UNSUPPORTED" });
    gh.listDeliveries = () => Promise.reject(new GitHubApiError("listDeliveries", undefined, { cause: keyError }));
    const r = await runSweep(deps);
    expect(r.failed).toEqual({ redeliver: "GitHubApiError" });
    expect(logs).toContain(
      "sweeper: redeliver failed (GitHubApiError) GitHubApiError: listDeliveries failed <- Error [ERR_OSSL_UNSUPPORTED]: error:1E08010C:DECODER routines::unsupported",
    );
  });

  it("missing App credentials fail the GitHub parts only, and the client is created once", async () => {
    const { store, queue, deps } = setup("2026-10-23T06:15:00Z");
    store.tasks = [{ id: 2 }];
    store.paused = true;
    let calls = 0;
    const r = await runSweep({
      ...deps,
      github: () => {
        calls += 1;
        return Promise.reject(new RangeError("no key"));
      },
    });
    expect(queue.sent).toHaveLength(1);
    expect(r.failed).toEqual({ pause: "RangeError", gc: "RangeError", redeliver: "RangeError" });
    expect(calls).toBe(1);
  });
});

describe("isAgentWorkflowPath", () => {
  it.each([
    [".github/workflows/agent-developer.yml", true],
    [".github/workflows/agent-qa.yaml", true],
    [".github/workflows/agent-docs.yml@refs/heads/main", true],
    [".github/workflows/ci.yml", false],
    [".github/workflows/preview-gc.yml", false],
    [".github/workflows/sub/agent-x.yml", false],
    ["agent-developer.yml", false],
    [null, false],
  ])("%s -> %s", (path, expected) => {
    expect(isAgentWorkflowPath(path)).toBe(expected);
  });
});

// ---------------------------------------------------------------- Octokit request shapes

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

interface Call {
  method: string;
  url: URL;
  auth: string;
  body: unknown;
}

const json = (status: number, data: unknown, headers: Record<string, string> = {}) =>
  new Response(status === 204 || status === 202 ? null : JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

function mockGitHub(respond: (c: Call) => Response | undefined) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const call: Call = {
      method: (init.method ?? "GET").toUpperCase(),
      url: new URL(String(input)),
      auth: headers.authorization ?? "",
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    if (call.method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(call.url.pathname)) {
      return json(201, { token: "ghs_synthetic", expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: {}, repository_selection: "selected" });
    }
    return respond(call) ?? json(404, { message: "Not Found (mock)" });
  };
  const octokit = createAppOctokit({ appId: "Iv23synthetic", privateKey, installationId: 42 }, { repo: "o/r", fetch: fetch as typeof globalThis.fetch });
  return { calls, client: new OctokitSweeperGitHub(octokit, "o/r") };
}

const ghDelivery = (id: number, guid: string, at: string, status_code = 502) => ({
  id,
  guid,
  delivered_at: at,
  redelivery: false,
  duration: 0.1,
  status: status_code === 200 ? "OK" : "Bad Gateway",
  status_code,
  event: "pull_request",
  action: "opened",
  installation_id: 42,
  repository_id: 1,
});

describe("OctokitSweeperGitHub", () => {
  it("lists deliveries with the App JWT, follows the cursor link and stops at the lookback", async () => {
    const { calls, client } = mockGitHub((c) => {
      if (c.method !== "GET" || c.url.pathname !== "/app/hook/deliveries") return undefined;
      if (!c.url.searchParams.get("cursor")) {
        return json(200, [ghDelivery(3, "g3", "2026-10-23T11:50:00Z"), ghDelivery(2, "g2", "2026-10-23T11:00:00Z")], {
          link: '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=abc>; rel="next"',
        });
      }
      return json(200, [ghDelivery(1, "g1", "2026-10-23T09:30:00Z"), ghDelivery(0, "g0", "2026-10-23T08:00:00Z")], {
        link: '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=def>; rel="next"',
      });
    });
    const out = await client.listDeliveries(T("2026-10-23T09:00:00Z"), 5);
    expect(out.map((d) => d.guid)).toEqual(["g3", "g2", "g1"]);
    const list = calls.filter((c) => c.url.pathname === "/app/hook/deliveries");
    expect(list).toHaveLength(2); // stopped after the page reaching past the lookback
    expect(list[0]!.url.searchParams.get("per_page")).toBe("100");
    expect(list[1]!.url.searchParams.get("cursor")).toBe("abc");
    for (const c of list) expect(c.auth.toLowerCase()).toMatch(/^bearer /); // JWT, not the installation token
    expect(calls.some((c) => c.url.pathname.endsWith("/access_tokens"))).toBe(false);
  });

  it("stops after maxPages", async () => {
    const { calls, client } = mockGitHub((c) =>
      c.url.pathname === "/app/hook/deliveries"
        ? json(200, [ghDelivery(9, "g", "2026-10-23T11:59:00Z")], { link: '<https://api.github.com/app/hook/deliveries?cursor=n>; rel="next"' })
        : undefined,
    );
    await client.listDeliveries(T("2026-10-23T09:00:00Z"), 2);
    expect(calls.filter((c) => c.url.pathname === "/app/hook/deliveries")).toHaveLength(2);
  });

  it("redelivers with POST .../attempts (JWT)", async () => {
    const { calls, client } = mockGitHub((c) => (c.method === "POST" && c.url.pathname === "/app/hook/deliveries/77/attempts" ? json(202, {}) : undefined));
    await client.redeliver(77);
    const c = calls.find((x) => x.url.pathname === "/app/hook/deliveries/77/attempts");
    expect(c?.auth.toLowerCase()).toMatch(/^bearer /);
  });

  it("lists active runs per status with the installation token and keeps agent workflows only", async () => {
    const { calls, client } = mockGitHub((c) => {
      if (c.url.pathname !== "/repos/o/r/actions/runs") return undefined;
      const status = c.url.searchParams.get("status");
      const runs =
        status === "in_progress"
          ? [
              { id: 1, path: ".github/workflows/agent-developer.yml", status: "in_progress" },
              { id: 2, path: ".github/workflows/ci.yml", status: "in_progress" },
            ]
          : status === "queued"
            ? [{ id: 3, path: ".github/workflows/agent-qa.yml", status: "queued" }]
            : [];
      return json(200, { total_count: runs.length, workflow_runs: runs });
    });
    expect(await client.listActiveAgentRuns()).toEqual([
      { id: 1, path: ".github/workflows/agent-developer.yml", status: "in_progress" },
      { id: 3, path: ".github/workflows/agent-qa.yml", status: "queued" },
    ]);
    const listed = calls.filter((c) => c.url.pathname === "/repos/o/r/actions/runs");
    expect(listed.map((c) => c.url.searchParams.get("status"))).toEqual(["in_progress", "queued", "waiting", "pending", "requested"]);
    for (const c of listed) expect(c.auth).toBe("token ghs_synthetic");
  });

  it("counts workflow_dispatch runs of a workflow created since a time", async () => {
    const { calls, client } = mockGitHub((c) =>
      c.url.pathname === "/repos/o/r/actions/workflows/preview-gc.yml/runs" ? json(200, { total_count: 2, workflow_runs: [] }) : undefined,
    );
    expect(await client.countDispatchedRuns("preview-gc.yml", T("2026-10-23T06:15:00Z"))).toBe(2);
    const c = calls.find((x) => x.url.pathname.endsWith("/runs"))!;
    expect(c.url.searchParams.get("event")).toBe("workflow_dispatch");
    expect(c.url.searchParams.get("created")).toBe(">=2026-10-23T06:15:00Z");
  });

  it("errors carry the operation and status only", async () => {
    const { client } = mockGitHub((c) => (c.url.pathname === "/app/hook/deliveries" ? json(500, { message: "secret detail" }) : undefined));
    await expect(client.listDeliveries(T("2026-10-23T09:00:00Z"), 1)).rejects.toMatchObject({
      name: "GitHubApiError",
      message: "listDeliveries failed: GitHub returned 500",
    });
  });
});

// ---------------------------------------------------------------- handler

describe("createSweeperHandler", () => {
  const env = { KCW_ORCHESTRATOR_SECRET: "kcw/prod/orchestrator", KCW_ORCHESTRATOR_QUEUE_URL: "https://sqs.invalid/1/q.fifo" };

  function fakeDb(rows: { id: number }[]) {
    let ended = false;
    return {
      db: {
        async query<R>(sql: string) {
          if (sql.startsWith("SELECT id FROM tasks")) return { rows: rows as R[] };
          if (sql.includes("system_flags")) return { rows: [{ value: false }] as R[] };
          return { rows: [] as R[] };
        },
        async end() {
          ended = true;
        },
      },
      ended: () => ended,
    };
  }

  it("reads db_url from the orchestrator secret, sends with the queue URL, closes the connection", async () => {
    const { store: secrets } = createFakeSecrets({ "kcw/prod/orchestrator": { db_url: "postgres://synthetic" } });
    const { db, ended } = fakeDb([{ id: 4 }]);
    const sent: SendMessageInput[] = [];
    const urls: string[] = [];
    const handler = createSweeperHandler({
      env,
      secrets,
      sendMessage: async (i) => sent.push(i),
      connect: async (url) => {
        urls.push(url);
        return db;
      },
      github: async () => new FakeSweeperGitHub(),
      now: () => T("2026-10-23T12:00:05Z"),
      log: () => undefined,
    });
    const r = await handler({ scheduled_time: "2026-10-23T12:00:00Z" });
    expect(r.swept).toBe(1);
    expect(urls).toEqual(["postgres://synthetic"]);
    expect(sent).toEqual([
      {
        QueueUrl: env.KCW_ORCHESTRATOR_QUEUE_URL,
        MessageBody: JSON.stringify({ type: "sweep", task_id: 4, thread_id: "task-4" }),
        MessageGroupId: "task-4",
        MessageDeduplicationId: "sweep-4-2026-10-23T12:00Z",
      },
    ]);
    expect(ended()).toBe(true);
  });

  it("fails the invocation (SweepFailedError) when a part failed, after running the others", async () => {
    const { store: secrets } = createFakeSecrets({ "kcw/prod/orchestrator": { db_url: "postgres://synthetic" } });
    const { db, ended } = fakeDb([{ id: 4 }]);
    const sent: SendMessageInput[] = [];
    const handler = createSweeperHandler({
      env,
      secrets,
      sendMessage: async (i) => sent.push(i),
      connect: async () => db,
      github: () => Promise.reject(new RangeError("x")),
      now: () => T("2026-10-23T12:00:05Z"),
      log: () => undefined,
    });
    await expect(handler({})).rejects.toBeInstanceOf(SweepFailedError);
    expect(sent).toHaveLength(1);
    expect(ended()).toBe(true);
  });

  it("an empty or missing db_url fails without logging a value", async () => {
    const logs: string[] = [];
    const { store: secrets } = createFakeSecrets({ "kcw/prod/orchestrator": { db_url: " " } });
    const handler = createSweeperHandler({ env, secrets, sendMessage: async () => undefined, log: (l) => logs.push(l) });
    await expect(handler({})).rejects.toBeInstanceOf(SweepFailedError);
    expect(logs).toEqual(["sweeper: database unavailable (SweeperConfigError) SweeperConfigError: db_url is empty"]);
  });

  it("requires its env vars", async () => {
    const { store: secrets } = createFakeSecrets({});
    const handler = createSweeperHandler({ env: {}, secrets, sendMessage: async () => undefined });
    await expect(handler({})).rejects.toMatchObject({ name: "SweeperConfigError", message: "KCW_ORCHESTRATOR_SECRET is not set" });
  });
});
