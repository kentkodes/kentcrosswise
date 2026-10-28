// The orchestrator Lambda handler end to end: createHandler's cold start (secrets, pool,
// checkpointer, task store, GitHub client, planner) and the task graph behind it. Postgres is
// PGlite with every migration applied, served over the wire protocol so the production path
// (node-postgres Pool -> PostgresSaver / PgTaskStore) runs unchanged, as orch_rw. GitHub is
// FakeGitHubClient; the model is FakeProvider, or the real AnthropicProvider against a local fake
// of the Messages API.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { FakeProvider, type CompleteRequest, type UsageCallback } from "@kcw/core/models";
import { fromPglite, migrate } from "@kcw/db";
import { createFakeSecrets } from "@kcw/secrets";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CheckpointSchemaMissingError, checkpointerFromPool, createHandler, setupCheckpointer, type SqsRecord } from "../src/index";
import { FakeGitHubClient } from "../src/github";
import { PLANNER_SYSTEM } from "../src/nodes";
import { servePglite, type PgSocketServer } from "./pg-socket";

const ORCH = "kcw/prod/orchestrator";
const MODELS = "kcw/prod/models";
const HEAD = "a".repeat(40);

const msg = (id: string, body: unknown, taskId: number): SqsRecord => ({
  messageId: id,
  body: JSON.stringify(body),
  attributes: { MessageGroupId: `task-${taskId}` },
});
const created = (id: string, taskId: number) => msg(id, { type: "task.created", task_id: taskId }, taskId);

const plan = (title: string, body: string) => JSON.stringify({ title, body });
const oneSubtask = (text: string) => JSON.stringify({ subtasks: [text] });

