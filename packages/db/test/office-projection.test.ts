import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SqlClient } from "../src/index";
import { freshDb } from "./helpers";

// 0006: connected-office projection (docs/office/LIVE-CONTRACT.md unit 2). PGlite has ONE
// session, so two transactions cannot truly interleave here: reversed commits are reproduced as
// sequential commits in the reversed order, and the lock order is checked on the function body
// plus the lock it holds. A real two-connection race is not exercised by this suite.

const RAW_TABLES = [
  "office_projection_state",
  "office_refs",
  "office_tasks",
  "office_executions",
  "office_journal",
  "office_source_deliveries",
  "office_privacy_changes",
];
const VIEWS = ["v_office_events", "v_office_executions", "v_office_invalidations", "v_office_state", "v_office_tasks"];

interface State {
  revision: number;
  privacy_epoch: number;
}

describe("0006 office projection writer", () => {
  let pg: PGlite;
  let db: SqlClient;
  beforeAll(async () => {
    ({ pg, db } = await freshDb());
  });
  afterAll(async () => {
    await pg.close();
  });

  const project = async (key: string, transition: unknown): Promise<number | null> => {
    const { rows } = await db.query<{ r: number | null }>("SELECT office_project($1, $2::jsonb)::int AS r", [
      key,
      JSON.stringify(transition),
    ]);
    return rows[0]!.r;
  };
  const state = async (): Promise<State> =>
    (
      await db.query<State>(
        "SELECT revision::int AS revision, privacy_epoch::int AS privacy_epoch FROM office_projection_state",
      )
    ).rows[0]!;
  const counts = async () =>
    (
      await db.query<Record<string, number>>(
        `SELECT (SELECT count(*)::int FROM office_journal) AS journal, (SELECT count(*)::int FROM office_refs) AS refs,
                (SELECT count(*)::int FROM office_tasks) AS tasks, (SELECT count(*)::int FROM office_source_deliveries) AS deliveries,
                (SELECT count(*)::int FROM office_privacy_changes) AS privacy`,
      )
    ).rows[0]!;
  const events = async () =>
    (
      await db.query<{ revision: number; ordinal: number; description: string; visibility: string; task_ref: string | null }>(
        "SELECT revision::int AS revision, ordinal, description, visibility, task_ref FROM v_office_events ORDER BY revision, ordinal",
      )
    ).rows;

  it("starts at revision 0, epoch 0, with a random UUIDv4 generation and capabilities off", async () => {
    const { rows } = await db.query<Record<string, unknown>>("SELECT * FROM v_office_state");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.generation).toMatch(/^gen_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(rows[0]).toMatchObject({
      watermark_ordinal: 0,
      oldest_revision: null,
      paused: null,
      execution_observations: false,
      deployment_events: false,
      routing_events: false,
    });
    expect(await state()).toEqual({ revision: 0, privacy_epoch: 0 });
  });

  it("allocates one revision per transition and distinct ordinals within it", async () => {
    const rev = await project("t1", {
      tasks: [{ task_id: 1, is_private: false, public_title: "Add a health page", kind: "work", state: "in_progress", role: "developer" }],
      events: [
        { task_id: 1, role: "orchestrator", type: "task_assigned" },
        { task_id: 1, role: "developer", type: "coding" },
        { task_id: null, role: "orchestrator", type: "coding" },
      ],
    });
    expect(rev).toBe(1);
    expect((await events()).map((e) => [e.revision, e.ordinal, e.description])).toEqual([
      [1, 0, "Add a health page"],
      [1, 1, "Add a health page"],
      [1, 2, "Private task"],
    ]);
    expect(await project("t2", { events: [{ task_id: 1, role: "developer", type: "pr_opened" }] })).toBe(2);
    const { rows } = await db.query<{ watermark_ordinal: number; oldest_revision: number }>(
      "SELECT watermark_ordinal, oldest_revision::int AS oldest_revision FROM v_office_state",
    );
    expect(rows[0]).toEqual({ watermark_ordinal: 0, oldest_revision: 1 });
  });

  it("projects a repeated source delivery once", async () => {
    const before = await counts();
    expect(await project("t2", { events: [{ task_id: 1, role: "developer", type: "pr_opened" }] })).toBeNull();
    expect(await counts()).toEqual(before);
    expect(await state()).toEqual({ revision: 2, privacy_epoch: 0 });
  });

  it("leaves no revision, reference, journal or dedupe residue after a rollback", async () => {
    const before = await counts();
    await db.exec("BEGIN");
    expect(
      await project("rolled-back", {
        tasks: [{ task_id: 77, is_private: false, public_title: "Never committed" }],
        events: [{ task_id: 77, role: "developer", type: "coding" }],
      }),
    ).toBe(3);
    await db.exec("ROLLBACK");
    expect(await counts()).toEqual(before);
    expect(await state()).toEqual({ revision: 2, privacy_epoch: 0 });
    // A failing transition rolls back as a whole too (the caller's transaction aborts).
    await expect(
      project("fails", {
        tasks: [{ task_id: 78, is_private: false, public_title: "Half written" }],
        events: [{ task_id: 999, role: "developer", type: "coding" }],
      }),
    ).rejects.toThrow(/event task is not projected/);
    expect(await counts()).toEqual(before);
    // The next transition takes the same revision number: no gap.
    expect(await project("rolled-back", { events: [{ task_id: 1, role: "qa", type: "qa_reviewing" }] })).toBe(3);
  });

  it("delivers source event 102 committed before 101 without a gap, ordered by (revision, ordinal)", async () => {
    // Source ids are reused as delivery keys only; agent_events-style `id > since` would skip 101.
    await project("agent_event:102", { events: [{ task_id: 1, role: "qa", type: "approved" }] });
    const { rows: first } = await db.query<{ revision: number; ordinal: number }>(
      "SELECT revision::int AS revision, ordinal FROM v_office_events ORDER BY revision DESC, ordinal DESC LIMIT 1",
    );
    const cursor = first[0]!;
    await project("agent_event:101", { events: [{ task_id: 1, role: "qa", type: "qa_reviewing" }] });
    const { rows: after } = await db.query<{ revision: number; ordinal: number; type: string }>(
      "SELECT revision::int AS revision, ordinal, type FROM v_office_events WHERE (revision, ordinal) > ($1::bigint, $2::int) ORDER BY revision, ordinal",
      [cursor.revision, cursor.ordinal],
    );
    expect(after).toEqual([{ revision: cursor.revision + 1, ordinal: 0, type: "qa_reviewing" }]);
  });

  it("takes the revision lock before dedupe and allocation, and holds it in the transaction", async () => {
    const { rows } = await db.query<{ src: string }>("SELECT prosrc AS src FROM pg_proc WHERE proname = 'office_project'");
    const src = rows[0]!.src;
    const lock = src.indexOf("FROM public.office_projection_state WHERE id FOR UPDATE");
    const dedupe = src.indexOf("FROM public.office_source_deliveries d WHERE d.source_key");
    const allocate = src.indexOf("v_rev := v_state.revision + 1");
    const firstWrite = src.indexOf("INSERT INTO");
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(dedupe);
    expect(dedupe).toBeLessThan(allocate);
    expect(allocate).toBeLessThan(firstWrite);
    // Inside the caller's transaction the state row lock (RowShareLock from FOR UPDATE) is held
    // until commit, not released when the function returns.
    await db.exec("BEGIN");
    await project("lock-probe", {});
    const { rows: locks } = await db.query<{ mode: string }>(
      `SELECT mode FROM pg_locks WHERE pid = pg_backend_pid() AND relation = 'office_projection_state'::regclass ORDER BY mode`,
    );
    await db.exec("ROLLBACK");
    expect(locks.map((l) => l.mode)).toContain("RowShareLock");
  });

  it("redacts earlier journal reads when a task turns private, bumping the privacy epoch once", async () => {
    const before = await state();
    const ref = (await events()).find((e) => e.description === "Add a health page")!.task_ref;
    await project("privacy-1", { tasks: [{ task_id: 1, is_private: true }] });
    const after = await state();
    expect(after).toEqual({ revision: before.revision + 1, privacy_epoch: before.privacy_epoch + 1 });
    const all = await events();
    expect(all.length).toBeGreaterThan(4);
    expect(all.every((e) => e.description === "Private task" && e.visibility === "private")).toBe(true);
    expect(all.map((e) => e.revision)).toEqual([...all.map((e) => e.revision)].sort((a, b) => a - b));
    const { rows: inv } = await db.query("SELECT privacy_epoch::int AS privacy_epoch, task_ref, kind FROM v_office_invalidations");
    expect(inv).toEqual([{ privacy_epoch: after.privacy_epoch, task_ref: ref, kind: "redact" }]);
    // The journal never held the description: nothing to scrub there.
    const { rows: cols } = await db.query<{ c: string }>(
      "SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'office_journal'",
    );
    expect(cols.map((c) => c.c).sort()).toEqual(["event_type", "execution_ref", "ordinal", "recorded_at", "ref", "revision", "role", "task_ref"]);
    // private -> public withdraws nothing new (no bump); the earlier withdrawal stays listed and
    // its kind follows the current visibility (relabel). A public retitle bumps again (relabel).
    await project("privacy-2", { tasks: [{ task_id: 1, is_private: false }] });
    expect((await state()).privacy_epoch).toBe(after.privacy_epoch);
    const relabel = { privacy_epoch: after.privacy_epoch, task_ref: ref, kind: "relabel" };
    expect((await db.query("SELECT privacy_epoch::int AS privacy_epoch, task_ref, kind FROM v_office_invalidations")).rows).toEqual([relabel]);
    expect((await db.query("SELECT kind FROM office_privacy_changes")).rows).toEqual([{ kind: "redact" }]);
    await project("privacy-3", { tasks: [{ task_id: 1, public_title: "Add a health endpoint" }] });
    expect((await state()).privacy_epoch).toBe(after.privacy_epoch + 1);
    expect((await events()).at(0)!.description).toBe("Add a health endpoint");
    const { rows: inv2 } = await db.query("SELECT privacy_epoch::int AS privacy_epoch, task_ref, kind FROM v_office_invalidations ORDER BY 1");
    expect(inv2).toEqual([relabel, { privacy_epoch: after.privacy_epoch + 1, task_ref: ref, kind: "relabel" }]);
    expect((await db.query("SELECT kind FROM office_privacy_changes ORDER BY privacy_epoch")).rows).toEqual([{ kind: "redact" }, { kind: "relabel" }]);
    // Mixed history, private again now: every listed withdrawal reads back as redact.
    await project("privacy-4", { tasks: [{ task_id: 1, is_private: true }] });
    const { rows: inv3 } = await db.query<{ kind: string }>("SELECT kind FROM v_office_invalidations");
    expect(inv3.map((r) => r.kind)).toEqual(["redact", "redact", "redact"]);
    await project("privacy-5", { tasks: [{ task_id: 1, is_private: false }] });
  });

  it("stores titles failing the printable-ASCII 1-60 rule as NULL (Private task)", async () => {
    await project("title-1", { tasks: [{ task_id: 2, is_private: false, public_title: "Café menu" }, { task_id: 3, is_private: false, public_title: "   " }] });
    const { rows } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM office_tasks WHERE public_title IS NULL AND NOT is_private",
    );
    expect(rows[0]!.n).toBe(2);
  });

  it("keeps executions, relations and capabilities consistent with the unit-1 contract", async () => {
    await project("exec-1", {
      tasks: [{ task_id: 4, is_private: false, public_title: "Write docs", kind: "docs", state: "in_progress", role: "docs", parent_task_id: 1, parent_kind: "docs_parent" }],
      executions: [{ key: "run:4:1", task_id: 4, role: "docs", station: "docs", phase: "starting", observation_source: "trusted_start_report", observed_at: "2026-10-25T00:00:00Z", reported_activity: "coding", reported_at: "2026-10-25T00:00:00Z" }],
    });
    await project("exec-2", { tasks: [{ task_id: 4, execution: "run:4:1" }], events: [{ task_id: 4, execution: "run:4:1", role: "docs", type: "coding" }] });
    const rejects: [unknown, RegExp][] = [
      [{ events: [{ task_id: 1, execution: "run:4:1", role: "docs", type: "coding" }] }, /same task and role/],
      [{ events: [{ task_id: 4, execution: "run:4:1", role: "qa", type: "coding" }] }, /same task and role/],
      [{ tasks: [{ task_id: 4, role: "qa" }] }, /belong to the task and its role/],
      [{ tasks: [{ task_id: 1, execution: "run:4:1" }] }, /belong to the task/],
      [{ executions: [{ key: "run:4:1", task_id: 1 }] }, /immutable/],
      [{ executions: [{ key: "run:4:1", phase: "running", observation_source: "trusted_work_job" }] }, /observations are not available/],
      [{ executions: [{ key: "run:4:2", task_id: 4, role: "qa", station: "developer" }] }, /rejected \(23514\)/],
      [{ tasks: [{ task_id: 1, kind: "docs" }] }, /docs_parent/],
      [{ tasks: [{ task_id: 1, waiting_on: "ci" }] }, /rejected \(23514\)/],
      [{ events: [{ task_id: 1, role: "developer", type: "deployed" }] }, /capability/],
      [{ events: [{ task_id: null, role: "router", type: "coding" }] }, /capability/],
      [{ events: [{ task_id: 1, role: "developer", type: "coding", recorded_at: "2999-01-01T00:00:00Z" }] }, /future/],
      [{ events: [{ role: "developer", type: "coding" }] }, /bad event/],
      [{ capabilities: { deployment_events: false } }, /only be turned on/],
      [{ pause: { observed_at: "2026-10-25T00:00:00Z" } }, /bad pause/],
      [{ tasks: [{ task_id: 1, owner_text: "x" }] }, /bad task/],
      [{ task: [] }, /known keys/],
      [{ tasks: [{ task_id: 1 }, { task_id: 1 }] }, /twice/],
    ];
    const before = await state();
    for (const [transition, error] of rejects) {
      await expect(project(`bad-${JSON.stringify(transition)}`, transition), JSON.stringify(transition)).rejects.toThrow(error);
    }
    expect(await state()).toEqual(before);
    await project("caps", { capabilities: { execution_observations: true, deployment_events: true }, pause: { paused: true } });
    await project("deploy", {
      executions: [{ key: "run:4:1", phase: "terminal", outcome: "succeeded", observation_source: "trusted_workflow", observed_at: "2026-10-25T00:01:00Z" }],
      events: [{ task_id: 1, role: "developer", type: "deployed" }],
    });
    const { rows } = await db.query("SELECT paused, execution_observations, deployment_events, routing_events FROM v_office_state");
    expect(rows[0]).toEqual({ paused: true, execution_observations: true, deployment_events: true, routing_events: false });
  });

  it("refuses a reused source key with different content, without echoing it", async () => {
    await project("reuse-1", { events: [{ task_id: 1, role: "qa", type: "approved" }] });
    expect(await project("reuse-1", { events: [{ task_id: 1, role: "qa", type: "approved" }] })).toBeNull();
    const before = await state();
    await expect(project("reuse-1", { events: [{ task_id: 1, role: "qa", type: "changes_requested" }] })).rejects.toMatchObject({
      code: "P0K01", message: "office_project: source key was already projected with different content",
    });
    expect(await state()).toEqual(before);
    const { rows } = await db.query<{ n: number }>("SELECT length(digest)::int AS n FROM office_source_deliveries WHERE source_key = 'reuse-1'");
    expect(rows).toEqual([{ n: 32 }]);
  });

  it("rejects implausible timestamps and never echoes input in errors", async () => {
    const marker = "SyntheticPrivateMarker";
    const cases: [unknown, RegExp][] = [
      [{ events: [{ task_id: 1, role: "qa", type: "coding", recorded_at: "-infinity" }] }, /ISO-8601/],
      [{ events: [{ task_id: 1, role: "qa", type: "coding", recorded_at: "infinity" }] }, /ISO-8601/],
      [{ events: [{ task_id: 1, role: "qa", type: "coding", recorded_at: "2020-01-01T00:00:00Z BC" }] }, /ISO-8601/],
      [{ events: [{ task_id: 1, role: "qa", type: "coding", recorded_at: "1999-12-31T23:59:59Z" }] }, /out of range/],
      [{ events: [{ task_id: 1, role: "qa", type: "coding", recorded_at: `2026-01-01T00:00:00Z ${marker}` }] }, /ISO-8601/],
      [{ events: [{ task_id: 1, role: "qa", type: "coding", recorded_at: marker }] }, /ISO-8601/],
      [{ events: [{ task_id: 1, role: "qa", type: "coding", recorded_at: "2026-13-45T00:00:00Z" }] }, /ISO-8601/],
      [{ pause: { paused: true, observed_at: "-infinity" } }, /ISO-8601/],
      [{ executions: [{ key: "run:4:1", reported_activity: "coding", reported_at: "1970-01-01T00:00:00Z" }] }, /out of range/],
      [{ executions: [{ key: "run:4:1", observation_source: "trusted_start_report", observed_at: "2999-01-01T00:00:00Z" }] }, /out of range/],
      [{ tasks: [{ task_id: 1, state: marker }] }, /^office_project: rejected \(23514\)$/],
      [{ tasks: [{ task_id: 1.5 }] }, /^office_project: rejected \(22P02\)$/],
      [{ tasks: [{ task_id: 1, paused: "maybe" }] }, /bad task/],
    ];
    const before = await state();
    for (const [transition, error] of cases) {
      const failure = await project(`ts-${JSON.stringify(transition)}`, transition).then(() => null, (e: Error) => e);
      expect(failure, JSON.stringify(transition)).toBeInstanceOf(Error);
      expect(failure!.message, JSON.stringify(transition)).toMatch(error);
      expect(failure!.message).not.toContain(marker);
      // Server-supplied fields only (PGlite's client error also carries the query params).
      const { detail, hint, where } = failure as Error & { detail?: string; hint?: string; where?: string };
      expect(JSON.stringify({ detail, hint, where })).not.toContain(marker);
    }
    expect(await state()).toEqual(before);
    // Storage guard: even the owner cannot store an implausible timestamp.
    await expect(db.exec("UPDATE office_executions SET reported_at = '-infinity', reported_activity = 'coding'")).rejects.toThrow(/check constraint/);
  });

  it("does not let a terminal execution change phase or outcome (no revival by late reports)", async () => {
    const revive = [
      { key: "run:4:1", phase: "starting", outcome: null, observation_source: "trusted_start_report", observed_at: "2026-10-25T00:02:00Z" },
      { key: "run:4:1", outcome: "failed" },
    ];
    for (const execution of revive) {
      await expect(project(`revive-${JSON.stringify(execution)}`, { executions: [execution] })).rejects.toThrow(/terminal execution cannot change/);
    }
    expect(await project("late-report", { executions: [{ key: "run:4:1", reported_activity: "approved", reported_at: "2026-10-25T00:03:00Z" }] })).toBeGreaterThan(0);
    const { rows } = await db.query("SELECT phase, outcome FROM office_executions");
    expect(rows).toEqual([{ phase: "terminal", outcome: "succeeded" }]);
  });

  it("rejects parent cycles, not only self-reference", async () => {
    await project("cycle-0", { tasks: [{ task_id: 20, state: "queued" }, { task_id: 21, state: "queued", parent_task_id: 20, parent_kind: "planner_parent" }, { task_id: 22, state: "queued", parent_task_id: 21, parent_kind: "planner_parent" }] });
    await expect(project("cycle-1", { tasks: [{ task_id: 20, parent_task_id: 22, parent_kind: "planner_parent" }] })).rejects.toThrow(/cycle/);
    await expect(project("cycle-2", { tasks: [{ task_id: 20, parent_task_id: 20, parent_kind: "planner_parent" }] })).rejects.toThrow(/rejected \(23514\)/);
  });

  it("keeps the journal append-only", async () => {
    await expect(db.exec("UPDATE office_journal SET role = 'qa'")).rejects.toThrow(/append-only/);
    await expect(db.exec("DELETE FROM office_journal")).rejects.toThrow(/append-only/);
    await expect(db.exec("TRUNCATE office_journal CASCADE")).rejects.toThrow(/append-only/);
  });
});

