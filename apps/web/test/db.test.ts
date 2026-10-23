import type { PGlite } from "@electric-sql/pglite";
import { createFakeSecrets } from "@kcw/secrets";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DbNotConfiguredError, dbErrorLabel, resolveDatabaseUrl, runAs, type PoolLike } from "../src/server/db";
import { freshDb, pglitePool } from "./pglite";

const URL_RW = "postgres://web_rw_user:pw@db.example.invalid/app";
const URL_PUBLIC = "postgres://web_public_user:pw@db.example.invalid/app";

describe("resolveDatabaseUrl", () => {
  it("prod: reads db_url for web_rw and db_url_public for web_public from KCW_WEB_SECRET", async () => {
    const { store } = createFakeSecrets({ "kcw/prod/web": { db_url: URL_RW, db_url_public: URL_PUBLIC } });
    const env = { KCW_WEB_SECRET: "kcw/prod/web" };
    await expect(resolveDatabaseUrl("web_rw", env, store, false)).resolves.toBe(URL_RW);
    await expect(resolveDatabaseUrl("web_public", env, store, false)).resolves.toBe(URL_PUBLIC);
  });

  it("prod: a missing secret, key or empty value is DbNotConfiguredError without the value", async () => {
    const cases = [
      createFakeSecrets({}).store,
      createFakeSecrets({ "kcw/prod/web": { auth_secret: "x" } }).store,
      createFakeSecrets({ "kcw/prod/web": { db_url: "", db_url_public: "" } }).store,
      createFakeSecrets({ "kcw/prod/web": "not json" }).store,
    ];
    for (const store of cases) {
      await expect(resolveDatabaseUrl("web_public", {}, store, false)).rejects.toBeInstanceOf(DbNotConfiguredError);
    }
    const leaky = createFakeSecrets({ "kcw/prod/web": { db_url: "mysql://secret-value" } }).store;
    const err = await resolveDatabaseUrl("web_rw", {}, leaky, false).catch((e: Error) => e);
    expect(err).toBeInstanceOf(DbNotConfiguredError);
    expect(String((err as Error).message)).not.toContain("secret-value");
  });

  it("prod: access errors are not 'not configured'", async () => {
    const { store, aws } = createFakeSecrets({ "kcw/prod/web": { db_url: URL_RW } });
    aws.failNextWith = "AccessDeniedException";
    const err = await resolveDatabaseUrl("web_rw", {}, store, false).catch((e: Error) => e);
    expect(err).not.toBeInstanceOf(DbNotConfiguredError);
  });

  it("prod builds ignore the preview and local variables", async () => {
    const { store } = createFakeSecrets({ "kcw/prod/web": { db_url: URL_RW } });
    const env = { KCW_LOCAL_DATABASE_URL: URL_PUBLIC, KCW_DATABASE_URL_PARAM: "/kcw/preview/pr-1/database-url" };
    await expect(resolveDatabaseUrl("web_rw", env, store, false)).resolves.toBe(URL_RW);
  });

  it("preview: the SSM parameter for both roles; never the prod secret", async () => {
    const param = "/kcw/preview/pr-7/database-url";
    const { store, aws } = createFakeSecrets({ [param]: URL_RW, "kcw/prod/web": { db_url: URL_PUBLIC } });
    const env = { KCW_DATABASE_URL_PARAM: param };
    await expect(resolveDatabaseUrl("web_rw", env, store, true)).resolves.toBe(URL_RW);
    await expect(resolveDatabaseUrl("web_public", env, store, true)).resolves.toBe(URL_RW);
    await expect(resolveDatabaseUrl("web_rw", {}, store, true)).rejects.toBeInstanceOf(DbNotConfiguredError);
    expect(aws.calls.every((c) => c.name === param)).toBe(true);
  });

  it("preview: KCW_LOCAL_DATABASE_URL wins (local Playwright)", async () => {
    const { store } = createFakeSecrets({});
    await expect(
      resolveDatabaseUrl("web_public", { KCW_LOCAL_DATABASE_URL: URL_PUBLIC }, store, true),
    ).resolves.toBe(URL_PUBLIC);
  });
});

describe("runAs on PGlite", () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await freshDb();
  });
  afterAll(async () => {
    await pg.close();
  });

  it("runs as the given role and resets it afterwards", async () => {
    const pool = pglitePool(pg);
    const who = await runAs(pool, "web_public", async (db) => (await db.query<{ u: string }>("SELECT current_user AS u")).rows[0]!.u);
    expect(who).toBe("web_public");
    const after = await pg.query<{ u: string }>("SELECT current_user AS u");
    expect(after.rows[0]!.u).toBe("postgres");
  });

  it("web_public cannot read the tables behind the view", async () => {
    const pool = pglitePool(pg);
    await expect(runAs(pool, "web_public", (db) => db.query("SELECT * FROM tasks"))).rejects.toThrow(/permission denied/);
    await expect(runAs(pool, "web_public", (db) => db.query("SELECT * FROM v_public_agent_events"))).resolves.toBeDefined();
  });

  it("rolls back on error and READ ONLY refuses writes", async () => {
    const pool = pglitePool(pg);
    await expect(
      runAs(pool, "web_rw", async (db) => {
        await db.query("UPDATE system_flags SET value = 'true' WHERE key = 'agents_paused'");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const { rows } = await pg.query<{ value: boolean }>("SELECT value FROM system_flags WHERE key = 'agents_paused'");
    expect(rows[0]!.value).toBe(false);
    await expect(
      runAs(pool, "web_rw", (db) => db.query("UPDATE system_flags SET value = 'true'"), { readOnly: true }),
    ).rejects.toThrow(/read-only/);
  });

  it("retries once when BEGIN fails on a dead connection", async () => {
    let connects = 0;
    const inner = pglitePool(pg);
    const pool: PoolLike = {
      connect: async () => {
        connects++;
        const c = await inner.connect();
        if (connects === 1) {
          return { query: async () => Promise.reject(new Error("Connection terminated")), release: c.release };
        }
        return c;
      },
    };
    await expect(runAs(pool, "web_rw", async () => 42)).resolves.toBe(42);
    expect(connects).toBe(2);
    expect(inner.released[0]).toBe(true);
  });
});

describe("dbErrorLabel", () => {
  it("keeps class and SQLSTATE only", () => {
    const err = Object.assign(new Error("password authentication failed for user x at host y"), { code: "28P01" });
    expect(dbErrorLabel(err)).toBe("Error 28P01");
    expect(dbErrorLabel("x")).toBe("error");
  });
});