describe("orchestrator Lambda on Postgres", () => {
  let db: PGlite;
  let srv: PgSocketServer;
  const pools: pg.Pool[] = [];
  /** Scripted model replies, per node, consumed in order (shared by every "process"). */
  let replies: { planner: string[]; public_title: string[] };

  const poolAsOrchRw = (url: string): pg.Pool => {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    pools.push(pool);
    return pool;
  };

  const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => {
    await db.query("RESET ROLE");
    try {
      return (await db.query<T>(text, params)).rows;
    } finally {
      await db.query("SET ROLE orch_rw");
    }
  };

  const fakeProvider = (onUsage: UsageCallback) =>
    new FakeProvider({
      name: "anthropic",
      model: "claude-haiku-5-5",
      onUsage,
      complete: (req: CompleteRequest) => {
        const next = (req.system === PLANNER_SYSTEM ? replies.planner : replies.public_title).shift();
        return next === undefined ? new Error("unexpected model call") : { text: next };
      },
    });

  interface ProcessOptions {
    vars?: Record<string, string>;
    secrets?: Record<string, Record<string, string>>;
    github?: FakeGitHubClient | "default";
    provider?: "fake" | "default";
  }

  /** A new "process": its own handler, pool, checkpointer and graph. */
  const newProcess = (opts: ProcessOptions = {}) => {
    const lines: string[] = [];
    const env: Record<string, string | undefined> = { KCW_ORCHESTRATOR_SECRET: ORCH, KCW_MODELS_SECRET: MODELS, ...opts.vars };
    const { store, aws } = createFakeSecrets({
      [ORCH]: { db_url: srv.url },
      [MODELS]: { anthropic_api_key: "sk-test-key" },
      ...opts.secrets,
    });
    const gh = opts.github === "default" ? undefined : (opts.github ?? new FakeGitHubClient());
    const handler = createHandler({
      env,
      secrets: store,
      makePool: poolAsOrchRw,
      ...(gh && { makeGitHub: async () => gh }),
      ...(opts.provider !== "default" && { makeProvider: ({ onUsage }) => fakeProvider(onUsage) }),
      log: (l) => lines.push(l),
    });
    return { handler, lines, env, aws, gh };
  };

  async function newTask(ownerText: string): Promise<number> {
    const [row] = await sql<{ id: string }>(
      "INSERT INTO tasks (source, owner_text, is_private) VALUES ('console', $1, true) RETURNING id",
      [ownerText],
    );
    const id = Number(row!.id);
    await sql("UPDATE tasks SET thread_id = 'task-' || id WHERE id = $1", [id]);
    return id;
  }

  const taskRow = async (id: number) =>
    (
      await sql<{ status: string; waiting_on: string | null; public_title: string | null; github_issue: number | null; pr_number: number | null }>(
        "SELECT status, waiting_on, public_title, github_issue, pr_number FROM tasks WHERE id = $1",
        [id],
      )
    )[0]!;

  const usageRows = (ids: number[]) =>
    sql<{ task_id: number; kind: string; agent: string; provider: string; model: string; input_tokens: number; output_tokens: number; cost_usd: string | null }>(
      `SELECT task_id::int AS task_id, kind, agent, provider, model, input_tokens, output_tokens, cost_usd
       FROM usage_events WHERE task_id = ANY($1::bigint[]) ORDER BY ts, task_id`,
      [ids],
    );

  beforeAll(async () => {
    db = await PGlite.create();
    await migrate(fromPglite(db));
    srv = await servePglite(db, { role: "orch_rw" });
  }, 60_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
    await srv.close();
    await db.close();
  });

  beforeEach(async () => {
    replies = { planner: [], public_title: [] };
    // D20: keep the in-flight limit free for each test.
    await sql("UPDATE tasks SET status = 'done' WHERE status IN ('planning', 'in_progress', 'waiting')");
  });

  it("task.created: plans, opens the issue, dispatches the Developer and records the planner's usage", async () => {
    const id = await newTask("Add a /healthz route that returns ok");
    replies.planner.push(oneSubtask("Add a /healthz route that returns ok"));
    replies.public_title.push(plan("Add a healthz page", "Add a /healthz route that returns ok."));

    const a = newProcess();
    expect(await a.handler({ Records: [created("c1", id)] })).toEqual({ batchItemFailures: [] });
    expect(a.lines.at(-1)).toBe("message c1: started");

    const gh = a.gh!;
    expect(gh.issues).toHaveLength(1);
    expect(gh.issues[0]).toMatchObject({ title: "Add a healthz page" });
    expect(gh.issues[0]!.body).toContain(`Task ${id}. Branch: \`kcw/task-${id}\`.`);
    expect(gh.dispatches).toEqual([
      {
        workflow: "agent-developer.yml",
        ref: "main",
        runId: expect.any(Number),
        inputs: { task_id: String(id), issue: String(gh.issues[0]!.number), mode: "implement", pr: "" },
      },
    ]);
    expect(await taskRow(id)).toMatchObject({
      status: "waiting",
      waiting_on: "dev",
      public_title: "Add a healthz page",
      github_issue: gh.issues[0]!.number,
    });

    // One row per model call (planner, then public title), on this task, priced later (Q13(1)).
    const usage = await usageRows([id]);
    expect(usage).toHaveLength(2);
    for (const u of usage) {
      expect(u).toMatchObject({ task_id: id, kind: "model", agent: "orchestrator", provider: "anthropic", model: "claude-haiku-5-5", cost_usd: null });
      expect(u.input_tokens).toBeGreaterThan(0);
      expect(u.output_tokens).toBeGreaterThan(0);
    }

    // The checkpoint is in schema lg, in tables orch_rw created and owns.
    const tables = await sql<{ tablename: string; tableowner: string }>(
      "SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'lg' ORDER BY tablename",
    );
    expect(tables.map((t) => t.tablename)).toEqual(["checkpoint_blobs", "checkpoint_migrations", "checkpoint_writes", "checkpoints"]);
    expect(new Set(tables.map((t) => t.tableowner))).toEqual(new Set(["orch_rw"]));
  });

  it("resumes the thread in a fresh process with every message type the graph accepts", async () => {
    const id = await newTask("Fix the footer link");
    replies.planner.push(oneSubtask("Fix the footer link"));
    replies.public_title.push(plan("Fix the footer link", "The footer link points to the wrong page."));
    const a = newProcess();
    await a.handler({ Records: [created("r1", id)] });
    expect(a.lines.at(-1)).toBe("message r1: started");

    // Process B: a new pool, checkpointer and graph instance.
    const b = newProcess();
    const thread = `task-${id}`;
    const out = await b.handler({
      Records: [
        created("r2", id), // a second task.created
        msg("r3", { task_id: id, agent: "developer", event_type: "coding" }, id), // kcw-report
        msg("r4", { type: "sweep", task_id: id, thread_id: thread }, id), // within the dev limit
        msg(
          "r5",
          {
            source: "github",
            delivery_id: "d-1",
            task_id: id,
            thread_id: thread,
            resume: {
              event: "pull_request",
              head_sha: HEAD,
              payload: { type: "pull_request", action: "opened", pr_number: 42, head_ref: `kcw/task-${id}`, head_sha: HEAD, merged: false },
            },
          },
          id,
        ),
        msg(
          "r6",
          {
            type: "owner.decision",
            task_id: id,
            thread_id: thread,
            resume: { approval_id: "00000000-0000-4000-8000-000000000000", decision: "approved" },
          },
          id,
        ), // no such approval
      ],
    });
    expect(out).toEqual({ batchItemFailures: [] });
    expect(b.lines.filter((l) => l.startsWith("message "))).toEqual([
      "message r2: duplicate_start",
      "message r3: applied",
      "message r4: unchanged",
      "message r5: applied",
      "message r6: stale",
    ]);
    expect(await taskRow(id)).toMatchObject({ waiting_on: "ci", pr_number: 42 });
    expect(b.gh!.calls).toEqual([]); // nothing re-planned or re-dispatched
  });

  it("attributes usage to each task when the planner splits a task (children start in the same invocation)", async () => {
    const id = await newTask("Add a healthz page and a status badge");
    replies.planner.push(JSON.stringify({ subtasks: ["Add a /healthz route", "Add a status badge to the footer"] }));
    replies.public_title.push(plan("Add a healthz page", "Add a /healthz route."), plan("Add a status badge", "Show a badge."));

    const p = newProcess();
    expect(await p.handler({ Records: [created("s1", id)] })).toEqual({ batchItemFailures: [] });
    const kids = (await sql<{ id: string }>("SELECT id FROM tasks WHERE parent_id = $1 ORDER BY id", [id])).map((r) => Number(r.id));
    expect(kids).toHaveLength(2);
    expect(p.gh!.issues.map((i) => i.title)).toEqual(["Add a healthz page", "Add a status badge"]);
    expect(p.gh!.dispatches.map((d) => d.inputs.task_id)).toEqual(kids.map(String));

    const usage = await usageRows([id, ...kids]);
    expect(usage.map((u) => Number(u.task_id)).sort()).toEqual([id, ...kids].sort());
  });

  it("runs the real AnthropicProvider (key from the models secret) and records its token counts", async () => {
    const requests: { path: string | undefined; auth: string | undefined; body: { model: string; system: string } }[] = [];
    const server: Server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        const body = JSON.parse(raw) as { model: string; system: string };
        requests.push({ path: req.url, auth: req.headers.authorization, body });
        const text =
          body.system === PLANNER_SYSTEM ? oneSubtask("Add a robots.txt") : plan("Add a robots.txt", "Serve a robots.txt file.");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: `msg_${requests.length}`,
            type: "message",
            role: "assistant",
            model: "claude-haiku-5-5-20261001",
            content: [{ type: "text", text }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 100 + requests.length, output_tokens: 20 },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const saved = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const id = await newTask("Add a robots.txt");
      const p = newProcess({ provider: "default" });
      expect(await p.handler({ Records: [created("a1", id)] })).toEqual({ batchItemFailures: [] });
      expect(p.lines.at(-1)).toBe("message a1: started");
      expect(requests.map((r) => [r.path, r.auth, r.body.model])).toEqual([
        ["/v1/messages", "Bearer sk-test-key", "claude-haiku-5-5"],
        ["/v1/messages", "Bearer sk-test-key", "claude-haiku-5-5"],
      ]);
      const usage = await usageRows([id]);
      expect(usage.map((u) => [u.provider, u.model, u.input_tokens, u.output_tokens])).toEqual([
        ["anthropic", "claude-haiku-5-5-20261001", 101, 20],
        ["anthropic", "claude-haiku-5-5-20261001", 102, 20],
      ]);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = saved;
      await new Promise((r) => server.close(r));
    }
  });

  it("a model error fails the step (returned to the queue); the redelivery completes it", async () => {
    const id = await newTask("Add a sitemap");
    const p = newProcess();
    // No scripted replies: the planner's first call fails.
    expect(await p.handler({ Records: [created("e1", id), created("e2", id)] })).toEqual({
      batchItemFailures: [{ itemIdentifier: "e1" }, { itemIdentifier: "e2" }],
    });
    expect(p.lines).toEqual(["message e1: failed (Error)"]);

    replies.planner.push(oneSubtask("Add a sitemap"));
    replies.public_title.push(plan("Add a sitemap", "Serve a sitemap."));
    await p.handler({ Records: [created("e1", id)] });
    expect(p.lines.at(-1)).toBe("message e1: recovered");
    expect(p.gh!.issues).toHaveLength(1);
    expect(await taskRow(id)).toMatchObject({ waiting_on: "dev" });
  });

  it("needs setupCheckpointer: the library's own setup() is refused for orch_rw", async () => {
    // Postgres checks CREATE on the database before IF NOT EXISTS (see setupCheckpointer).
    await expect(checkpointerFromPool(poolAsOrchRw(srv.url)).setup()).rejects.toThrow(/permission denied for database/);
  });

  it("copies the LangSmith key from the models secret when tracing is on", async () => {
    const p = newProcess({
      vars: { LANGSMITH_TRACING: "true" },
      secrets: { [MODELS]: { anthropic_api_key: "sk-test-key", langsmith_api_key: "ls-test-key" } },
    });
    await p.handler({ Records: [] });
    expect(p.env.LANGSMITH_API_KEY).toBe("ls-test-key");
    expect(p.env.LANGSMITH_TRACING).toBe("true");
    expect(p.lines).toEqual([]);
  });

  it.each<[string, Record<string, string>, string]>([
    ["has no LangSmith key", { anthropic_api_key: "sk-test-key" }, "langsmith_api_key missing: tracing off"],
    ["has an empty LangSmith key", { anthropic_api_key: "sk-test-key", langsmith_api_key: " " }, "langsmith_api_key empty: tracing off"],
  ])("turns tracing off when the models secret %s", async (_label, models, line) => {
    const p = newProcess({ vars: { LANGSMITH_TRACING: "true" }, secrets: { [MODELS]: models } });
    expect(await p.handler({ Records: [] })).toEqual({ batchItemFailures: [] });
    expect(p.env.LANGSMITH_API_KEY).toBeUndefined();
    expect(p.env.LANGSMITH_TRACING).toBe("false");
    expect(p.lines).toEqual([line]);
  });

  it("an empty or missing db_url returns the batch to the queue, then recovers once filled", async () => {
    const id = await newTask("Add a favicon");
    const p = newProcess({ secrets: { [ORCH]: { db_url: "" } } });
    const batch = { Records: [created("d1", id), msg("d2", { task_id: id, agent: "developer", event_type: "coding" }, id)] };
    const failed = { batchItemFailures: [{ itemIdentifier: "d1" }, { itemIdentifier: "d2" }] };
    expect(await p.handler(batch)).toEqual(failed);

    p.aws.values.set(ORCH, JSON.stringify({ other: "x" }));
    expect(await p.handler(batch)).toEqual(failed);
    expect(p.lines).toEqual([
      "init failed (ConfigError): 2 message(s) returned to the queue",
      "init failed (SecretKeyMissingError): 2 message(s) returned to the queue",
    ]);

    // The owner fills db_url: the next invocation re-reads the secret (no new process needed).
    p.aws.values.set(ORCH, JSON.stringify({ db_url: srv.url }));
    replies.planner.push(oneSubtask("Add a favicon"));
    replies.public_title.push(plan("Add a favicon", "Serve a favicon."));
    expect(await p.handler({ Records: [batch.Records[0]!] })).toEqual({ batchItemFailures: [] });
    expect(p.lines.at(-1)).toBe("message d1: started");
  });

  it.each<[string, ProcessOptions, string]>([
    ["the Anthropic key is missing", { secrets: { [MODELS]: {} } }, "SecretKeyMissingError"],
    ["the Anthropic key is empty", { secrets: { [MODELS]: { anthropic_api_key: "  " } } }, "ConfigError"],
    ["the App credentials are missing", { github: "default" }, "SecretKeyMissingError"],
    [
      "the App private key is not a PEM key",
      {
        github: "default",
        secrets: {
          [ORCH]: { db_url: "postgres://unused", github_app_client_id: "Iv1.x", github_app_installation_id: "1", github_app_private_key: "nope" },
        },
      },
      "GitHubConfigError",
    ],
  ])("fails the cold start when %s, logging only the error class", async (_label, opts, errorClass) => {
    const p = newProcess(opts);
    expect(await p.handler({ Records: [created("k1", 1)] })).toEqual({ batchItemFailures: [{ itemIdentifier: "k1" }] });
    expect(p.lines).toEqual([`init failed (${errorClass}): 1 message(s) returned to the queue`]);
  });
});

