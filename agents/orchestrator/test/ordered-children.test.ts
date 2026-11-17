// AR4 ordered child work (DESIGN §4.0, §4.2 step 2, §4.3): validated prerequisites, sequential by
// default, a consumer starts from the accepted predecessor's merge, child starts are outbox
// messages, and a failed prerequisite parks the parent. GitHub is FakeGitHubClient, the planner a
// fake; Postgres is PGlite (all migrations, 0020 included) served over the wire protocol as orch_rw.
import { createHash } from "node:crypto";
import { parseContract } from "@kcw/core/contract";
import { PGlite } from "@electric-sql/pglite";
import type { MergeInput } from "@kcw/core/merge-input";
import { fromPglite, migrate } from "@kcw/db";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkpointerFromPool, setupCheckpointer, threadConfig } from "../src/index";
import { FakeGitHubClient, type ChangedFile } from "../src/github";
import {
  PgReceiptStore,
  PgTaskStore,
  blockedChildren,
  buildTaskGraph,
  handleTaskSqsEvent,
  orderSubtasks,
  type SubtaskList,
  type TaskGraph,
  type TaskGraphDeps,
} from "../src/graph";
import { parseSubtasks } from "../src/nodes/planner";
import { servePglite, type PgSocketServer } from "./pg-socket";

const sha = (s: string) => createHash("sha1").update(s).digest("hex");
const DEV_BOT = "kcw-developer[bot]";
const SENDER = { id: 1, login: "kcw-orchestrator[bot]", type: "Bot" };
const ROUTE: ChangedFile = { path: "apps/web/src/app/healthz/route.ts", status: "added" };
const clean = (pr: number, head: string): MergeInput => ({
  pr,
  headSha: head,
  planSummary: { format: 1, infra: [], artifact: { count: 1, kinds: { create: 0, update: 1, delete: 0, replace: 0 } } },
  lockDiff: { added: [], existing: [] },
  uncoveredPaths: [],
});
const list = (texts: string[], after?: (number[] | undefined)[]): SubtaskList => Object.assign([...texts], after && { after });

describe("orderSubtasks and the planner's order schema (AR4)", () => {
  it("defaults to sequential and keeps explicit independence", () => {
    expect(orderSubtasks(["a", "b", "c"])).toEqual({ ok: true, value: [[], [0], [1]] });
    expect(orderSubtasks(list(["a", "b", "c"], [[], [], undefined]))).toEqual({ ok: true, value: [[], [], [1]] });
    expect(orderSubtasks(list(["a", "b", "c"], [[2], [], []]))).toEqual({ ok: true, value: [[2], [], []] });
  });

  it("rejects self references, unknown subtasks, repeats and cycles", () => {
    expect(orderSubtasks(list(["a", "b"], [[], [1]]))).toEqual({ ok: false, reason: "subtask 2 depends on itself" });
    expect(orderSubtasks(list(["a", "b"], [[], [2]]))).toEqual({ ok: false, reason: "subtask 2 depends on an unknown subtask" });
    expect(orderSubtasks(list(["a", "b"], [[], [0, 0]]))).toEqual({ ok: false, reason: "subtask 2 lists a prerequisite twice" });
    expect(orderSubtasks(list(["a", "b", "c"], [[2], [0], [1]]))).toEqual({ ok: false, reason: "the subtask order has a cycle" });
  });

  it("parses 1-based after lists from the model and refuses an invalid order", () => {
    const parsed = parseSubtasks(JSON.stringify({ subtasks: ["Add the table", { text: "Add the page", after: [] }, { text: "Link them", after: [1, 2] }] }));
    expect(parsed.ok && [...parsed.value]).toEqual(["Add the table", "Add the page", "Link them"]);
    expect(parsed.ok && parsed.value.after).toEqual([undefined, [], [0, 1]]);
    const plain = parseSubtasks(JSON.stringify({ subtasks: ["One", "Two"] }));
    expect(plain.ok && plain.value.after).toBeUndefined();
    expect(parseSubtasks(JSON.stringify({ subtasks: ["One", { text: "Two", after: [2] }] }))).toEqual({ ok: false, reason: "subtask 2 depends on itself" });
    expect(parseSubtasks(JSON.stringify({ subtasks: [{ text: "One", after: [2] }, { text: "Two", after: [1] }] }))).toEqual({ ok: false, reason: "the subtask order has a cycle" });
    expect(parseSubtasks(JSON.stringify({ subtasks: ["One", { text: "Two", after: "1" }] }))).toEqual({ ok: false, reason: "subtasks[1].after is not a list of subtask numbers" });
  });

  it("blocks queued children behind a failed prerequisite, transitively", () => {
    const blocked = blockedChildren([
      { id: 1, status: "failed", prerequisites: [] },
      { id: 2, status: "queued", prerequisites: [1] },
      { id: 3, status: "queued", prerequisites: [2] },
      { id: 4, status: "waiting", prerequisites: [] },
      { id: 5, status: "queued", prerequisites: [4] },
    ]);
    expect([...blocked].sort()).toEqual([2, 3]);
  });
});

