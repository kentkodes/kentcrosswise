import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "../../packages/db/test/helpers";
import { asPipelineRole, createPipelineHandler, type HandlerDeps, type PipelineConnection } from "../lib/pipelines/handler";
import type { createAwsAdapters } from "../lib/pipelines/aws";

describe("pipeline runtime activation and cleanup", () => {
  let fresh: Awaited<ReturnType<typeof freshDb>>;
  beforeAll(async () => {
    fresh = await freshDb();
    await fresh.db.query("INSERT INTO sources (name,base_url,slug) VALUES ('Gutenberg','https://www.gutenberg.org','gutenberg')");
  });
  afterAll(async () => { await fresh.pg.close(); });
  // Order independence: every test starts unpaused, with the source running and no role set.
  beforeEach(async () => {
    await fresh.db.query("RESET ROLE");
    await fresh.db.query("UPDATE system_flags SET value='false' WHERE key='pipelines_paused'");
    await fresh.db.query("UPDATE sources SET paused_by=NULL WHERE slug='gutenberg'");
  });
  const currentUser = async (db: { query: PipelineConnection["query"] }) =>
    (await db.query<{ role: string }>("SELECT current_user AS role")).rows[0]!.role;
  function deps(): HandlerDeps {
    return {
      env: {
        KCW_PIPELINES_ENABLED: "true", KCW_PIPELINES_METADATA_BUCKET: "private-meta",
        KCW_ESSAY_URLS_QUEUE_URL: "https://sqs.example/essay-urls", KCW_PIPELINE_SECRET: "kcw/prod/pipeline",
      },
      secret: vi.fn(async () => "postgres://private-marker"),
      connect: vi.fn(async () => ({ query: fresh.db.query.bind(fresh.db), close: vi.fn(async () => undefined) })),
      adapters: vi.fn(() => ({ publish: vi.fn(), catalog: { get: vi.fn(), put: vi.fn() }, robots: { get: vi.fn(), put: vi.fn() }, close: vi.fn() }) as ReturnType<typeof createAwsAdapters>),
      log: vi.fn(),
      discover: vi.fn(async () => ({ discovered: 2, emitted: 2, skipped: false, rejected: 0 })),
      recover: vi.fn(async () => 1),
    };
  }
  const event = { source_slug: "gutenberg", mode: "discover" };
  const logged = (d: HandlerDeps) => JSON.stringify(vi.mocked(d.log).mock.calls);

  it("defaults disabled with zero secret/DB/source/cache/queue effects", async () => {
    const d = deps(); delete d.env.KCW_PIPELINES_ENABLED;
    expect(await createPipelineHandler(d)(event)).toEqual({ status: "disabled" });
    for (const fn of [d.secret, d.connect, d.adapters, d.discover, d.recover, d.log]) expect(fn).not.toHaveBeenCalled();
  });
  it("rejects unknown slugs, modes and surplus fields before external calls", async () => {
    const d = deps();
    for (const invalid of [{ source_slug: "wikisource", mode: "discover" }, { ...event, mode: "fetch" }, { ...event, url: "private" }]) {
      expect(await createPipelineHandler(d)(invalid)).toEqual({ status: "invalid_input" });
    }
    expect(d.secret).not.toHaveBeenCalled();
  });
  it.each([
    ["missing bucket", { KCW_PIPELINES_METADATA_BUCKET: undefined }],
    ["missing queue", { KCW_ESSAY_URLS_QUEUE_URL: undefined }],
    ["non-https queue", { KCW_ESSAY_URLS_QUEUE_URL: "http://sqs.example/essay-urls" }],
    ["missing secret name (no fallback)", { KCW_PIPELINE_SECRET: undefined }],
    ["empty secret name", { KCW_PIPELINE_SECRET: "" }],
  ])("%s is a configuration_error before any secret or DB access", async (_label, patch) => {
    const d = deps();
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete d.env[k]; else d.env[k] = v; }
    expect(await createPipelineHandler(d)(event)).toEqual({ status: "configuration_error" });
    for (const fn of [d.secret, d.connect, d.adapters, d.discover]) expect(fn).not.toHaveBeenCalled();
  });
  it("production JSON secret, per-transaction pipeline_rw and existing UUID resolution; closes all resources", async () => {
    const d = deps();
    let roleInDiscovery = "";
    d.discover = vi.fn(async (opts) => { roleInDiscovery = await currentUser(opts.db); return { discovered: 2, emitted: 2, skipped: false, rejected: 0 }; });
    expect(await createPipelineHandler(d)(event)).toEqual({ status: "ok", discovered: 2, emitted: 2, recovered: 1, rejected: 0 });
    expect(d.secret).toHaveBeenCalledWith("kcw/prod/pipeline", "db_url");
    expect(roleInDiscovery).toBe("pipeline_rw");
    // SET LOCAL ends with each transaction: nothing leaks into the session.
    expect(await currentUser(fresh.db)).not.toBe("pipeline_rw");
    const opts = vi.mocked(d.discover).mock.calls[0]![0];
    expect(opts.sourceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(opts.http?.cache).toBeDefined();
    const connection = await vi.mocked(d.connect).mock.results[0]!.value;
    expect(connection.close).toHaveBeenCalledOnce();
    expect(vi.mocked(d.adapters).mock.results[0]!.value.close).toHaveBeenCalledOnce();
    expect(logged(d)).not.toContain("private-marker");
  });
  it("preview reads the raw SSM value; paused stops before S3, SQS or sources", async () => {
    await fresh.db.query("UPDATE system_flags SET value='true' WHERE key='pipelines_paused'");
    const d = deps(); d.env.KCW_PIPELINE_SECRET = "/kcw/preview/pr-9/database-url";
    expect(await createPipelineHandler(d)(event)).toEqual({ status: "paused" });
    expect(d.secret).toHaveBeenCalledWith("/kcw/preview/pr-9/database-url", undefined);
    expect(d.adapters).not.toHaveBeenCalled();
    expect(d.discover).not.toHaveBeenCalled();
  });
  it("wikisource-en is refused as not permitted before any secret, DB, S3 or SQS access", async () => {
    const d = deps();
    expect(await createPipelineHandler(d)({ source_slug: "wikisource-en", mode: "discover" })).toEqual({ status: "source_not_permitted" });
    for (const fn of [d.secret, d.connect, d.adapters, d.discover, d.recover]) expect(fn).not.toHaveBeenCalled();
  });
  it("counts rejected links from discovery and recovery and logs only the count", async () => {
    const d = deps();
    d.discover = vi.fn(async (opts) => { opts.onLinkRejected?.("invalid_event_hints"); opts.onLinkRejected?.("invalid_link"); return { discovered: 1, emitted: 1, skipped: false, rejected: 2 }; });
    d.recover = vi.fn(async (opts) => { opts.onLinkRejected?.("event_too_large"); return 0; });
    expect(await createPipelineHandler(d)(event)).toEqual({ status: "ok", discovered: 1, emitted: 1, recovered: 0, rejected: 3 });
    expect(logged(d)).not.toMatch(/invalid_event_hints|invalid_link|event_too_large/);
  });
  it("source_missing and source_paused stop before S3 or SQS", async () => {
    const d = deps();
    await fresh.db.query("UPDATE sources SET slug='gutenberg-moved' WHERE slug='gutenberg'");
    try { expect(await createPipelineHandler(d)(event)).toEqual({ status: "source_missing" }); }
    finally { await fresh.db.query("UPDATE sources SET slug='gutenberg' WHERE slug='gutenberg-moved'"); }
    await fresh.db.query("UPDATE sources SET paused_by='owner' WHERE slug='gutenberg'");
    expect(await createPipelineHandler(d)(event)).toEqual({ status: "source_paused" });
    expect(d.adapters).not.toHaveBeenCalled();
    expect(d.discover).not.toHaveBeenCalled();
    for (const r of vi.mocked(d.connect).mock.results) expect((await r.value).close).toHaveBeenCalledOnce();
  });
  it("an empty secret value fails with a fixed reason and never connects", async () => {
    const d = deps(); d.secret = vi.fn(async () => "  ");
    await expect(createPipelineHandler(d)(event)).rejects.toThrow(/^pipeline_failed$/);
    expect(d.log).toHaveBeenCalledWith({ status: "error", reason: "database_url_empty" });
    expect(d.connect).not.toHaveBeenCalled();
  });
  it("a throwing connect fails closed without leaking its message", async () => {
    const d = deps(); d.connect = vi.fn(async () => { throw new Error("connect postgres://private-marker failed"); });
    await expect(createPipelineHandler(d)(event)).rejects.toThrow(/^pipeline_failed$/);
    expect(d.log).toHaveBeenCalledWith({ status: "error", reason: "pipeline_failed" });
    expect(d.adapters).not.toHaveBeenCalled();
    expect(logged(d)).not.toContain("private-marker");
  });
  it("fails closed when current_user is not pipeline_rw", async () => {
    const d = deps();
    d.connect = vi.fn(async () => ({
      query: (async (sql: string, params?: readonly unknown[]) =>
        sql === "SELECT current_user AS role" ? { rows: [{ role: "neondb_owner" }] } : fresh.db.query(sql, params)) as PipelineConnection["query"],
      close: vi.fn(async () => undefined),
    }));
    await expect(createPipelineHandler(d)(event)).rejects.toThrow(/^pipeline_failed$/);
    expect(d.log).toHaveBeenCalledWith({ status: "error", reason: "pipeline_role_mismatch" });
    expect(d.adapters).not.toHaveBeenCalled();
    expect(d.discover).not.toHaveBeenCalled();
    expect((await vi.mocked(d.connect).mock.results[0]!.value).close).toHaveBeenCalledOnce();
  });
  it("errors never log raw exceptions and the database still closes", async () => {
    const d = deps(); d.discover = async () => { throw new Error("private-body postgres://secret credential-value"); };
    await expect(createPipelineHandler(d)(event)).rejects.toThrow(/^pipeline_failed$/);
    expect(d.log).toHaveBeenCalledWith({ status: "error", reason: "pipeline_failed" });
    expect(logged(d)).not.toContain("credential-value");
    const connection = await vi.mocked(d.connect).mock.results[0]!.value;
    expect(connection.close).toHaveBeenCalledOnce();
    expect(vi.mocked(d.adapters).mock.results[0]!.value.close).toHaveBeenCalledOnce();
  });
  it("a close failure keeps an ok result and logs a fixed warning", async () => {
    const d = deps();
    d.connect = vi.fn(async () => ({ query: fresh.db.query.bind(fresh.db), close: vi.fn(async () => { throw new Error("close private-marker"); }) }));
    expect(await createPipelineHandler(d)(event)).toEqual({ status: "ok", discovered: 2, emitted: 2, recovered: 1, rejected: 0 });
    expect(d.log).toHaveBeenCalledWith({ status: "warning", reason: "pipeline_close_failed" });
    expect(logged(d)).not.toContain("private-marker");
  });
  it("a close failure does not mask the original error", async () => {
    const d = deps();
    d.discover = async () => { throw new Error("boom"); };
    d.adapters = vi.fn(() => ({ publish: vi.fn(), catalog: { get: vi.fn(), put: vi.fn() }, robots: { get: vi.fn(), put: vi.fn() }, close: () => { throw new Error("adapters"); } }) as ReturnType<typeof createAwsAdapters>);
    d.connect = vi.fn(async () => ({ query: fresh.db.query.bind(fresh.db), close: vi.fn(async () => { throw new Error("db"); }) }));
    await expect(createPipelineHandler(d)(event)).rejects.toThrow(/^pipeline_failed$/);
    expect(vi.mocked(d.log).mock.calls.map(([e]) => e)).toEqual([
      { status: "error", reason: "pipeline_failed" },
      { status: "warning", reason: "pipeline_close_failed" },
    ]);
    expect((await vi.mocked(d.connect).mock.results[0]!.value).close).toHaveBeenCalledOnce();
  });
});