describe("orchestrator cold start without configuration", () => {
  it("returns every record as a failure when the secret has no value, logging only the error class", async () => {
    const { store } = createFakeSecrets({});
    const lines: string[] = [];
    const handler = createHandler({
      env: { KCW_ORCHESTRATOR_SECRET: ORCH, KCW_MODELS_SECRET: MODELS },
      secrets: store,
      log: (l) => lines.push(l),
    });
    expect(await handler({ Records: [created("n1", 1)] })).toEqual({ batchItemFailures: [{ itemIdentifier: "n1" }] });
    expect(lines).toEqual(["init failed (SecretNotFoundError): 1 message(s) returned to the queue"]);
  });

  it.each([
    ["KCW_ORCHESTRATOR_SECRET", { KCW_MODELS_SECRET: MODELS }],
    ["KCW_MODELS_SECRET", { KCW_ORCHESTRATOR_SECRET: ORCH }],
  ])("an unset %s is a ConfigError, not a crash", async (_name, env) => {
    const { store } = createFakeSecrets({});
    const lines: string[] = [];
    const handler = createHandler({ env, secrets: store, log: (l) => lines.push(l) });
    expect(await handler({ Records: [] })).toEqual({ batchItemFailures: [] });
    expect(lines).toEqual(["init failed (ConfigError): 0 message(s) returned to the queue"]);
  });
});

describe("setupCheckpointer without migrations", () => {
  it("fails clearly when schema lg does not exist", async () => {
    const db = await PGlite.create();
    const srv = await servePglite(db);
    const pool = new pg.Pool({ connectionString: srv.url, max: 1 });
    try {
      await expect(setupCheckpointer(pool)).rejects.toThrow(CheckpointSchemaMissingError);
    } finally {
      await pool.end();
      await srv.close();
      await db.close();
    }
  });
});
