// Shared harness of the AR5b tests (attempts.test.ts, replan.test.ts): the task graph on fakes. GitHub
// is FakeGitHubClient, the planner a fake that records its requests, Postgres is PGlite (all
// migrations) served as orch_rw; messages go through the SQS handler. Call `harness()` inside a describe.
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { contractHash } from "@kcw/core/contract";
import type { MergeInput } from "@kcw/core/merge-input";
import { fromPglite, migrate } from "@kcw/db";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import { FakeGitHubClient } from "../src/github";
import { PgTaskStore, buildTaskGraph, handleTaskSqsEvent, type Plan, type PlanRequest, type TaskData, type TaskGraph, type TaskGraphDeps } from "../src/graph";
import { checkpointerFromPool, setupCheckpointer, threadConfig } from "../src/index";
import { servePglite, type PgSocketServer } from "./pg-socket";

export const sha = (s: string) => createHash("sha1").update(s).digest("hex");
export const PLAN: Plan = { title: "Add a healthz page", body: "Add a /healthz route that returns ok.", acceptance: ["It works."], scope: [], context: [] };
const SENDER = { id: 1, login: "kcw-orchestrator[bot]", type: "Bot" };
const clean = (pr: number, head: string): MergeInput => ({
  pr,
  headSha: head,
  planSummary: { format: 1, infra: [], artifact: { count: 1, kinds: { create: 0, update: 1, delete: 0, replace: 0 } } },
  lockDiff: { added: [], existing: [] },
  uncoveredPaths: [],
});

