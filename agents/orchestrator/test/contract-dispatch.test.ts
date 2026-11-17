// AR5a planner slice: the repository brief, the contract and the dispatch input in the task graph.
// Postgres is PGlite served over the wire protocol and used as orch_rw; GitHub is FakeGitHubClient;
// the model is ModelPlanner on FakeProvider (every call counted).
import { PGlite } from "@electric-sql/pglite";
import { canonicalContract, contractHash, parseContract } from "@kcw/core/contract";
import { FakeProvider } from "@kcw/core/models";
import { fromPglite, migrate } from "@kcw/db";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkpointerFromPool, setupCheckpointer, threadConfig } from "../src/index";
import { FakeGitHubClient } from "../src/github";
import { MAX_ATTEMPTS, PgTaskStore, buildTaskGraph, handleTaskSqsEvent, initialTaskData, runStep, type TaskGraph, type TaskGraphDeps } from "../src/graph";
import { ModelPlanner, PLANNER_SYSTEM } from "../src/nodes";
import { MAX_REPO_BRIEF_BYTES } from "../src/nodes/repo-brief";
import { MAX_PLANNER_INPUT_BYTES } from "../src/nodes/planner";
import { servePglite, type PgSocketServer } from "./pg-socket";

const MARKER = "ZZPRIVATEMARKERZZ"; // synthetic private text
const BRIEF_PATH = "docs/agents/INSTRUCTIONS.md";

