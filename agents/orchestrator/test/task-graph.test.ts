// P2-10 definition of done: the PR loop of DESIGN §4.2-§4.3 on fakes. GitHub is FakeGitHubClient,
// the planner is a fake, the clock is fixed; Postgres is PGlite (migrations 0001-0003) served over
// the wire protocol and used as orch_rw, so every write goes through the orchestrator's DB role.
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { MergeInput } from "@kcw/core/merge-input";
import { fromPglite, migrate } from "@kcw/db";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkpointerFromPool, setupCheckpointer, threadConfig } from "../src/index";
import { ArtifactFormatError, FakeGitHubClient, type ArtifactResult, type ChangedFile, type GetArtifactInput } from "../src/github";
import {
  INCOMPLETE_INPUT_TIMEOUT_MINUTES,
  IN_FLIGHT_LIMIT,
  MAX_ATTEMPTS,
  PgTaskStore,
  WAIT_LIMIT_MINUTES,
  buildTaskGraph,
  handleTaskSqsEvent,
  type Plan,
  type TaskGraph,
  type TaskGraphDeps,
} from "../src/graph";
import { servePglite, type PgSocketServer } from "./pg-socket";

const sha = (s: string) => createHash("sha1").update(s).digest("hex");
const DEV_BOT = "kcw-developer[bot]";
const SENDER = { id: 1, login: "kcw-orchestrator[bot]", type: "Bot" };
const CLEAN: MergeInput = {
  planSummary: { format: 1, infra: [], artifact: { count: 1, kinds: { create: 0, update: 1, delete: 0, replace: 0 } } },
  lockDiff: { added: [], existing: [] },
};
const ROUTE: ChangedFile = { path: "apps/web/src/app/healthz/route.ts", status: "added" };
const PLAN: Plan = { title: "Add a healthz page", body: "Add a /healthz route that returns ok.\n\nInclude a test." };

