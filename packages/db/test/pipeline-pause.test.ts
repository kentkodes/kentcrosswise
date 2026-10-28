import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./helpers";
import type { SqlClient } from "../src/index";

describe("pipeline pause accessor", () => {
  let db: SqlClient;
  let close: () => Promise<unknown>;
  beforeAll(async () => { const fresh = await freshDb(); db = fresh.db; close = () => fresh.pg.close(); });
  afterAll(async () => { await close(); });
  // Every test starts from the migrated state (row present, JSON false), whatever ran before it.
  async function setFlag(value: string): Promise<void> {
    await db.query(
      "INSERT INTO public.system_flags (key,value) VALUES ('pipelines_paused',$1::jsonb) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
      [value],
    );
  }
  beforeEach(async () => {
    await db.query("RESET ROLE");
    await db.query("RESET search_path");
    await setFlag("false");
  });
  async function pausedAs(role: string, searchPath?: string): Promise<unknown> {
    await db.query(`SET ROLE ${role}`);
    try {
      if (searchPath) await db.query(`SET search_path TO ${searchPath}`);
      return (await db.query<{ paused: unknown }>("SELECT public.pipeline_is_paused() AS paused")).rows[0]!.paused;
    } finally {
      await db.query("RESET search_path");
      await db.query("RESET ROLE");
    }
  }

  it("exposes only exact JSON false and fails closed for malformed values", async () => {
    for (const value of ["false", "true", '"false"', "null", "{}", "0"]) {
      await setFlag(value);
      expect(await pausedAs("pipeline_rw")).toBe(value !== "false");
    }
    await db.query("SET ROLE pipeline_rw");
    try { await expect(db.query("SELECT value FROM public.system_flags")).rejects.toThrow(/permission denied/); }
    finally { await db.query("RESET ROLE"); }
  });

  it("fails closed when the row is missing and reads false again once it is re-inserted", async () => {
    await db.query("DELETE FROM public.system_flags WHERE key='pipelines_paused'");
    expect(await pausedAs("pipeline_rw")).toBe(true);
    await db.query("INSERT INTO public.system_flags (key,value) VALUES ('pipelines_paused','false')");
    expect(await pausedAs("pipeline_rw")).toBe(false);
  });

  it("ignores a temporary system_flags table in pg_temp", async () => {
    await setFlag("true");
    await db.query("CREATE TEMP TABLE system_flags (key text,value jsonb)");
    try {
      await db.query("INSERT INTO pg_temp.system_flags VALUES ('pipelines_paused','false')");
      expect(await pausedAs("pipeline_rw")).toBe(true);
      expect(await pausedAs("pipeline_rw", "pg_temp, public")).toBe(true);
    } finally { await db.query("DROP TABLE pg_temp.system_flags"); }
  });

  it("ignores a schema placed earlier in the caller's search_path, in both directions", async () => {
    await db.query("CREATE SCHEMA shadow");
    try {
      await db.query("CREATE TABLE shadow.system_flags (key text PRIMARY KEY, value jsonb NOT NULL)");
      await db.query("GRANT USAGE ON SCHEMA shadow TO pipeline_rw");
      await db.query("GRANT SELECT ON shadow.system_flags TO pipeline_rw");
      await db.query("INSERT INTO shadow.system_flags VALUES ('pipelines_paused','false')");
      await setFlag("true");
      // The shadow table is what an unqualified lookup would see from this search_path ...
      await db.query("SET ROLE pipeline_rw");
      try {
        await db.query("SET search_path TO shadow, public");
        expect((await db.query<{ value: unknown }>("SELECT value FROM system_flags WHERE key='pipelines_paused'")).rows[0]!.value).toBe(false);
      } finally { await db.query("RESET search_path"); await db.query("RESET ROLE"); }
      // ... but the accessor still reads public.system_flags.
      expect(await pausedAs("pipeline_rw", "shadow, public")).toBe(true);
      await db.query("UPDATE shadow.system_flags SET value='true'");
      await setFlag("false");
      expect(await pausedAs("pipeline_rw", "shadow, public")).toBe(false);
    } finally { await db.query("DROP SCHEMA shadow CASCADE"); }
  });

  it("denies callers other than pipeline_rw", async () => {
    await db.query("SET ROLE web_public");
    try { await expect(db.query("SELECT public.pipeline_is_paused()")).rejects.toThrow(/permission denied/); }
    finally { await db.query("RESET ROLE"); }
  });
});