describe("planner contract and repository brief (AR5a)", () => {
  let db: PGlite;
  let srv: PgSocketServer;
  let pool: pg.Pool;
  let graph: TaskGraph;
  let gh: FakeGitHubClient;
  let provider: FakeProvider;
  let replies: { planner: string[]; public_title: string[] };
  let seq = 0;

  const deps: TaskGraphDeps = {
    github: new FakeGitHubClient(),
    store: undefined as unknown as PgTaskStore,
    planner: undefined as unknown as ModelPlanner,
    now: () => new Date("2026-11-16T10:00:00Z"),
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
        const next = (req.system === PLANNER_SYSTEM ? replies.planner : replies.public_title).shift();
        return next === undefined ? new Error("unexpected model call") : { text: next };
      },
    });
    deps.planner = new ModelPlanner({ provider });
    await sql("UPDATE tasks SET status = 'done' WHERE status IN ('planning', 'in_progress', 'waiting')");
    await sql("UPDATE orchestrator_outbox SET sent_at = now() WHERE sent_at IS NULL");
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
  const start = (id: number, messageId?: string) => send(id, { type: "task.created", task_id: id }, messageId);

  async function newTask(ownerText: string): Promise<number> {
    const [row] = await sql<{ id: string }>("INSERT INTO tasks (source, owner_text, is_private) VALUES ('console', $1, false) RETURNING id", [ownerText]);
    const id = Number(row!.id);
    await sql("UPDATE tasks SET thread_id = 'task-' || id WHERE id = $1", [id]);
    return id;
  }

  const task = async (id: number) => (await sql<{ status: string; waiting_on: string | null }>("SELECT status, waiting_on FROM tasks WHERE id = $1", [id]))[0]!;
  const pending = (id: number) =>
    sql<{ id: string; kind: string; reasons: string[] }>("SELECT id, kind, reasons FROM approvals WHERE task_id = $1 AND status = 'pending'", [id]);

  async function decide(id: number, approvalId: string, d: "approved" | "rejected") {
    await sql("UPDATE approvals SET status = $2, decided_at = now() WHERE id = $1", [approvalId, d]);
    return send(id, { type: "owner.decision", task_id: id, thread_id: `task-${id}`, resume: { approval_id: approvalId, decision: d } });
  }

  const devDispatches = () => gh.dispatches.filter((x) => x.workflow === "agent-developer.yml");
  const reply = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ title: "Add a healthz page", body: "Add a /healthz route that returns ok.", acceptance: ["GET /healthz answers ok"], scope: ["apps/web/src"], context: ["agents/orchestrator/src/graph/machine.ts"], ...over });
  const one = () => replies.planner.push('{"subtasks": ["Add a /healthz route"]}');
  const modelWrites = () => gh.calls.filter((c) => c.method === "createIssue" || c.method === "dispatchWorkflow");

  // ------------------------------------------------------------------ repository brief

  it("the planner prompt holds the brief from the base revision and stays within the input bound", async () => {
    const id = await newTask("Add a healthz page");
    one();
    replies.public_title.push(reply());
    expect(await start(id)).toBe("started");
    expect(provider.calls).toHaveLength(2);
    for (const c of provider.calls) {
      const input = { prompt: c.input };
      expect(input.prompt).toContain("<repository>\n## Layout");
      expect(input.prompt).toContain("agents/orchestrator/  the task graph");
      expect(input.prompt).not.toContain("## Rules"); // only the Layout section
      expect(input.prompt.indexOf("<repository>")).toBeLessThan(input.prompt.indexOf("<task>"));
      expect(Buffer.byteLength(PLANNER_SYSTEM) + Buffer.byteLength(input.prompt)).toBeLessThanOrEqual(MAX_PLANNER_INPUT_BYTES);
    }
    expect(gh.calls.filter((c) => c.method === "getBranchHead")).toEqual([{ method: "getBranchHead", args: "main" }]);
    expect(gh.calls.filter((c) => c.method === "readFile")).toEqual([{ method: "readFile", args: { path: BRIEF_PATH, ref: gh.heads.get("main") } }]);
  });

  it.each([
    ["is missing", (g: FakeGitHubClient) => g.files.delete(BRIEF_PATH)],
    ["has no Layout section", (g: FakeGitHubClient) => g.files.set(BRIEF_PATH, "# Instructions\n\n## Rules\n\nx\n")],
    ["has an oversized Layout section", (g: FakeGitHubClient) => g.files.set(BRIEF_PATH, `## Layout\n\n${"x".repeat(MAX_REPO_BRIEF_BYTES)}\n`)],
  ])("a brief that %s goes to the owner; no model call, nothing on GitHub", async (_name, change) => {
    change(gh);
    const id = await newTask("Add a healthz page");
    expect(await start(id)).toBe("started");
    expect(provider.calls).toHaveLength(0);
    expect(modelWrites()).toEqual([]);
    expect(await task(id)).toMatchObject({ status: "waiting", waiting_on: "owner" });
    expect((await pending(id))[0]!.reasons[0]).toBe("Task failed: the repository brief is missing or too large; approve to plan it again");
  });

  it("a prompt over the input bound goes to the owner; no model call", async () => {
    const id = await newTask("x".repeat(MAX_PLANNER_INPUT_BYTES));
    expect(await start(id)).toBe("started");
    expect(provider.calls).toHaveLength(0);
    expect(modelWrites()).toEqual([]);
    expect((await pending(id))[0]!.reasons[0]).toBe("Task failed: The planner input is larger than the size limit; nothing was sent to the model.");
  });

  it("a re-run of planning after a crash reuses the stored base, brief and plan", async () => {
    const id = await newTask("Add a healthz page");
    one();
    replies.public_title.push(reply());
    gh.failNext("createIssue", 500); // the step fails after the plan was recorded
    expect(await start(id, "crash-1")).toBe("failed");
    expect(provider.calls).toHaveLength(2);
    expect(await start(id, "crash-1")).toBe("recovered");
    expect(provider.calls).toHaveLength(2);
    expect(gh.calls.filter((c) => c.method === "getBranchHead")).toHaveLength(1);
    expect(gh.calls.filter((c) => c.method === "readFile")).toHaveLength(1);
    expect(devDispatches()).toHaveLength(1);
  });

  // ------------------------------------------------------------------ the contract and the dispatch input

  it("the dispatch carries the canonical contract (parseContract accepts it) and no private owner text", async () => {
    const id = await newTask(`Add a healthz page ${MARKER}`);
    one();
    replies.public_title.push(reply());
    expect(await start(id)).toBe("started");
    const [dispatch] = devDispatches();
    const contract = parseContract(dispatch!.inputs.contract);
    expect(contract).toMatchObject({
      v: 1,
      task: id,
      revision: 1,
      issue: gh.issues[0]!.number,
      goal: "Add a /healthz route that returns ok.",
      acceptance: ["GET /healthz answers ok"],
      scope: ["apps/web/src"],
      context: ["agents/orchestrator/src/graph/machine.ts"],
      base: gh.heads.get("main"),
      prerequisites: [],
    });
    const state = (await graph.getState(threadConfig(id))).values.task as { contract: unknown };
    expect(canonicalContract(state.contract as never)).toBe(dispatch!.inputs.contract);
    expect(contractHash(contract)).toMatch(/^[a-f0-9]{64}$/);
    // The marker is in the owner's task text (and so in the model prompt) and nowhere public.
    expect(JSON.stringify(provider.calls)).toContain(MARKER);
    expect(JSON.stringify(gh.dispatches)).not.toContain(MARKER);
    expect(JSON.stringify(gh.issues)).not.toContain(MARKER);
    expect(dispatch!.inputs.contract).not.toContain(MARKER);
  });

  it("an acceptance item failing the sanitizer waits for issue_text and dispatches nothing; approving dispatches the contract as written", async () => {
    const id = await newTask("Add a contact link");
    one();
    replies.public_title.push(reply({ acceptance: ["Email the result to owner@example.com"] }));
    expect(await start(id)).toBe("started");
    expect(modelWrites()).toEqual([]);
    expect(await task(id)).toMatchObject({ status: "waiting", waiting_on: "owner" });
    const [approval] = await pending(id);
    expect(approval!.kind).toBe("issue_text");
    expect(approval!.reasons[0]).toContain("(email");
    expect(approval!.reasons.join("\n")).toContain("Proposed acceptance: Email the result to owner@example.com");
    expect(approval!.reasons.join("\n")).toContain("Proposed scope: apps/web/src");
    expect(approval!.reasons.join("\n")).toContain("Proposed context: agents/orchestrator/src/graph/machine.ts");

    expect(await decide(id, approval!.id, "approved")).toBe("applied");
    const [dispatch] = devDispatches();
    expect(parseContract(dispatch!.inputs.contract).acceptance).toEqual(["Email the result to owner@example.com"]);
    expect(parseContract(dispatch!.inputs.contract).issue).toBe(gh.issues[0]!.number);
  });

  it("a rejected issue_text approval cancels the task and dispatches nothing", async () => {
    const id = await newTask("Add a contact link");
    one();
    replies.public_title.push(reply({ acceptance: ["Email the result to owner@example.com"] }));
    await start(id);
    const [approval] = await pending(id);
    expect(await decide(id, approval!.id, "rejected")).toBe("applied");
    expect(modelWrites()).toEqual([]);
    expect(await task(id)).toMatchObject({ status: "cancelled" });
  });

  it("a source path passes (the url code is ignored); a path with a contact name fails", async () => {
    const ok = await newTask("Touch the machine");
    one();
    replies.public_title.push(reply({ scope: ["agents/orchestrator/src/graph/machine.ts"], context: ["docs/DESIGN.md"] }));
    expect(await start(ok)).toBe("started");
    expect(parseContract(devDispatches()[0]!.inputs.contract).scope).toEqual(["agents/orchestrator/src/graph/machine.ts"]);

    const bad = await newTask("Touch the notes");
    one();
    replies.public_title.push(reply({ context: ["docs/janie-notes.md"] }));
    expect(await start(bad)).toBe("started");
    expect(devDispatches()).toHaveLength(1);
    const [approval] = await pending(bad);
    expect(approval!.kind).toBe("issue_text");
    expect(approval!.reasons[0]).toContain("(contact)");
  });

  it("a plan whose body cannot be a valid contract goes to the owner and publishes nothing", async () => {
    const id = await newTask("Add a page");
    one();
    replies.public_title.push(reply({ body: "Café page" })); // non-ASCII: the worker would refuse this contract
    expect(await start(id)).toBe("started");
    expect(modelWrites()).toEqual([]);
    expect((await pending(id))[0]!.reasons[0]).toBe("Task failed: the proposed task contract is not valid (characters or size); approve to plan it again");
  });

  // Planned before contracts existed: the issue (and for QA the PR) belong to that plan, so the task is not planned again.
  it.each([
    ["dev", { phase: "dev" as const }],
    ["qa", { phase: "qa" as const, pr_number: 9, head_sha: "a".repeat(40) }],
  ])("a work task without a contract fails at its %s dispatch; nothing is dispatched and no approval is asked", async (waitingOn, extra) => {
    const id = await newTask("Planned before contracts existed");
    await sql("UPDATE tasks SET status = 'waiting', waiting_on = $2 WHERE id = $1", [id, waitingOn]);
    const data = { ...initialTaskData(), ...extra, waiting_since: "2026-11-15T00:00:00.000Z", issue_number: 5 };
    const next = await runStep(id, data, { kind: "sweep", message_id: `sweep-${waitingOn}` }, deps);
    expect(gh.dispatches).toEqual([]);
    expect(next).toMatchObject({ phase: "done" });
    expect((await task(id)).status).toBe("failed");
    expect(await pending(id)).toEqual([]);
  });

  it("a task without a contract whose attempts run out keeps the Developer retry; approving fails it, nothing is planned onto its PR", async () => {
    const id = await newTask("Planned before contracts existed");
    const head = "c".repeat(40);
    await sql("UPDATE tasks SET status = 'waiting', waiting_on = 'ci' WHERE id = $1", [id]);
    const data = { ...initialTaskData(), phase: "ci" as const, pr_number: 9, head_sha: head, attempts: MAX_ATTEMPTS - 1, issue_number: 5, waiting_since: "2026-11-15T00:00:00.000Z" };
    const ciFailure = {
      kind: "github" as const, event: "workflow_run" as const, action: "completed", run_id: 77, run_attempt: 1, head_branch: `kcw/task-${id}`,
      run_started_at: null, updated_at: null, workflow_path: ".github/workflows/ci.yml", conclusion: "failure", trigger: "pull_request", head_sha: head, pr_numbers: [9],
      message_id: "ci-77",
    };
    const owner = await runStep(id, data, ciFailure, deps);
    expect(owner).toMatchObject({ phase: "owner", owner_wait: "failure", retry: "dev" });
    const [a] = await pending(id);
    expect(a!.reasons[1]).toBe(`Approve to give the Developer ${MAX_ATTEMPTS} more attempts; reject to mark the task failed.`);
    await sql("UPDATE approvals SET status = 'approved', decided_at = now() WHERE id = $1", [a!.id]);
    const after = await runStep(id, owner, { kind: "decision", approval_id: a!.id, decision: "approved", message_id: "d-1" }, deps);
    expect(after).toMatchObject({ phase: "done" });
    expect(gh.dispatches).toEqual([]);
    expect(provider.calls).toHaveLength(0);
    expect((await task(id)).status).toBe("failed");
  });
});
