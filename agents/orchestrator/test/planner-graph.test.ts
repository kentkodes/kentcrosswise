// P2-11 definition of done: the planner and public-title nodes (ModelPlanner on FakeProvider) in
// the P2-10 task graph. Postgres is PGlite (migrations 0001-0003) served over the wire protocol and
// used as orch_rw; GitHub is FakeGitHubClient.
import { PGlite } from "@electric-sql/pglite";
import { FakeProvider, type CompleteRequest } from "@kcw/core/models";
import { fromPglite, migrate } from "@kcw/db";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkpointerFromPool, setupCheckpointer, threadConfig } from "../src/index";
import { FakeGitHubClient } from "../src/github";
import { PgTaskStore, buildTaskGraph, handleTaskSqsEvent, type TaskGraph, type TaskGraphDeps } from "../src/graph";
import { ModelPlanner, PLANNER_SYSTEM } from "../src/nodes";
import { servePglite, type PgSocketServer } from "./pg-socket";

type Answer = string | ((req: CompleteRequest) => string);

describe("planner and public-title nodes in the task graph (P2-11)", () => {
  let db: PGlite;
  let srv: PgSocketServer;
  let pool: pg.Pool;
  let graph: TaskGraph;
  let gh: FakeGitHubClient;
  let provider: FakeProvider;
  /** Scripted model replies, per node, consumed in order. */
  let replies: { planner: Answer[]; public_title: Answer[] };
  let seq = 0;

  const deps: TaskGraphDeps = {
    github: new FakeGitHubClient(),
    store: undefined as unknown as PgTaskStore,
    planner: undefined as unknown as ModelPlanner,
    now: () => new Date("2026-10-23T10:00:00Z"),
  };

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
    replies = { planner: [], public_title: [] };
    provider = new FakeProvider({
      complete: (req) => {
        const queue = req.system === PLANNER_SYSTEM ? replies.planner : replies.public_title;
        const next = queue.shift();
        if (next === undefined) return new Error("unexpected model call");
        return { text: typeof next === "function" ? next(req) : next };
      },
    });
    deps.planner = new ModelPlanner({ provider });
    await sql("UPDATE tasks SET status = 'done' WHERE status IN ('planning', 'in_progress', 'waiting')");
  });

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
  const start = (id: number) => send(id, { type: "task.created", task_id: id });
  const sweep = (id: number) => send(id, { type: "sweep", task_id: id, thread_id: `task-${id}` });

  async function newTask(ownerText: string): Promise<number> {
    const [row] = await sql<{ id: string }>(
      "INSERT INTO tasks (source, owner_text, is_private) VALUES ('console', $1, false) RETURNING id",
      [ownerText],
    );
    const id = Number(row!.id);
    await sql("UPDATE tasks SET thread_id = 'task-' || id WHERE id = $1", [id]);
    return id;
  }

  async function task(id: number) {
    const [row] = await sql<{
      status: string;
      waiting_on: string | null;
      public_title: string | null;
      github_issue: number | null;
      branch: string | null;
    }>("SELECT status, waiting_on, public_title, github_issue, branch FROM tasks WHERE id = $1", [id]);
    return row!;
  }

  const children = (id: number) =>
    sql<{ id: string; owner_text: string; source: string; is_private: boolean; thread_id: string; status: string }>(
      "SELECT id, owner_text, source, is_private, thread_id, status FROM tasks WHERE parent_id = $1 ORDER BY id",
      [id],
    );

  const pendingApprovals = (id: number) =>
    sql<{ id: string; kind: string; reasons: string[] }>("SELECT id, kind, reasons FROM approvals WHERE task_id = $1 AND status = 'pending'", [id]);

  async function decide(id: number, approvalId: string, d: "approved" | "rejected") {
    await sql("UPDATE approvals SET status = $2, decided_at = now() WHERE id = $1", [approvalId, d]);
    return send(id, { type: "owner.decision", task_id: id, thread_id: `task-${id}`, resume: { approval_id: approvalId, decision: d } });
  }

  const devDispatches = () => gh.dispatches.filter((x) => x.workflow === "agent-developer.yml");
  const plan = (title: string, body: string) => JSON.stringify({ title, body });

  // ------------------------------------------------------------------ DoD

  it("happy path: two subtasks become child tasks, each with its own issue and Developer; the parent ends when both merge", async () => {
    const id = await newTask("Add a healthz page and a status badge for Jane");
    replies.planner.push('{"subtasks": ["Add a /healthz route that returns ok", "Add a status badge to the footer"]}');
    replies.public_title.push(
      (req) => (req.prompt.includes("/healthz") ? plan("Add a healthz page", "Add a /healthz route that returns ok.") : "unexpected"),
      (req) => (req.prompt.includes("badge") ? plan("Add a status badge", "Show a status badge in the footer.") : "unexpected"),
    );

    expect(await start(id)).toBe("started");

    const kids = await children(id);
    expect(kids.map((k) => ({ owner_text: k.owner_text, source: k.source, is_private: k.is_private }))).toEqual([
      { owner_text: "Add a /healthz route that returns ok", source: "console", is_private: false },
      { owner_text: "Add a status badge to the footer", source: "console", is_private: false },
    ]);
    const [a, b] = kids.map((k) => Number(k.id)) as [number, number];
    expect(kids.map((k) => k.thread_id)).toEqual([`task-${a}`, `task-${b}`]);

    // The parent publishes nothing itself and waits for its children without holding a dev wait.
    expect(await task(id)).toMatchObject({ status: "waiting", waiting_on: null, github_issue: null, public_title: null });
    expect((await graph.getState(threadConfig(id))).values.task).toMatchObject({ phase: "children", children: [a, b] });

    // Each child: public title, issue on its own branch, Developer dispatched.
    expect(gh.issues.map((i) => i.title)).toEqual(["Add a healthz page", "Add a status badge"]);
    expect(gh.issues[0]!.body).toContain(`kcw/task-${a}`);
    expect(gh.issues[1]!.body).toContain(`kcw/task-${b}`);
    expect(gh.issues.map((i) => i.body).join("\n")).not.toMatch(/jane/i); // owner text never reaches GitHub
    expect(devDispatches().map((d) => d.inputs.task_id)).toEqual([String(a), String(b)]);
    expect(await task(a)).toMatchObject({ status: "waiting", waiting_on: "dev", public_title: "Add a healthz page", branch: `kcw/task-${a}` });
    expect(await task(b)).toMatchObject({ status: "waiting", waiting_on: "dev", public_title: "Add a status badge" });
    // One planner call for the parent; one public-title call per child (children are never split again).
    expect(provider.calls).toHaveLength(3);

    // A repeated start changes nothing (no second split, no second issue).
    expect(await start(id)).toBe("duplicate_start");
    expect(await children(id)).toHaveLength(2);
    expect(gh.issues).toHaveLength(2);

    // The parent ends on the first sweep after both children merged.
    await sql("UPDATE tasks SET status = 'merged', waiting_on = NULL WHERE id = $1", [a]);
    expect(await sweep(id)).toBe("unchanged");
    await sql("UPDATE tasks SET status = 'merged', waiting_on = NULL WHERE id = $1", [b]);
    expect(await sweep(id)).toBe("applied");
    expect(await task(id)).toMatchObject({ status: "done", waiting_on: null });
    expect((await graph.getState(threadConfig(id))).next).toEqual([]);
  });

  it("a single subtask is the task itself: no child rows", async () => {
    const id = await newTask("Add a healthz page");
    replies.planner.push('{"subtasks": ["Add a /healthz route that returns ok"]}');
    replies.public_title.push(plan("Add a healthz page", "Add a /healthz route that returns ok."));
    expect(await start(id)).toBe("started");
    expect(await children(id)).toEqual([]);
    expect(await task(id)).toMatchObject({ waiting_on: "dev", public_title: "Add a healthz page", github_issue: gh.issues[0]!.number });
    expect(provider.calls[1]!.input).toContain("Add a /healthz route that returns ok");
  });

  it("malformed planner output is retried once, then goes to the owner; approving plans again", async () => {
    const id = await newTask("Add a healthz page");
    replies.planner.push("I would split this into two parts.", '{"subtasks": "one"}');
    expect(await start(id)).toBe("started");
    expect(provider.calls).toHaveLength(2);
    expect(gh.calls).toEqual([]);
    expect(await task(id)).toMatchObject({ status: "waiting", waiting_on: "owner" });
    const [a] = await pendingApprovals(id);
    expect(a!.kind).toBe("critical_pr");
    expect(a!.reasons).toEqual([
      "Task failed: The planner model returned invalid output twice (subtasks is not an array).",
      "Approve to plan the task again; reject to mark the task failed.",
    ]);
    expect(await sql("SELECT 1 AS one FROM inbox_items WHERE ref_id = $1", [a!.id])).toEqual([{ one: 1 }]);

    replies.planner.push('{"subtasks": ["Add a /healthz route"]}');
    replies.public_title.push(plan("Add a healthz page", "Add a /healthz route."));
    expect(await decide(id, a!.id, "approved")).toBe("applied");
    expect(gh.issues).toHaveLength(1);
    expect(await task(id)).toMatchObject({ waiting_on: "dev" });
  });

  it("malformed public-title output twice: owner; rejecting fails the task", async () => {
    const id = await newTask("Add a healthz page");
    replies.planner.push('{"subtasks": ["Add a /healthz route"]}');
    replies.public_title.push('{"title": 42}', '{"title": "Add a page"}');
    await start(id);
    const [a] = await pendingApprovals(id);
    expect(a!.reasons[0]).toBe("Task failed: The public-title model returned invalid output twice (body is not a string).");
    expect(await decide(id, a!.id, "rejected")).toBe("applied");
    expect(await task(id)).toMatchObject({ status: "failed" });
    expect(gh.calls).toEqual([]);
  });

  it("a title containing a contact name becomes Private task (issue and feed)", async () => {
    const id = await newTask("Build a page for Jane");
    replies.planner.push('{"subtasks": ["Build a landing page"]}');
    replies.public_title.push(plan("Build Jane Doe's landing page", "Add a landing page with a hero section."));
    expect(await start(id)).toBe("started");
    expect(gh.issues[0]!.title).toBe("Private task");
    expect((await task(id)).public_title).toBeNull();
    expect(await sql("SELECT title FROM v_public_agent_events WHERE task_no = $1", [id])).toEqual([{ title: "Private task" }]);
    expect(devDispatches()).toHaveLength(1);
  });

  it("an issue body failing checkText waits for an issue_text approval; nothing reaches GitHub", async () => {
    const id = await newTask("Add a contact form that mails me");
    replies.planner.push('{"subtasks": ["Add a contact form"]}');
    replies.public_title.push(plan("Add a contact form", "Add a form.\nSend submissions to owner@example.com"));
    expect(await start(id)).toBe("started");
    expect(gh.calls).toEqual([]);
    expect(await task(id)).toMatchObject({ status: "waiting", waiting_on: "owner", public_title: "Add a contact form" });
    const approvals = await pendingApprovals(id);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.kind).toBe("issue_text");
    expect(approvals[0]!.reasons[0]).toContain("(email, url)");
  });

  it("a split parent does not hold an in-flight slot: four children start beside another task", async () => {
    const other = await newTask("Something else");
    replies.planner.push('{"subtasks": ["Other work"]}');
    replies.public_title.push(plan("Other work", "Do the other work."));
    await start(other);

    const id = await newTask("Four things");
    replies.planner.push('{"subtasks": ["One", "Two", "Three", "Four"]}');
    replies.public_title.push(...["One", "Two", "Three", "Four"].map((t) => plan(`Do ${t.toLowerCase()}`, `Do ${t.toLowerCase()}.`)));
    expect(await start(id)).toBe("started");
    const kids = await children(id);
    // other + 3 children fill the four slots; the fourth child waits in the queue.
    expect(kids.map((k) => k.status)).toEqual(["waiting", "waiting", "waiting", "queued"]);

    await sql("UPDATE tasks SET status = 'merged' WHERE id = $1", [other]);
    const last = Number(kids[3]!.id);
    expect(await sweep(last)).toBe("applied");
    expect(await task(last)).toMatchObject({ status: "waiting", waiting_on: "dev" });
  });
});