describe("0006 office projection grants", () => {
  let pg: PGlite;
  let db: SqlClient;
  beforeAll(async () => {
    ({ pg, db } = await freshDb());
    await db.query("SELECT office_project('seed', $1::jsonb)", [
      JSON.stringify({
        tasks: [{ task_id: 1, is_private: true, public_title: "Seed private title", state: "in_progress" }],
        events: [{ task_id: 1, role: "developer", type: "coding" }],
      }),
    ]);
  });
  afterAll(async () => {
    await pg.close();
  });

  async function asPublic<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    await db.exec("SET ROLE web_public");
    try {
      return (await db.query<T>(sql)).rows;
    } finally {
      await db.exec("RESET ROLE");
    }
  }

  it("web_public holds exactly SELECT on the five sanitized views, beyond its 0001/0002 grants", async () => {
    const { rows } = await db.query<{ obj: string; priv: string }>(
      `SELECT c.relname AS obj, a.privilege_type AS priv FROM pg_class c, aclexplode(c.relacl) a
        WHERE a.grantee = 'web_public'::regrole ORDER BY 1, 2`,
    );
    expect(rows).toEqual([...VIEWS, "v_public_agent_events"].sort().map((obj) => ({ obj, priv: "SELECT" })));
    const { rows: cols } = await db.query(
      `SELECT 1 FROM pg_attribute at, aclexplode(at.attacl) a WHERE a.grantee = 'web_public'::regrole`,
    );
    expect(cols).toEqual([]);
    const { rows: fns } = await db.query<{ f: string; ok: boolean }>(
      `SELECT p.proname AS f, has_function_privilege('web_public', p.oid, 'EXECUTE') AS ok
         FROM pg_proc p WHERE p.proname LIKE 'office%' ORDER BY 1`,
    );
    expect(fns).toEqual([
      { f: "office_assignment", ok: false },
      { f: "office_drain", ok: false },
      { f: "office_enqueue", ok: false },
      { f: "office_journal_append_only", ok: false },
      { f: "office_outbox_protect", ok: false },
      { f: "office_project", ok: false },
      { f: "office_project_timestamp", ok: false },
      { f: "office_source_version", ok: false },
    ]);
    // No role other than the owner may execute the writer yet (unit 3 grants it).
    for (const role of ["web_rw", "orch_rw", "pipeline_rw", "relay_rw", "migrator"]) {
      const { rows: r } = await db.query<{ ok: boolean }>(
        "SELECT has_function_privilege($1, 'office_project(text, jsonb)', 'EXECUTE') AS ok",
        [role],
      );
      expect(r[0]!.ok, role).toBe(false);
    }
  });

  it("web_public is refused on every raw projection table, the source tables and the writer", async () => {
    const denied = [
      ...RAW_TABLES.map((t) => `SELECT * FROM ${t}`),
      "SELECT source_key FROM office_refs",
      "SELECT source_key FROM office_source_deliveries",
      "SELECT revision, ordinal FROM office_journal",
      "SELECT public_title FROM office_tasks",
      "INSERT INTO office_journal (revision, ordinal, recorded_at, role, event_type) VALUES (99, 0, now(), 'qa', 'coding')",
      "UPDATE office_projection_state SET revision = 99",
      "SELECT office_project('x', '{}')",
      "SELECT * FROM tasks",
      "SELECT owner_text FROM tasks",
      "SELECT detail FROM agent_events",
      "SELECT * FROM approvals",
      "SELECT * FROM usage_events",
      "SELECT * FROM inbox_items",
      "SELECT * FROM lg.checkpoints",
    ];
    for (const sql of denied) await expect(asPublic(sql), sql).rejects.toThrow(/permission denied/);
  });

  it("web_public reads the views, which hold no source ids, keys or private text", async () => {
    const columns: Record<string, string[]> = {
      v_office_state: ["generation", "revision", "privacy_epoch", "watermark_ordinal", "oldest_revision", "oldest_ordinal", "paused", "paused_observed_at", "execution_observations", "deployment_events", "routing_events"],
      v_office_tasks: ["ref", "visibility", "description", "kind", "state", "waiting_on", "paused", "role", "execution_ref", "parent_ref", "parent_kind", "active"],
      v_office_executions: ["ref", "task_ref", "role", "station", "seat", "phase", "outcome", "observation_source", "observed_at", "reported_activity", "reported_at"],
      v_office_events: ["ref", "revision", "ordinal", "recorded_at", "role", "type", "task_ref", "execution_ref", "visibility", "description"],
      v_office_invalidations: ["privacy_epoch", "task_ref", "kind"],
    };
    for (const view of VIEWS) {
      const { rows } = await db.query<{ c: string }>(
        "SELECT column_name AS c FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position",
        [view],
      );
      expect(rows.map((r) => r.c), view).toEqual(columns[view]);
      await expect(asPublic(`SELECT * FROM ${view}`), view).resolves.toBeDefined();
    }
    const text = JSON.stringify([
      await asPublic("SELECT * FROM v_office_tasks"),
      await asPublic("SELECT * FROM v_office_events"),
    ]);
    expect(text).toContain("Private task");
    expect(text).not.toContain("Seed private title");
    expect(text).not.toMatch(/"(task_id|source_key)"/);
    const { rows } = await db.query<{ ref: string }>("SELECT ref::text FROM office_refs");
    for (const r of await asPublic<{ ref: string }>("SELECT ref FROM v_office_tasks")) {
      expect(r.ref).toBe(`task_${rows[0]!.ref}`);
    }
  });
});

describe("0006 read-side timestamp guard", () => {
  it("skips a journal row with an implausible timestamp even if the storage CHECK were gone", async () => {
    const { pg, db } = await freshDb();
    try {
      await db.query("SELECT office_project('a', $1::jsonb)", [JSON.stringify({ events: [{ task_id: null, role: "qa", type: "coding" }] })]);
      const { rows } = await db.query<{ name: string }>(
        `SELECT conname AS name FROM pg_constraint
          WHERE conrelid = 'office_journal'::regclass AND pg_get_constraintdef(oid) LIKE '%isfinite%'`,
      );
      expect(rows).toHaveLength(1);
      await db.exec(`ALTER TABLE office_journal DROP CONSTRAINT ${rows[0]!.name}`);
      await db.exec("INSERT INTO office_journal (revision, ordinal, recorded_at, role, event_type) VALUES (1, 1, '-infinity', 'qa', 'coding')");
      const { rows: visible } = await db.query<{ ordinal: number }>("SELECT ordinal FROM v_office_events ORDER BY ordinal");
      expect(visible).toEqual([{ ordinal: 0 }]);
    } finally {
      await pg.close();
    }
  });
});