describe("asPipelineRole", () => {
  function recorder(failOn?: string) {
    const statements: string[] = [];
    const conn: PipelineConnection = {
      query: (async (sql: string) => {
        statements.push(sql);
        if (sql === failOn) throw new Error("statement failed");
        return { rows: [] };
      }) as PipelineConnection["query"],
      close: vi.fn(async () => undefined),
    };
    return { statements, db: asPipelineRole(conn), conn };
  }
  it("wraps every statement in its own transaction with SET LOCAL ROLE", async () => {
    const r = recorder();
    await r.db.query("SELECT 1");
    await r.db.query("UPDATE sources SET next_fetch_at=now()");
    expect(r.statements).toEqual([
      "BEGIN", "SET LOCAL ROLE pipeline_rw", "SELECT 1", "COMMIT",
      "BEGIN", "SET LOCAL ROLE pipeline_rw", "UPDATE sources SET next_fetch_at=now()", "COMMIT",
    ]);
    expect(r.statements.some((s) => /^SET ROLE/i.test(s))).toBe(false);
  });
  it("rolls back and rethrows the original error", async () => {
    const r = recorder("SELECT broken");
    await expect(r.db.query("SELECT broken")).rejects.toThrow("statement failed");
    expect(r.statements).toEqual(["BEGIN", "SET LOCAL ROLE pipeline_rw", "SELECT broken", "ROLLBACK"]);
  });
  it("a failed SET LOCAL ROLE never runs the statement", async () => {
    const r = recorder("SET LOCAL ROLE pipeline_rw");
    await expect(r.db.query("SELECT 1")).rejects.toThrow("statement failed");
    expect(r.statements).toEqual(["BEGIN", "SET LOCAL ROLE pipeline_rw", "ROLLBACK"]);
  });
  it("runs as pipeline_rw on a real database and leaves the session role unchanged", async () => {
    const fresh = await freshDb();
    try {
      const db = asPipelineRole({ query: fresh.db.query.bind(fresh.db), close: async () => undefined });
      expect((await db.query<{ role: string }>("SELECT current_user AS role")).rows[0]!.role).toBe("pipeline_rw");
      await expect(db.query("SELECT value FROM system_flags")).rejects.toThrow(/permission denied/);
      expect((await fresh.db.query<{ role: string }>("SELECT current_user AS role")).rows[0]!.role).not.toBe("pipeline_rw");
      // A failed statement is rolled back, so the next one starts a clean transaction.
      expect((await db.query<{ ok: number }>("SELECT 1 AS ok")).rows[0]!.ok).toBe(1);
    } finally { await fresh.pg.close(); }
  });
});