export function harness() {
  const h = {
    db: undefined as unknown as PGlite,
    graph: undefined as unknown as TaskGraph,
    gh: new FakeGitHubClient(),
    clock: new Date("2026-11-17T10:00:00Z"),
    /** What the fake public-title node answers (a replan answers with `replanPlan` when set). */
    plan: PLAN as Plan,
    replanPlan: null as Plan | null,
    planRequests: [] as PlanRequest[],
    seq: 0,
    runSeq: 9000,
  };
  let srv: PgSocketServer;
  let pool: pg.Pool;
  const deps: TaskGraphDeps = {
    github: h.gh,
    store: undefined as unknown as PgTaskStore,
    planner: {
      split: async (r) => [r.owner_text],
      plan: async (r) => {
        h.planRequests.push(r);
        return r.previous !== undefined && h.replanPlan !== null ? h.replanPlan : h.plan;
      },
    },
    now: () => h.clock,
  };

  const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => {
    await h.db.query("RESET ROLE");
    try {
      return (await h.db.query<T>(text, params)).rows;
    } finally {
      await h.db.query("SET ROLE orch_rw");
    }
  };

  beforeAll(async () => {
    h.db = await PGlite.create();
    await migrate(fromPglite(h.db));
    srv = await servePglite(h.db, { role: "orch_rw" });
    pool = new pg.Pool({ connectionString: srv.url, max: 1 });
    await setupCheckpointer(pool);
    deps.store = new PgTaskStore(pool);
    h.graph = buildTaskGraph(checkpointerFromPool(pool), deps);
  }, 60_000);
  afterAll(async () => {
    await pool.end().catch(() => undefined);
    await srv.close();
    await h.db.close();
  });
  beforeEach(async () => {
    h.gh = new FakeGitHubClient();
    deps.github = h.gh;
    h.clock = new Date("2026-11-17T10:00:00Z");
    h.gh.now = () => h.clock;
    h.plan = PLAN;
    h.replanPlan = null;
    h.planRequests = [];
    await sql("UPDATE tasks SET status = 'done' WHERE status IN ('planning', 'in_progress', 'waiting')");
  });

  async function send(taskId: number, body: unknown, messageId = `m${++h.seq}`): Promise<string> {
    const lines: string[] = [];
    const res = await handleTaskSqsEvent(
      { Records: [{ messageId, body: JSON.stringify(body), attributes: { MessageGroupId: `task-${taskId}` } }] },
      { graph: h.graph, log: (l) => lines.push(l) },
    );
    if (res.batchItemFailures.length > 0) return "failed";
    const last = lines.at(-1)!;
    return last.slice(last.indexOf(": ") + 2);
  }

  const github = (taskId: number, payload: Record<string, unknown>, headSha: string | null) => ({
    source: "github",
    delivery_id: `d-${++h.seq}`,
    task_id: taskId,
    thread_id: `task-${taskId}`,
    resume: { event: `${payload.type}.${payload.action}`, head_sha: headSha, payload: { ...payload, sender: SENDER } },
  });
  const prEvent = (taskId: number, action: string, pr: number, head: string) =>
    github(taskId, { type: "pull_request", action, pr_number: pr, merged: false, draft: false, head_ref: `kcw/task-${taskId}`, head_sha: head, base_ref: "main" }, head);
  const ciEvent = (taskId: number, pr: number, head: string, conclusion: string) =>
    github(
      taskId,
      {
        type: "workflow_run", action: "completed", run_id: ++h.seq, run_attempt: 1, workflow_path: ".github/workflows/ci.yml", workflow_name: "ci",
        status: "completed", conclusion, trigger: "pull_request", head_branch: `kcw/task-${taskId}`, head_sha: head, pr_numbers: [pr],
        run_started_at: null, updated_at: null,
      },
      head,
    );
  const reviewEvent = (taskId: number, pr: number, head: string, state: string) =>
    github(taskId, { type: "pull_request_review", action: "submitted", pr_number: pr, review_state: state, commit_id: head }, head);
  const sweep = (taskId: number) => ({ type: "sweep", task_id: taskId, thread_id: `task-${taskId}` });

  /** An agent report with its identity; `job` start or end, `op` the dispatch op, `contract` the hash it ran under. */
  const report = (taskId: number, fields: Record<string, unknown>) => ({
    task_id: taskId, agent: "developer", run_id: ++h.runSeq, run_attempt: 1, job: "end", op: 0, ...fields,
  });

  async function newTask(): Promise<number> {
    const [row] = await sql<{ id: string }>("INSERT INTO tasks (source, owner_text, is_private) VALUES ('console', 'Add a healthz page please', true) RETURNING id");
    const id = Number(row!.id);
    await sql("UPDATE tasks SET thread_id = 'task-' || id WHERE id = $1", [id]);
    return id;
  }
  const start = (taskId: number) => send(taskId, { type: "task.created", task_id: taskId });
  function openPr(taskId: number, pr: number, head: string) {
    h.gh.prs.set(pr, { headSha: head, author: "kcw-developer[bot]", files: [{ path: "apps/web/src/app/healthz/route.ts", status: "added" }] });
    h.gh.artifacts.set(head, clean(pr, head));
    return send(taskId, prEvent(taskId, "opened", pr, head));
  }
  function push(taskId: number, pr: number, head: string) {
    h.gh.prs.get(pr)!.headSha = head;
    h.gh.artifacts.set(head, clean(pr, head));
    return send(taskId, prEvent(taskId, "synchronize", pr, head));
  }
  async function pendingApproval(taskId: number) {
    const rows = await sql<{ id: string; kind: string; reasons: string[] }>("SELECT id, kind, reasons FROM approvals WHERE task_id = $1 AND status = 'pending'", [taskId]);
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }
  async function decide(taskId: number, approvalId: string, d: "approved" | "rejected") {
    await sql("UPDATE approvals SET status = $2, decided_at = now() WHERE id = $1", [approvalId, d]);
    return send(taskId, { type: "owner.decision", task_id: taskId, thread_id: `task-${taskId}`, resume: { approval_id: approvalId, decision: d } });
  }
  const state = async (taskId: number): Promise<TaskData> => (await h.graph.getState(threadConfig(taskId))).values.task;
  const hashOf = async (taskId: number) => contractHash((await state(taskId)).contract!);
  const task = async (taskId: number) =>
    (await sql<{ status: string; waiting_on: string | null; attempts: number; github_issue: number | null; branch: string | null }>(
      "SELECT status, waiting_on, attempts, github_issue, branch FROM tasks WHERE id = $1", [taskId]))[0]!;
  const attempts = (taskId: number) =>
    sql<{ effect_key: string; revision: number | null; role: string; op: number; contract_hash: string | null; base_sha: string | null; run_id: string | null; started: boolean; ended: boolean; outcome: string | null }>(
      `SELECT effect_key, revision, role, op, contract_hash, base_sha, run_id::text, started_at IS NOT NULL AS started, ended_at IS NOT NULL AS ended, outcome
         FROM task_attempts WHERE task_id = $1 ORDER BY op`, [taskId]);
  const evidence = (taskId: number) =>
    sql<{ effect_key: string; revision: number | null; kind: string; head_sha: string; outcome: string; attempt_key: string | null; superseded: boolean }>(
      "SELECT effect_key, revision, kind, head_sha, outcome, attempt_key, superseded_at IS NOT NULL AS superseded FROM task_evidence WHERE task_id = $1 ORDER BY created_at, effect_key", [taskId]);
  const revisions = (taskId: number) =>
    sql<{ revision: number; contract_hash: string; superseded: boolean }>(
      "SELECT revision, contract_hash, superseded_at IS NOT NULL AS superseded FROM task_revisions WHERE task_id = $1 ORDER BY revision", [taskId]);
  const usageRows = (taskId: number) => sql<{ dedupe_key: string }>("SELECT dedupe_key FROM usage_events WHERE task_id = $1 ORDER BY dedupe_key", [taskId]);
  const dispatches = (workflow: string) => h.gh.dispatches.filter((x) => x.workflow === workflow);

  return {
    h, deps, sql, send, github, prEvent, ciEvent, reviewEvent, sweep, report, newTask, start, openPr, push, pendingApproval, decide, state, hashOf, task,
    attempts, evidence, revisions, usageRows, dispatches,
    dev: () => dispatches("agent-developer.yml"),
    qa: () => dispatches("agent-qa.yml"),
    /** Start report of the QA attempt of dispatch `op`, under the current contract (what the worker's start job sends). */
    startQa: async (taskId: number, op: number, contract?: string) => send(taskId, report(taskId, { agent: "qa", job: "start", op, event_type: "qa_reviewing", contract: contract ?? (await hashOf(taskId)) })),
  };
}