describe("ordered child work in the task graph (AR4)", () => {
  let db: PGlite;
  let srv: PgSocketServer;
  let pool: pg.Pool;
  let graph: TaskGraph;
  let gh: FakeGitHubClient;
  let store: PgTaskStore;
  let receipts: PgReceiptStore;
  const clock = new Date("2026-11-15T10:00:00Z");
  const splits = new Map<number, SubtaskList>();
  const deps: TaskGraphDeps = {
    github: new FakeGitHubClient(),
    store: undefined as unknown as PgTaskStore,
    planner: {
      split: async (r) => splits.get(r.task_id) ?? [r.owner_text],
      plan: async (r) => ({ title: `Do ${r.owner_text.toLowerCase()}`, body: `${r.owner_text}.`, acceptance: ["It works."], scope: [], context: [] }),
    },
    now: () => clock,
    activeExecutionLimit: 4, // these tests run several workers at once to test other limits and ordering
  };
  let seq = 0;

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
    srv = await servePglite(db, { role: "orch_rw" });
    pool = new pg.Pool({ connectionString: srv.url, max: 1 });
    await setupCheckpointer(pool);
    store = new PgTaskStore(pool);
    receipts = new PgReceiptStore(pool);
    deps.store = store;
    graph = buildTaskGraph(checkpointerFromPool(pool), deps);
  }, 60_000);

  afterAll(async () => {
    await pool.end().catch(() => undefined);
    await srv.close();
    await db.close();
  });

  beforeEach(async () => {
    gh = new FakeGitHubClient();
    gh.now = () => clock;
    deps.github = gh;
    await sql("UPDATE tasks SET status = 'done' WHERE status IN ('planning', 'in_progress', 'waiting')");
    await sql("UPDATE orchestrator_outbox SET sent_at = now() WHERE sent_at IS NULL");
  });

  async function send(taskId: number, body: unknown, messageId = `m${++seq}`, group = `task-${taskId}`): Promise<string> {
    // AR5b: an approval counts only after its QA attempt's start report; this harness starts the latest QA attempt.
    const sent = (typeof body === "string" ? JSON.parse(body) : body) as { resume?: { event?: string; payload?: { review_state?: string } } } | null;
    if (sent?.resume?.event === "pull_request_review.submitted" && sent.resume.payload?.review_state === "approved") {
      await sql(
        "UPDATE task_attempts SET started_at = now() WHERE started_at IS NULL AND effect_key = (SELECT effect_key FROM task_attempts WHERE task_id = $1 AND role = 'qa' ORDER BY op DESC LIMIT 1)",
        [taskId],
      );
    }
    const lines: string[] = [];
    const res = await handleTaskSqsEvent(
      { Records: [{ messageId, body: typeof body === "string" ? body : JSON.stringify(body), attributes: { MessageGroupId: group } }] },
      { graph, receipts, log: (l) => lines.push(l) },
    );
    if (res.batchItemFailures.length > 0) return "failed";
    const last = lines.at(-1)!;
    return last.slice(last.indexOf(": ") + 2);
  }

  /** The sweeper's outbox part: every unsent row in id order, marked sent after the send. */
  async function deliverOutbox(): Promise<string[]> {
    const rows = await sql<{ id: string; group_id: string; body: string; message_key: string }>(
      "SELECT id, group_id, body, message_key FROM orchestrator_outbox WHERE sent_at IS NULL ORDER BY id",
    );
    const out: string[] = [];
    for (const r of rows) {
      out.push(`${r.message_key}: ${await send(0, r.body, `o${++seq}`, r.group_id)}`);
      await sql("UPDATE orchestrator_outbox SET sent_at = now() WHERE id = $1", [r.id]);
    }
    return out;
  }

  const outboxKeys = async (ids: number[]) =>
    (await sql<{ message_key: string }>("SELECT message_key FROM orchestrator_outbox WHERE group_id = ANY($1::text[]) ORDER BY id", [ids.map((i) => `task-${i}`)])).map((r) => r.message_key);

  const github = (taskId: number, payload: Record<string, unknown>, headSha: string | null) => ({
    source: "github",
    delivery_id: `d-${++seq}`,
    task_id: taskId,
    thread_id: `task-${taskId}`,
    resume: { event: `${payload.type}.${payload.action}`, head_sha: headSha, payload: { ...payload, sender: SENDER } },
  });
  const prEvent = (taskId: number, action: string, pr: number, head: string, merged = false) =>
    github(taskId, { type: "pull_request", action, pr_number: pr, merged, draft: false, head_ref: `kcw/task-${taskId}`, head_sha: head, base_ref: "main" }, head);
  const ciEvent = (taskId: number, pr: number, head: string) =>
    github(taskId, {
      type: "workflow_run", action: "completed", run_id: ++seq, run_attempt: 1, workflow_path: ".github/workflows/ci.yml", workflow_name: "ci",
      status: "completed", conclusion: "success", trigger: "pull_request", head_branch: `kcw/task-${taskId}`, head_sha: head, pr_numbers: [pr],
      run_started_at: null, updated_at: null,
    }, head);
  const reviewEvent = (taskId: number, pr: number, head: string) =>
    github(taskId, { type: "pull_request_review", action: "submitted", pr_number: pr, review_state: "approved", commit_id: head }, head);
  const sweep = (taskId: number) => send(taskId, { type: "sweep", task_id: taskId, thread_id: `task-${taskId}` });
  const start = (taskId: number) => send(taskId, { type: "task.created", task_id: taskId });

  async function newTask(ownerText: string): Promise<number> {
    const [row] = await sql<{ id: string }>("INSERT INTO tasks (source, owner_text, is_private) VALUES ('console', $1, false) RETURNING id", [ownerText]);
    const id = Number(row!.id);
    await sql("UPDATE tasks SET thread_id = 'task-' || id WHERE id = $1", [id]);
    return id;
  }
  async function kids(parent: number): Promise<number[]> {
    return (await sql<{ id: string }>("SELECT id FROM tasks WHERE parent_id = $1 ORDER BY id", [parent])).map((r) => Number(r.id));
  }
  async function task(id: number) {
    const [row] = await sql<{ status: string; waiting_on: string | null; merge_sha: string | null }>("SELECT status, waiting_on, merge_sha FROM tasks WHERE id = $1", [id]);
    return row!;
  }
  const hasThread = async (id: number) => (await graph.getState(threadConfig(id))).config.configurable?.checkpoint_id !== undefined;
  const issuesOf = (id: number) => gh.issues.filter((i) => i.body.includes(`kcw/task-${id}`));
  const devCalls = (id: number) =>
    gh.calls.flatMap((c, i) => (c.method === "dispatchWorkflow" && (c.args as { workflow: string; inputs: { task_id: string } }).workflow === "agent-developer.yml" &&
      (c.args as { inputs: { task_id: string } }).inputs.task_id === String(id) ? [i] : []));

  /** Runs a started child through PR, CI, QA approval and the merge; returns the merge commit and the review message id. */
  async function mergeChild(id: number, pr: number, reviewMessageId = `rev-${++seq}`): Promise<string> {
    const head = sha(`head-${id}`);
    gh.prs.set(pr, { headSha: head, author: DEV_BOT, files: [ROUTE] });
    gh.artifacts.set(head, clean(pr, head));
    expect(await send(id, prEvent(id, "opened", pr, head))).toBe("applied");
    expect(await send(id, ciEvent(id, pr, head))).toBe("applied");
    expect(await send(id, reviewEvent(id, pr, head), reviewMessageId)).toBe("applied");
    expect(await task(id)).toMatchObject({ status: "merged" });
    return gh.merges.find((m) => m.pr === pr)!.sha;
  }

  it("schema then consumer: the consumer starts only after the schema merged, from a base that contains it", async () => {
    const parent = await newTask("Schema and consumer");
    const order = list(["Add the table", "Read the table on a page"]); // no markings: sequential
    splits.set(parent, order);
    expect(await start(parent)).toBe("started");
    const [schema, consumer] = (await kids(parent)) as [number, number];
    expect(await outboxKeys([schema, consumer])).toEqual([`task-${schema}/start`]);
    expect(gh.calls.filter((c) => c.method !== "getBranchHead" && c.method !== "readFile")).toEqual([]);

    expect(await deliverOutbox()).toEqual([`task-${schema}/start: started`]);
    expect(issuesOf(schema)).toHaveLength(1);
    expect(await task(consumer)).toMatchObject({ status: "queued", merge_sha: null });
    expect(await hasThread(consumer)).toBe(false);

    const merge = await mergeChild(schema, 201);
    // Released in the merge's own write: the schema records its merge commit, the consumer its start message.
    expect(await task(schema)).toMatchObject({ status: "merged", merge_sha: merge });
    expect(await task(consumer)).toMatchObject({ status: "queued", merge_sha: null });
    expect(await outboxKeys([consumer])).toEqual([`task-${consumer}/start`]);
    gh.heads.set("main", "9".repeat(40)); // main moved on since the parent was planned
    expect(await deliverOutbox()).toEqual([`task-${consumer}/start: started`]);

    const [issue] = issuesOf(consumer);
    expect(issue!.body).toContain(`Prerequisites merged on \`main\`: ${merge}.`);
    const mergeCall = gh.calls.findIndex((c) => c.method === "merge" && (c.args as { pr: number }).pr === 201);
    expect(devCalls(consumer)).toHaveLength(1);
    expect(devCalls(consumer)[0]!).toBeGreaterThan(mergeCall); // dispatched on main after the merge
    // AR5a: the consumer's contract names main's head read at its planning and the schema's own merge commit.
    const dispatched = gh.dispatches.find((d) => d.workflow === "agent-developer.yml" && d.inputs.task_id === String(consumer))!;
    expect(parseContract(dispatched.inputs.contract)).toMatchObject({ task: consumer, base: gh.heads.get("main"), prerequisites: [{ task: schema, merge }] });
    expect(await task(consumer)).toMatchObject({ status: "waiting", waiting_on: "dev" });
  });

  it("a failed prerequisite blocks its consumers; the parent parks for the owner once nothing else can run", async () => {
    const parent = await newTask("Three parts");
    splits.set(parent, list(["Add the table", "Read the table", "Write the help page"], [undefined, undefined, []]));
    expect(await start(parent)).toBe("started");
    const [a, b, c] = (await kids(parent)) as [number, number, number];
    // a and the independent c start together; b waits for a.
    expect(await deliverOutbox()).toEqual([`task-${a}/start: started`, `task-${c}/start: started`]);

    // a's PR is closed without a merge: a ends cancelled.
    const head = sha(`head-${a}`);
    gh.prs.set(301, { headSha: head, author: DEV_BOT, files: [ROUTE] });
    expect(await send(a, prEvent(a, "opened", 301, head))).toBe("applied");
    expect(await send(a, prEvent(a, "closed", 301, head))).toBe("applied");
    expect(await task(a)).toMatchObject({ status: "cancelled" });
    expect(await outboxKeys([b])).toEqual([]);

    // c still runs: the parent waits.
    expect(await sweep(parent)).toBe("unchanged");
    await store.mergeTask(c, sha("merge-c"));
    expect(await deliverOutbox()).toEqual([]); // nothing depends on c
    expect(await sweep(parent)).toBe("applied");
    expect(await task(parent)).toMatchObject({ status: "waiting", waiting_on: "owner" });
    const [approval] = await sql<{ id: string; reasons: string[] }>("SELECT id, reasons FROM approvals WHERE task_id = $1 AND status = 'pending'", [parent]);
    expect(approval!.reasons).toEqual([
      `Subtask task-${a} ended without a merge; the subtasks that depend on it were not started: task-${b}.`,
      "Approve or reject to close the task as failed; the blocked subtasks are then cancelled.",
    ]);
    expect(await task(b)).toMatchObject({ status: "queued" });
    expect(await hasThread(b)).toBe(false);

    await sql("UPDATE approvals SET status = 'approved', decided_at = now() WHERE id = $1", [approval!.id]);
    expect(await send(parent, { type: "owner.decision", task_id: parent, thread_id: `task-${parent}`, resume: { approval_id: approval!.id, decision: "approved" } })).toBe("applied");
    expect(await task(parent)).toMatchObject({ status: "failed" });
    expect(await task(b)).toMatchObject({ status: "cancelled" });
    expect(issuesOf(b)).toEqual([]);
  });

  it("a restart after the merge's write and duplicate messages never start a child twice", async () => {
    const parent = await newTask("Two parts");
    splits.set(parent, list(["Add the table", "Read the table"]));
    expect(await start(parent)).toBe("started");
    const [a, b] = (await kids(parent)) as [number, number];
    expect(await deliverOutbox()).toEqual([`task-${a}/start: started`]);

    // The merge step crashes right after the merged status and b's release were committed.
    const real = store.mergeTask.bind(store);
    let crash = true;
    store.mergeTask = async (id, mergeSha) => {
      const released = await real(id, mergeSha);
      if (crash) {
        crash = false;
        throw new Error("lost before the checkpoint");
      }
      return released;
    };
    try {
      const head = sha(`head-${a}`);
      gh.prs.set(401, { headSha: head, author: DEV_BOT, files: [ROUTE] });
      gh.artifacts.set(head, clean(401, head));
      expect(await send(a, prEvent(a, "opened", 401, head))).toBe("applied");
      expect(await send(a, ciEvent(a, 401, head))).toBe("applied");
      const review = reviewEvent(a, 401, head);
      expect(await send(a, review, "rev-crash")).toBe("failed");
      expect(await send(a, review, "rev-crash")).toBe("recovered"); // SQS redelivers the same message
      expect(gh.merges.filter((m) => m.pr === 401)).toHaveLength(1);
      // The merge webhook arrives too (a second completion signal): the thread has ended.
      expect(await send(a, prEvent(a, "closed", 401, head, true))).toBe("finished");
    } finally {
      store.mergeTask = real;
    }
    const merge = gh.merges.find((m) => m.pr === 401)!.sha;
    expect(await task(a)).toMatchObject({ merge_sha: merge });
    expect(await task(b)).toMatchObject({ merge_sha: null });
    // One more completion write: b is still queued, so it is named again, but nothing new is written.
    expect(await store.mergeTask(a, "f".repeat(40))).toEqual([b]);
    expect(await task(a)).toMatchObject({ merge_sha: merge }); // the first merge commit is kept
    expect(await outboxKeys([b])).toEqual([`task-${b}/start`]);

    const [row] = await sql<{ body: string }>("SELECT body FROM orchestrator_outbox WHERE message_key = $1", [`task-${b}/start`]);
    expect(await deliverOutbox()).toEqual([`task-${b}/start: started`]);
    // The same message sent again (after SQS's deduplication window): the receipt drops it.
    expect(await send(0, row!.body, "resend-1", `task-${b}`)).toBe("duplicate");
    // A start without that key on the running thread is a duplicate start.
    expect(await start(b)).toBe("duplicate_start");
    expect(issuesOf(b)).toHaveLength(1);
    expect(devCalls(b)).toHaveLength(1);
  });

  it("an invalid dependency graph from the planner goes to the owner; no child is created", async () => {
    const parent = await newTask("Circular parts");
    splits.set(parent, list(["One", "Two"], [[1], [0]]));
    expect(await start(parent)).toBe("started");
    expect(await kids(parent)).toEqual([]);
    expect(await task(parent)).toMatchObject({ status: "waiting", waiting_on: "owner" });
    const [approval] = await sql<{ reasons: string[] }>("SELECT reasons FROM approvals WHERE task_id = $1 AND status = 'pending'", [parent]);
    expect(approval!.reasons[0]).toBe("Task failed: The planner model returned unusable output (the subtask order has a cycle).");
    expect(gh.calls.filter((c) => c.method !== "getBranchHead" && c.method !== "readFile")).toEqual([]);
  });

  it("an early start or a sweep of a child does not run it before its prerequisites merged", async () => {
    const parent = await newTask("Two parts again");
    splits.set(parent, list(["Add the table", "Read the table"]));
    await start(parent);
    const [a, b] = (await kids(parent)) as [number, number];
    await deliverOutbox();
    expect(await start(b)).toBe("queued");
    expect(await sweep(b)).toBe("queued");
    expect(issuesOf(b)).toEqual([]);
    expect(await task(b)).toMatchObject({ status: "queued" });

    expect(await store.mergeTask(a, "c".repeat(40))).toEqual([b]);
    // Its thread exists, so its start message is a duplicate start; the next sweep starts it.
    expect(await deliverOutbox()).toEqual([`task-${b}/start: duplicate_start`]);
    expect(await sweep(b)).toBe("applied");
    expect(issuesOf(b)[0]!.body).toContain(`Prerequisites merged on \`main\`: ${"c".repeat(40)}.`);
  });

  /** Parent with independent subtasks A and B and a consumer C after both; A and B are started. */
  async function fanIn(title: string): Promise<[number, number, number]> {
    const parent = await newTask(title);
    splits.set(parent, list(["Add the table", "Add the index", "Read both"], [[], [], [0, 1]]));
    expect(await start(parent)).toBe("started");
    const [a, b, c] = (await kids(parent)) as [number, number, number];
    expect(await deliverOutbox()).toEqual([`task-${a}/start: started`, `task-${b}/start: started`]);
    expect(await outboxKeys([c])).toEqual([]);
    return [a, b, c];
  }

  /** A webhook-only merge: the PR closed as merged, with no merge commit from GitHub. */
  async function mergeByWebhook(id: number, pr: number): Promise<void> {
    const head = sha(`head-${id}`);
    gh.prs.set(pr, { headSha: head, author: DEV_BOT, files: [ROUTE] });
    gh.artifacts.set(head, clean(pr, head));
    expect(await send(id, prEvent(id, "opened", pr, head))).toBe("applied");
    expect(await send(id, prEvent(id, "closed", pr, head, true))).toBe("applied");
    expect(await task(id)).toMatchObject({ status: "merged", merge_sha: null });
  }

  it("a consumer of two independent prerequisites is released once, by the second merge (A then B)", async () => {
    const [a, b, c] = await fanIn("Two inputs, one page");
    const mA = await mergeChild(a, 501);
    expect(await task(c)).toMatchObject({ status: "queued", merge_sha: null });
    expect(await outboxKeys([c])).toEqual([]);
    const mB = await mergeChild(b, 502);
    expect(await outboxKeys([c])).toEqual([`task-${c}/start`]); // one start row
    expect(await task(a)).toMatchObject({ status: "merged", merge_sha: mA });
    expect(await task(b)).toMatchObject({ status: "merged", merge_sha: mB });
    expect(await task(c)).toMatchObject({ status: "queued", merge_sha: null });

    expect(await deliverOutbox()).toEqual([`task-${c}/start: started`]);
    expect(issuesOf(c)[0]!.body).toContain(`Prerequisites merged on \`main\`: ${mA}, ${mB}.`); // prerequisite order
    expect(devCalls(c)).toHaveLength(1);
  });

  it("a consumer of two independent prerequisites is released once, by the second merge (B then A)", async () => {
    const [a, b, c] = await fanIn("Two inputs, another page");
    const mB = await mergeChild(b, 511);
    expect(await task(c)).toMatchObject({ status: "queued", merge_sha: null });
    expect(await outboxKeys([c])).toEqual([]);
    const mA = await mergeChild(a, 512);
    expect(await outboxKeys([c])).toEqual([`task-${c}/start`]); // one start row
    expect(await task(a)).toMatchObject({ merge_sha: mA });
    expect(await task(b)).toMatchObject({ merge_sha: mB });

    expect(await deliverOutbox()).toEqual([`task-${c}/start: started`]);
    expect(issuesOf(c)[0]!.body).toContain(`Prerequisites merged on \`main\`: ${mA}, ${mB}.`); // prerequisite order, not merge order
    expect(devCalls(c)).toHaveLength(1);
  });

  /** AR5a: the consumer of a prerequisite with no recorded merge commit is not planned; the owner decides. */
  async function expectPlanningFailure(consumer: number): Promise<void> {
    expect(await task(consumer)).toMatchObject({ status: "waiting", waiting_on: "owner" });
    const [approval] = await sql<{ reasons: string[] }>("SELECT reasons FROM approvals WHERE task_id = $1 AND status = 'pending'", [consumer]);
    expect(approval!.reasons[0]).toBe("Task failed: a prerequisite task has no recorded merge commit, so the task cannot be planned; approve to plan it again");
    expect(issuesOf(consumer)).toEqual([]);
    expect(devCalls(consumer)).toEqual([]);
  }

  it("a webhook-only merge (no sha) releases the consumer and leaves merge_sha null; the consumer goes to the owner at planning", async () => {
    const parent = await newTask("Webhook merge");
    splits.set(parent, list(["Add the table", "Read the table"]));
    expect(await start(parent)).toBe("started");
    const [a, b] = (await kids(parent)) as [number, number];
    expect(await deliverOutbox()).toEqual([`task-${a}/start: started`]);

    await mergeByWebhook(a, 521);
    expect(await task(b)).toMatchObject({ status: "queued", merge_sha: null });
    expect(await outboxKeys([b])).toEqual([`task-${b}/start`]);
    expect(await deliverOutbox()).toEqual([`task-${b}/start: started`]);
    await expectPlanningFailure(b);
  });

  it("a second merge call for the same task keeps the first merge_sha and adds no outbox row", async () => {
    const parent = await newTask("Repeated merge");
    splits.set(parent, list(["Add the table", "Read the table"]));
    expect(await start(parent)).toBe("started");
    const [a, b] = (await kids(parent)) as [number, number];
    expect(await deliverOutbox()).toEqual([`task-${a}/start: started`]);

    expect(await store.mergeTask(a, "1".repeat(40))).toEqual([b]);
    expect(await outboxKeys([b])).toEqual([`task-${b}/start`]);
    expect(await store.mergeTask(a, "2".repeat(40))).toEqual([b]);
    expect(await task(a)).toMatchObject({ status: "merged", merge_sha: "1".repeat(40) });
    expect(await outboxKeys([b])).toEqual([`task-${b}/start`]); // still one row
  });

  it("with one prerequisite merge commit unknown, the consumer goes to the owner at planning", async () => {
    const [a, b, c] = await fanIn("One merge unknown");
    await mergeChild(a, 531);
    await mergeByWebhook(b, 532);
    expect(await deliverOutbox()).toEqual([`task-${c}/start: started`]);
    await expectPlanningFailure(c);
  });

  it("with no prerequisite merge commit known, the consumer goes to the owner at planning", async () => {
    const [a, b, c] = await fanIn("None merge commits known");
    await mergeByWebhook(a, 541);
    await mergeByWebhook(b, 542);
    expect(await outboxKeys([c])).toEqual([`task-${c}/start`]);
    expect(await deliverOutbox()).toEqual([`task-${c}/start: started`]);
    await expectPlanningFailure(c);
  });
});