describe("task graph (P2-10)", () => {
  let db: PGlite;
  let srv: PgSocketServer;
  let pool: pg.Pool;
  let graph: TaskGraph;
  let gh: FakeGitHubClient;
  let clock: Date;
  const plans = new Map<number, Plan>();
  const deps: TaskGraphDeps = {
    github: new FakeGitHubClient(),
    store: undefined as unknown as PgTaskStore,
    planner: { plan: async (r) => plans.get(r.task_id) ?? PLAN },
    now: () => clock,
  };
  let seq = 0;

  /** Superuser SQL (test setup and assertions); the orchestrator's own connection stays orch_rw. */
  const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => {
    await db.query("RESET ROLE");
    try {
      return (await db.query<T>(text, params)).rows;
    } finally {
      await db.query("SET ROLE orch_rw");
    }
  };

  beforeAll(async () => {
    db = await PGlite.create();
    await migrate(fromPglite(db));
    await db.query("INSERT INTO contacts (name, aliases) VALUES ('Jane Doe', '{Janie}')"); // synthetic
    srv = await servePglite(db, { role: "orch_rw" });
    pool = new pg.Pool({ connectionString: srv.url, max: 1 });
    await setupCheckpointer(pool);
    deps.store = new PgTaskStore(pool);
    graph = buildTaskGraph(checkpointerFromPool(pool), deps);
  }, 60_000);

  afterAll(async () => {
    await pool.end().catch(() => undefined);
    await srv.close();
    await db.close();
  });

  beforeEach(async () => {
    gh = new FakeGitHubClient();
    deps.github = gh;
    clock = new Date("2026-10-23T10:00:00Z");
    // Earlier tests leave tasks in flight; finish them so each test starts with free slots.
    await sql("UPDATE tasks SET status = 'done' WHERE status IN ('planning', 'in_progress', 'waiting')");
    await sql("UPDATE system_flags SET value = 'false' WHERE key = 'agents_paused'");
  });

  const advance = (minutes: number) => {
    clock = new Date(clock.getTime() + minutes * 60_000);
  };

  // ------------------------------------------------------------------ messages

  /** Sends one message through the SQS handler; returns its outcome (or "failed" if returned to the queue). */
  async function send(taskId: number, body: unknown, messageId = `m${++seq}`): Promise<string> {
    const lines: string[] = [];
    const res = await handleTaskSqsEvent(
      { Records: [{ messageId, body: JSON.stringify(body), attributes: { MessageGroupId: `task-${taskId}` } }] },
      { graph, log: (l) => lines.push(l) },
    );
    if (res.batchItemFailures.length > 0) return "failed";
    const last = lines.at(-1)!;
    return last.slice(last.indexOf(": ") + 2);
  }

  const github = (taskId: number, payload: Record<string, unknown>, headSha: string | null) => ({
    source: "github",
    delivery_id: `d-${++seq}`,
    task_id: taskId,
    thread_id: `task-${taskId}`,
    resume: { event: `${payload.type}.${payload.action}`, head_sha: headSha, payload: { ...payload, sender: SENDER } },
  });
  const prEvent = (taskId: number, action: string, pr: number, head: string, ref = `kcw/task-${taskId}`) =>
    github(taskId, { type: "pull_request", action, pr_number: pr, merged: false, draft: false, head_ref: ref, head_sha: head, base_ref: "main" }, head);
  const ciEvent = (taskId: number, pr: number, head: string, conclusion: string, path = ".github/workflows/ci.yml") =>
    github(
      taskId,
      {
        type: "workflow_run",
        action: "completed",
        run_id: ++seq,
        run_attempt: 1,
        workflow_path: path,
        workflow_name: "ci",
        status: "completed",
        conclusion,
        trigger: "pull_request",
        head_branch: `kcw/task-${taskId}`,
        head_sha: head,
        pr_numbers: [pr],
        run_started_at: null,
        updated_at: null,
      },
      head,
    );
  const reviewEvent = (taskId: number, pr: number, head: string, state: string) =>
    github(taskId, { type: "pull_request_review", action: "submitted", pr_number: pr, review_state: state, commit_id: head }, head);
  const sweep = (taskId: number) => ({ type: "sweep", task_id: taskId, thread_id: `task-${taskId}` });
  const decision = (taskId: number, approvalId: string, d: "approved" | "rejected") => ({
    type: "owner.decision",
    task_id: taskId,
    thread_id: `task-${taskId}`,
    resume: { approval_id: approvalId, decision: d },
  });

  // ------------------------------------------------------------------ fixtures and assertions

  async function newTask(ownerText = "Add a healthz page please"): Promise<number> {
    const [row] = await sql<{ id: string }>(
      "INSERT INTO tasks (source, owner_text, is_private) VALUES ('console', $1, true) RETURNING id",
      [ownerText],
    );
    const id = Number(row!.id);
    await sql("UPDATE tasks SET thread_id = 'task-' || id WHERE id = $1", [id]);
    return id;
  }

  const start = (taskId: number) => send(taskId, { type: "task.created", task_id: taskId });

  /** The Developer opens its PR (the fake GitHub learns it, with a clean merge-rules artifact). */
  function openPr(taskId: number, pr: number, head: string, files: ChangedFile[] = [ROUTE], patches: Record<string, string> = {}) {
    gh.prs.set(pr, { headSha: head, author: DEV_BOT, files, patches });
    gh.artifacts.set(head, CLEAN);
    return send(taskId, prEvent(taskId, "opened", pr, head));
  }

  /** New commits on the PR. */
  function push(taskId: number, pr: number, head: string, artifact: MergeInput | null = CLEAN) {
    gh.prs.get(pr)!.headSha = head;
    if (artifact) gh.artifacts.set(head, artifact);
    return send(taskId, prEvent(taskId, "synchronize", pr, head));
  }

  async function events(taskId: number): Promise<string[]> {
    const rows = await sql<{ event_type: string }>("SELECT event_type FROM agent_events WHERE task_id = $1 ORDER BY id", [taskId]);
    return rows.map((r) => r.event_type);
  }

  async function task(taskId: number) {
    const [row] = await sql<{
      status: string;
      waiting_on: string | null;
      attempts: number;
      pr_number: number | null;
      head_sha: string | null;
      github_issue: number | null;
      public_title: string | null;
      branch: string | null;
    }>("SELECT status, waiting_on, attempts, pr_number, head_sha, github_issue, public_title, branch FROM tasks WHERE id = $1", [taskId]);
    return row!;
  }

  async function pendingApproval(taskId: number) {
    const rows = await sql<{ id: string; kind: string; reasons: string[] }>(
      "SELECT id, kind, reasons FROM approvals WHERE task_id = $1 AND status = 'pending'",
      [taskId],
    );
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  /** What the console does: record the decision, then enqueue owner.decision. */
  async function decide(taskId: number, approvalId: string, d: "approved" | "rejected") {
    await sql("UPDATE approvals SET status = $2, decided_at = now() WHERE id = $1", [approvalId, d]);
    return send(taskId, decision(taskId, approvalId, d));
  }

  const devDispatches = () => gh.dispatches.filter((x) => x.workflow === "agent-developer.yml");
  const qaDispatches = () => gh.dispatches.filter((x) => x.workflow === "agent-qa.yml");
  const waits = async (taskId: number) => {
    const s = await graph.getState(threadConfig(taskId));
    return s.tasks.flatMap((t) => t.interrupts.map((i) => i.value));
  };

  /** Start -> PR -> CI green -> QA dispatched. */
  async function toQa(taskId: number, pr: number, head: string) {
    expect(await start(taskId)).toBe("started");
    expect(await openPr(taskId, pr, head)).toBe("applied");
    expect(await send(taskId, ciEvent(taskId, pr, head, "success"))).toBe("applied");
    expect((await task(taskId)).waiting_on).toBe("qa");
  }

  // ------------------------------------------------------------------ DoD cases

  it("happy path: issue, Developer, PR, CI, QA, merge-rules, merge", async () => {
    const id = await newTask();
    const head = sha(`${id}-1`);

    expect(await start(id)).toBe("started");
    expect(gh.issues).toHaveLength(1);
    expect(gh.issues[0]!.title).toBe("Add a healthz page");
    expect(gh.issues[0]!.body).toContain("Add a /healthz route that returns ok.");
    expect(gh.issues[0]!.body).toContain(`kcw/task-${id}`);
    expect(gh.issues[0]!.body).not.toContain("please"); // owner text never reaches GitHub
    expect(devDispatches()).toEqual([
      { workflow: "agent-developer.yml", ref: "main", inputs: { task_id: String(id), issue: String(gh.issues[0]!.number), mode: "implement", pr: "" } },
    ]);
    expect(await task(id)).toMatchObject({ status: "waiting", waiting_on: "dev", github_issue: gh.issues[0]!.number, public_title: "Add a healthz page", branch: `kcw/task-${id}` });
    expect(await waits(id)).toEqual([{ phase: "dev", waiting_on: "dev" }]);

    expect(await openPr(id, 41, head)).toBe("applied");
    expect(await task(id)).toMatchObject({ waiting_on: "ci", pr_number: 41, head_sha: head });

    expect(await send(id, ciEvent(id, 41, head, "success"))).toBe("applied");
    expect(qaDispatches()).toEqual([{ workflow: "agent-qa.yml", ref: "main", inputs: { task_id: String(id), pr: "41" } }]);
    expect((await task(id)).waiting_on).toBe("qa");

    expect(await send(id, reviewEvent(id, 41, head, "approved"))).toBe("applied");
    expect(gh.latestCheck(head)).toMatchObject({ state: "success" });
    expect(gh.merges).toEqual([{ pr: 41, sha: `squash-41-${head}` }]);
    expect(gh.calls.find((c) => c.method === "merge")!.args).toEqual({ pr: 41, headSha: head, title: "Add a healthz page (#41)" });
    expect(await task(id)).toMatchObject({ status: "merged", waiting_on: null });
    expect(await events(id)).toEqual(["task_assigned", "pr_opened", "ci_running", "ci_passed", "qa_reviewing", "approved", "merged"]);
    expect((await graph.getState(threadConfig(id))).next).toEqual([]);

    // The thread has ended: later inputs change nothing.
    expect(await send(id, sweep(id))).toBe("finished");
  });

  it("CI fails, the Developer fixes it, CI passes", async () => {
    const id = await newTask();
    const [h1, h2] = [sha(`${id}-1`), sha(`${id}-2`)];
    await start(id);
    await openPr(id, 42, h1);

    expect(await send(id, ciEvent(id, 42, h1, "failure"))).toBe("applied");
    expect(await task(id)).toMatchObject({ waiting_on: "dev", attempts: 1 });
    expect(devDispatches().at(-1)!.inputs).toMatchObject({ mode: "fix", pr: "42" });

    expect(await push(id, 42, h2)).toBe("applied");
    expect(await task(id)).toMatchObject({ waiting_on: "ci", head_sha: h2 });
    expect(await send(id, ciEvent(id, 42, h2, "success"))).toBe("applied");
    expect((await task(id)).waiting_on).toBe("qa");
    expect(await events(id)).toEqual([
      "task_assigned",
      "pr_opened",
      "ci_running",
      "tests_failed",
      "task_assigned",
      "ci_running",
      "ci_passed",
      "qa_reviewing",
    ]);
  });

  it(`${MAX_ATTEMPTS} failures send the task to the owner; approving gives the Developer new attempts, rejecting fails it`, async () => {
    const id = await newTask();
    await start(id);
    await openPr(id, 43, sha(`${id}-0`));
    for (let n = 1; n <= MAX_ATTEMPTS; n++) {
      const head = sha(`${id}-${n - 1}`);
      if (n > 1) await push(id, 43, head);
      expect(await send(id, ciEvent(id, 43, head, "failure"))).toBe("applied");
    }
    expect(devDispatches()).toHaveLength(MAX_ATTEMPTS); // implement + 2 fixes, no third fix
    expect(await task(id)).toMatchObject({ status: "waiting", waiting_on: "owner", attempts: MAX_ATTEMPTS });
    const a = await pendingApproval(id);
    expect(a.kind).toBe("critical_pr");
    expect(a.reasons[0]).toMatch(/^Task failed: CI failed; 3 failed attempts\./);
    const inbox = await sql("SELECT kind, ref_table, title, status FROM inbox_items WHERE ref_id = $1", [a.id]);
    expect(inbox).toEqual([{ kind: "approval", ref_table: "approvals", title: `Task ${id} failed: needs a decision`, status: "open" }]);
    expect((await events(id)).at(-1)).toBe("waiting_on_owner");
    expect(gh.checks).toEqual([]); // a failure posts no merge-rules check

    expect(await decide(id, a.id, "approved")).toBe("applied");
    expect(await task(id)).toMatchObject({ waiting_on: "dev", attempts: 0 });
    expect(devDispatches().at(-1)!.inputs).toMatchObject({ mode: "fix", pr: "43" });

    // Three more failures, then the owner gives up.
    for (let n = 1; n <= MAX_ATTEMPTS; n++) {
      const head = sha(`${id}-again-${n}`);
      await push(id, 43, head);
      await send(id, ciEvent(id, 43, head, "failure"));
    }
    const b = await pendingApproval(id);
    expect(await decide(id, b.id, "rejected")).toBe("applied");
    expect(await task(id)).toMatchObject({ status: "failed", waiting_on: null });
    expect((await events(id)).at(-1)).toBe("failed");
  });

  it("QA requests changes: back to the Developer (counts as an attempt), then CI, QA again and merge", async () => {
    const id = await newTask();
    const [h1, h2] = [sha(`${id}-1`), sha(`${id}-2`)];
    await toQa(id, 44, h1);

    expect(await send(id, reviewEvent(id, 44, h1, "changes_requested"))).toBe("applied");
    expect(await task(id)).toMatchObject({ waiting_on: "dev", attempts: 1 });
    expect(devDispatches().at(-1)!.inputs).toMatchObject({ mode: "fix", pr: "44" });

    await push(id, 44, h2);
    await send(id, ciEvent(id, 44, h2, "success"));
    expect(qaDispatches()).toHaveLength(2);
    // A comment-only review is not a verdict.
    expect(await send(id, reviewEvent(id, 44, h2, "commented"))).toBe("stale");
    expect(await send(id, reviewEvent(id, 44, h2, "approved"))).toBe("applied");
    expect((await task(id)).status).toBe("merged");
    expect(await events(id)).toEqual([
      "task_assigned",
      "pr_opened",
      "ci_running",
      "ci_passed",
      "qa_reviewing",
      "changes_requested",
      "task_assigned",
      "ci_running",
      "ci_passed",
      "qa_reviewing",
      "approved",
      "merged",
    ]);
  });

  describe("critical PR (merge-rules)", () => {
    const INFRA: ChangedFile[] = [ROUTE, { path: "infra/prod/main.tf", status: "modified" }];
    const PATCHES = { "infra/prod/main.tf": "@@ -1 +1 @@\n-# a\n+# b" };

    async function toOwner(id: number, pr: number, head: string) {
      expect(await start(id)).toBe("started");
      expect(await openPr(id, pr, head, INFRA, PATCHES)).toBe("applied");
      await send(id, ciEvent(id, pr, head, "success"));
      expect(await send(id, reviewEvent(id, pr, head, "approved"))).toBe("applied");
      expect(gh.latestCheck(head)).toMatchObject({ state: "pending", title: "Owner approval required" });
      expect(gh.latestCheck(head)!.summary).toContain("infra/prod/main.tf");
      expect(gh.merges).toEqual([]);
      expect(await task(id)).toMatchObject({ status: "waiting", waiting_on: "owner" });
      const a = await pendingApproval(id);
      expect(a.kind).toBe("critical_pr");
      expect(a.reasons.join("\n")).toContain("infra/prod/main.tf");
      expect(await sql("SELECT title FROM inbox_items WHERE ref_id = $1 AND status = 'open'", [a.id])).toEqual([
        { title: `PR #${pr} needs approval: critical change` },
      ]);
      expect((await events(id)).slice(-2)).toEqual(["approved", "waiting_on_owner"]);
      expect(await waits(id)).toEqual([{ phase: "owner", waiting_on: "owner" }]);
      return a;
    }

    it("the owner approves: check success, merged", async () => {
      const id = await newTask();
      const head = sha(`${id}-1`);
      const a = await toOwner(id, 45, head);
      expect(await send(id, sweep(id))).toBe("unchanged"); // the owner never times out
      advance(24 * 60);
      expect(await send(id, sweep(id))).toBe("unchanged");

      expect(await decide(id, a.id, "approved")).toBe("applied");
      expect(gh.latestCheck(head)).toMatchObject({ state: "success", title: "Approved by the owner" });
      expect(gh.merges).toEqual([{ pr: 45, sha: `squash-45-${head}` }]);
      expect(await task(id)).toMatchObject({ status: "merged", waiting_on: null });
      expect((await events(id)).slice(-2)).toEqual(["approved", "merged"]);
    });

    it("the owner rejects: check failure, task cancelled, no merge", async () => {
      const id = await newTask();
      const head = sha(`${id}-1`);
      const a = await toOwner(id, 46, head);
      expect(await decide(id, a.id, "rejected")).toBe("applied");
      expect(gh.latestCheck(head)).toMatchObject({ state: "failure", title: "Rejected by the owner" });
      expect(gh.merges).toEqual([]);
      expect(await task(id)).toMatchObject({ status: "cancelled", waiting_on: null });
      expect((await events(id)).at(-1)).toBe("failed");
    });

    it("a push during the owner wait supersedes the approval and goes back to CI", async () => {
      const id = await newTask();
      const a = await toOwner(id, 47, sha(`${id}-1`));
      expect(await push(id, 47, sha(`${id}-2`))).toBe("applied");
      expect((await task(id)).waiting_on).toBe("ci");
      expect(await sql("SELECT status, note FROM approvals WHERE id = $1", [a.id])).toEqual([
        { status: "rejected", note: "Superseded: the PR head changed; merge-rules runs again." },
      ]);
      // The superseded approval's decision is now stale.
      expect(await send(id, decision(id, a.id, "rejected"))).toBe("stale");
      expect((await task(id)).waiting_on).toBe("ci");
    });
  });

  it("stale and unexpected events are ignored and the thread waits on unchanged", async () => {
    const id = await newTask();
    const [h1, h2] = [sha(`${id}-1`), sha(`${id}-2`)];
    await start(id);
    await openPr(id, 48, h1);
    await push(id, 48, h2); // a second commit before CI finished on the first
    const before = { events: await events(id), task: await task(id), calls: gh.calls.length, state: await waits(id) };

    const stale = [
      ciEvent(id, 48, h1, "failure"), // CI of the superseded head
      ciEvent(id, 48, h2, "success", ".github/workflows/deploy.yml"), // another workflow
      ciEvent(id, 48, h2, "cancelled"), // no verdict
      reviewEvent(id, 48, h2, "approved"), // QA is not running yet
      prEvent(id, "opened", 99, sha("other"), "feature/other"), // someone else's PR
      decision(id, "00000000-0000-4000-8000-000000000000", "approved"), // no owner wait
      { task_id: id, agent: "qa", event_type: "approved" }, // QA's report while waiting on CI
    ];
    for (const m of stale) expect(await send(id, m)).toBe("stale");

    expect(await events(id)).toEqual(before.events);
    expect(await task(id)).toEqual(before.task);
    expect(gh.calls).toHaveLength(before.calls);
    expect(await waits(id)).toEqual(before.state);

    // Redelivery of an applied message (same SQS message id) is not applied twice.
    expect(await send(id, ciEvent(id, 48, h2, "success"), "dup-1")).toBe("applied");
    expect(await send(id, ciEvent(id, 48, h2, "success"), "dup-1")).toBe("duplicate");
    expect(qaDispatches()).toHaveLength(1);

    // No thread for the task: nothing runs.
    expect(await send(999_999, sweep(999_999))).toBe("no_thread");
  });

  it("a decision whose recorded status disagrees, or for another approval, is stale", async () => {
    const id = await newTask();
    await toQa(id, 49, sha(`${id}-1`));
    await send(id, reviewEvent(id, 49, sha(`${id}-1`), "changes_requested"));
    for (let n = 2; n <= MAX_ATTEMPTS; n++) {
      await push(id, 49, sha(`${id}-${n}`));
      await send(id, ciEvent(id, 49, sha(`${id}-${n}`), "failure"));
    }
    const a = await pendingApproval(id);
    // Still pending in the DB: a forged or early "approved" is not applied.
    expect(await send(id, decision(id, a.id, "approved"))).toBe("stale");
    await sql("UPDATE approvals SET status = 'rejected', decided_at = now() WHERE id = $1", [a.id]);
    expect(await send(id, decision(id, a.id, "approved"))).toBe("stale");
    expect((await task(id)).waiting_on).toBe("owner");
    expect(await send(id, decision(id, a.id, "rejected"))).toBe("applied");
    expect((await task(id)).status).toBe("failed");
  });

  describe("timeouts (sweeper)", () => {
    it("the Developer: redispatched once, then the owner decides", async () => {
      const id = await newTask();
      await start(id);
      advance(WAIT_LIMIT_MINUTES.dev - 1);
      expect(await send(id, sweep(id))).toBe("unchanged");
      advance(2);
      expect(await send(id, sweep(id))).toBe("applied");
      expect(devDispatches()).toHaveLength(2);
      expect(devDispatches()[1]!.inputs.mode).toBe("implement");
      expect((await task(id)).waiting_on).toBe("dev");
      advance(WAIT_LIMIT_MINUTES.dev + 1);
      expect(await send(id, sweep(id))).toBe("applied");
      expect(devDispatches()).toHaveLength(2);
      expect((await task(id)).waiting_on).toBe("owner");
      expect((await pendingApproval(id)).reasons[0]).toContain("The Developer did not finish within 60 minutes, twice.");
    });

    it("QA: redispatched once, then the owner; approving dispatches QA again", async () => {
      const id = await newTask();
      await toQa(id, 50, sha(`${id}-1`));
      advance(WAIT_LIMIT_MINUTES.qa + 1);
      await send(id, sweep(id));
      expect(qaDispatches()).toHaveLength(2);
      advance(WAIT_LIMIT_MINUTES.qa + 1);
      await send(id, sweep(id));
      const a = await pendingApproval(id);
      expect(await decide(id, a.id, "approved")).toBe("applied");
      expect(qaDispatches()).toHaveLength(3);
      expect((await task(id)).waiting_on).toBe("qa");
    });

    it("CI: nothing to redispatch, the owner decides after 90 minutes", async () => {
      const id = await newTask();
      await start(id);
      await openPr(id, 51, sha(`${id}-1`));
      advance(WAIT_LIMIT_MINUTES.ci - 1);
      expect(await send(id, sweep(id))).toBe("unchanged");
      advance(2);
      expect(await send(id, sweep(id))).toBe("applied");
      expect((await task(id)).waiting_on).toBe("owner");
      expect((await pendingApproval(id)).reasons[0]).toContain("CI did not finish within 90 minutes.");
    });
  });

  it("paused: nothing starts or is dispatched; inputs queue up and run on unpause", async () => {
    await sql("UPDATE system_flags SET value = 'true' WHERE key = 'agents_paused'");
    const id = await newTask();
    expect(await start(id)).toBe("deferred");
    expect(gh.calls).toEqual([]);
    expect(await task(id)).toMatchObject({ status: "queued", waiting_on: null });
    expect(await send(id, sweep(id))).toBe("paused");
    advance(6 * 60);

    await sql("UPDATE system_flags SET value = 'false' WHERE key = 'agents_paused'");
    expect(await send(id, sweep(id))).toBe("unchanged"); // ran the deferred start first
    expect(gh.issues).toHaveLength(1);
    expect(devDispatches()).toHaveLength(1);
    expect((await task(id)).waiting_on).toBe("dev");

    // Paused mid-loop: the PR event waits; agent reports (usage) are still recorded.
    await sql("UPDATE system_flags SET value = 'true' WHERE key = 'agents_paused'");
    const head = sha(`${id}-1`);
    gh.prs.set(52, { headSha: head, author: DEV_BOT, files: [ROUTE] });
    gh.artifacts.set(head, CLEAN);
    expect(await send(id, prEvent(id, "opened", 52, head))).toBe("deferred");
    const usage = [{ kind: "model", provider: "anthropic", model: "claude-haiku-5-5", input_tokens: 10, output_tokens: 5 }];
    expect(await send(id, { task_id: id, agent: "developer", event_type: "coding", usage })).toBe("applied");
    expect(await send(id, ciEvent(id, 52, head, "success"))).toBe("deferred");
    expect((await task(id)).waiting_on).toBe("dev");
    expect(qaDispatches()).toEqual([]);
    expect(await sql("SELECT agent, model, input_tokens, cost_usd FROM usage_events WHERE task_id = $1", [id])).toEqual([
      { agent: "developer", model: "claude-haiku-5-5", input_tokens: 10, cost_usd: null },
    ]);

    await sql("UPDATE system_flags SET value = 'false' WHERE key = 'agents_paused'");
    await send(id, sweep(id));
    expect((await task(id)).waiting_on).toBe("qa");
    expect(await events(id)).toEqual(["task_assigned", "coding", "pr_opened", "ci_running", "ci_passed", "qa_reviewing"]);
  });

  it(`in-flight limit of ${IN_FLIGHT_LIMIT}: the next task stays queued until a slot frees`, async () => {
    const ids: number[] = [];
    for (let n = 0; n <= IN_FLIGHT_LIMIT; n++) ids.push(await newTask());
    for (const id of ids.slice(0, IN_FLIGHT_LIMIT)) expect(await start(id)).toBe("started");
    const last = ids.at(-1)!;
    expect(await start(last)).toBe("queued");
    expect(gh.issues).toHaveLength(IN_FLIGHT_LIMIT);
    expect(await task(last)).toMatchObject({ status: "queued", waiting_on: null, github_issue: null });
    expect(await send(last, sweep(last))).toBe("queued");

    // One task finishes (merged): the next sweep starts the queued one.
    const first = ids[0]!;
    const head = sha(`${first}-1`);
    await openPr(first, 53, head);
    await send(first, ciEvent(first, 53, head, "success"));
    await send(first, reviewEvent(first, 53, head, "approved"));
    expect((await task(first)).status).toBe("merged");

    expect(await send(last, sweep(last))).toBe("applied");
    expect(gh.issues).toHaveLength(IN_FLIGHT_LIMIT + 1);
    expect(await task(last)).toMatchObject({ status: "waiting", waiting_on: "dev" });
  });

  // ------------------------------------------------------------------ Q11: incomplete inputs

  describe("incomplete merge-rules inputs (Q11)", () => {
    it("an incomplete file list waits, and merges once GitHub lists every file", async () => {
      const id = await newTask();
      const head = sha(`${id}-1`);
      await toQa(id, 54, head);
      gh.prs.get(54)!.complete = false;
      expect(await send(id, reviewEvent(id, 54, head, "approved"))).toBe("applied");
      expect(gh.checks).toEqual([]);
      expect(gh.merges).toEqual([]);
      expect(await task(id)).toMatchObject({ status: "waiting", waiting_on: "ci" });
      advance(30);
      expect(await send(id, sweep(id))).toBe("applied");
      expect(gh.merges).toEqual([]);
      gh.prs.get(54)!.complete = true;
      await send(id, sweep(id));
      expect((await task(id)).status).toBe("merged");
    });

    it.each([
      ["no_artifact", "the ci.yml run has no merge-rules-input artifact"],
      ["no_run", "no ci.yml run was found for the PR head"],
    ] as const)("%s: retried on CI events and sweeps, then critical after the timeout", async (reason, text) => {
      const id = await newTask();
      const head = sha(`${id}-1`);
      await toQa(id, 55, head);
      gh.artifacts.delete(head);
      if (reason === "no_run") gh.headsWithoutRun.add(head);

      expect(await send(id, reviewEvent(id, 55, head, "approved"))).toBe("applied");
      expect((await task(id)).waiting_on).toBe("ci");
      advance(INCOMPLETE_INPUT_TIMEOUT_MINUTES - 1);
      expect(await send(id, ciEvent(id, 55, head, "success"))).toBe("applied"); // a re-run: retried
      expect(gh.calls.filter((c) => c.method === "getArtifact")).toHaveLength(2);
      expect(gh.checks).toEqual([]);

      advance(2);
      expect(await send(id, sweep(id))).toBe("applied");
      expect(gh.latestCheck(head)).toMatchObject({ state: "pending", title: "Owner approval required" });
      expect(gh.merges).toEqual([]);
      const a = await pendingApproval(id);
      expect(a.kind).toBe("critical_pr");
      expect(a.reasons).toEqual([
        `merge-rules input still incomplete after ${INCOMPLETE_INPUT_TIMEOUT_MINUTES} minutes: ${text}. Missing data is never treated as non-critical.`,
      ]);
      expect(await sql("SELECT 1 AS one FROM inbox_items WHERE ref_id = $1", [a.id])).toEqual([{ one: 1 }]);
      expect((await events(id)).slice(-3)).toEqual(["approved", "ci_running", "waiting_on_owner"]);
    });

    it("CI not finished on the head QA approved: waits for the run, then merges", async () => {
      const id = await newTask();
      const [h1, h2] = [sha(`${id}-1`), sha(`${id}-2`)];
      await toQa(id, 56, h1);
      expect(await push(id, 56, h2)).toBe("applied"); // QA pushes its tests
      expect((await task(id)).waiting_on).toBe("qa");
      expect(await send(id, reviewEvent(id, 56, h2, "approved"))).toBe("applied");
      expect(gh.calls.some((c) => c.method === "getDiff")).toBe(false); // nothing read before CI is done
      expect((await task(id)).waiting_on).toBe("ci");
      expect(await send(id, ciEvent(id, 56, h2, "success"))).toBe("applied");
      expect(gh.merges).toEqual([{ pr: 56, sha: `squash-56-${h2}` }]);
    });

    it("CI failing on the head QA approved goes back to the Developer", async () => {
      const id = await newTask();
      const [h1, h2] = [sha(`${id}-1`), sha(`${id}-2`)];
      await toQa(id, 57, h1);
      await push(id, 57, h2);
      expect(await send(id, ciEvent(id, 57, h2, "failure"))).toBe("applied"); // recorded while QA works
      expect((await task(id)).waiting_on).toBe("qa");
      expect(await send(id, reviewEvent(id, 57, h2, "approved"))).toBe("applied");
      expect(await task(id)).toMatchObject({ waiting_on: "dev", attempts: 1 });
    });

    it("a malformed artifact is critical at once (fail closed)", async () => {
      const id = await newTask();
      const head = sha(`${id}-1`);
      await toQa(id, 58, head);
      gh.getArtifact = async (_i: GetArtifactInput): Promise<ArtifactResult> => {
        throw new ArtifactFormatError("bad zip");
      };
      expect(await send(id, reviewEvent(id, 58, head, "approved"))).toBe("applied");
      expect((await pendingApproval(id)).reasons[0]).toContain("malformed (ArtifactFormatError)");
      expect(gh.latestCheck(head)!.state).toBe("pending");
    });
  });

  // ------------------------------------------------------------------ sanitizer (§4.5, Q8)

  describe("public text", () => {
    it("a title naming a contact is never published: the issue says Private task and public_title stays null", async () => {
      const id = await newTask();
      plans.set(id, { title: "Plan Janie's page", body: "Add a page." });
      expect(await start(id)).toBe("started");
      expect(gh.issues[0]!.title).toBe("Private task");
      expect((await task(id)).public_title).toBeNull();
      expect(await sql("SELECT title FROM v_public_agent_events WHERE task_no = $1", [id])).toEqual([{ title: "Private task" }]);
    });

    it("an issue body that fails the content rules waits for an issue_text approval", async () => {
      const id = await newTask();
      plans.set(id, { title: "Add a contact page", body: "Ask Jane Doe for the copy.\nSee https://example.com" });
      expect(await start(id)).toBe("started");
      expect(gh.calls).toEqual([]);
      expect(await task(id)).toMatchObject({ status: "waiting", waiting_on: "owner", github_issue: null });
      const a = await pendingApproval(id);
      expect(a.kind).toBe("issue_text");
      expect(a.reasons[0]).toContain("(url, contact)");

      expect(await decide(id, a.id, "approved")).toBe("applied");
      expect(gh.issues).toHaveLength(1);
      expect(gh.issues[0]!.title).toBe("Add a contact page");
      expect(devDispatches()).toHaveLength(1);
      expect((await task(id)).waiting_on).toBe("dev");
    });

    it("rejecting the issue text cancels the task without touching GitHub", async () => {
      const id = await newTask();
      plans.set(id, { title: "Add a page", body: "Call 555-123-4567" });
      await start(id);
      const a = await pendingApproval(id);
      expect(await decide(id, a.id, "rejected")).toBe("applied");
      expect(gh.calls).toEqual([]);
      expect(await task(id)).toMatchObject({ status: "cancelled" });
    });
  });

  // ------------------------------------------------------------------ failures

  it("a GitHub error returns the message to the queue; the redelivery completes the step without a second issue", async () => {
    const id = await newTask();
    gh.failNext("dispatchWorkflow", 502);
    expect(await send(id, { type: "task.created", task_id: id }, "start-x")).toBe("failed");
    expect(gh.issues).toHaveLength(1);
    expect(await send(id, { type: "task.created", task_id: id }, "start-x")).toBe("recovered");
    expect(gh.issues).toHaveLength(1);
    expect(devDispatches()).toHaveLength(1);
    expect((await task(id)).waiting_on).toBe("dev");
  });

  it("logs no task text or message content", async () => {
    const id = await newTask("Secret owner text about Jane Doe");
    const lines: string[] = [];
    deps.log = (l) => lines.push(l);
    try {
      await start(id);
      await send(id, ciEvent(id, 1, sha("x"), "success"));
    } finally {
      delete deps.log;
    }
    expect(lines.join("\n")).not.toMatch(/secret|jane|healthz/i);
  });
});
