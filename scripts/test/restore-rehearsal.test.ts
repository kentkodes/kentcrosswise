import { PGlite } from "@electric-sql/pglite";
import { fromPglite, loadMigrations, migrate, type Migration } from "@kcw/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseArgs } from "../lib/args";
import { REHEARSAL_TABLES, assertIsolatedTarget, formatReport, rehearse } from "../lib/restore-rehearsal";

describe("assertIsolatedTarget", () => {
  const run = (...argv: string[]) => () => assertIsolatedTarget(parseArgs(argv));

  it("requires --isolated for DATABASE_URL and secrets", () => {
    expect(run()).toThrow(/--isolated/);
    expect(run("--secret", "kcw/restore/branch")).toThrow(/--isolated/);
    expect(run("--isolated")).not.toThrow();
    expect(run("--isolated", "--secret", "kcw/restore/branch")).not.toThrow();
  });

  it.each(["kcw/prod/migrator", "kcw/prod/web", "/kcw/prod/db", "kcw/production/x"])("refuses the production secret %s even with --isolated", (name) => {
    expect(run("--isolated", "--secret", name)).toThrow(/production/);
  });

  it("allows a local PGlite directory without the flag", () => {
    expect(run("--pglite", ".pglite/rehearsal")).not.toThrow();
  });
});

describe("rehearse", () => {
  let migrations: Migration[];
  let lite: PGlite;
  beforeAll(async () => {
    migrations = await loadMigrations();
    lite = await PGlite.create();
    await migrate(fromPglite(lite), { migrations });
  }, 60_000);
  afterAll(async () => {
    await lite.close();
  });

  it("passes on a fully migrated database and reports counts only", async () => {
    await lite.exec("INSERT INTO todos (body) VALUES ('private looking text')");
    const report = await rehearse(fromPglite(lite), { migrations });
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.recorded).toBe(migrations.length);
    expect(report.pending).toEqual([]);
    expect(Object.keys(report.counts)).toEqual([...REHEARSAL_TABLES]);
    expect(report.counts.todos).toBe(1);
    expect(report.counts.essays).toBe(0);
    const out = formatReport(report).join("\n");
    expect(out).toContain("restore rehearsal passed");
    expect(out).not.toContain("private looking text");
  });

  it("fails when a migration is pending", async () => {
    const extra: Migration = { version: "9999", name: "later", sql: "SELECT 1", checksum: "x" };
    const report = await rehearse(fromPglite(lite), { migrations: [...migrations, extra] });
    expect(report.ok).toBe(false);
    expect(report.pending).toEqual(["9999"]);
    expect(formatReport(report).join("\n")).toContain("restore rehearsal FAILED");
  });

  it("fails when a recorded checksum differs from the file", async () => {
    const edited = migrations.map((m, i) => (i === 0 ? { ...m, checksum: "0".repeat(64) } : m));
    const report = await rehearse(fromPglite(lite), { migrations: edited });
    expect(report.ok).toBe(false);
    expect(report.failures.join("\n")).toMatch(/edited after it was applied/);
  });

  it("fails when a recorded migration is missing on disk", async () => {
    const report = await rehearse(fromPglite(lite), { migrations: migrations.slice(0, -1) });
    expect(report.ok).toBe(false);
    expect(report.failures.join("\n")).toMatch(/missing on disk/);
  });

  it("fails when an application table cannot be read", async () => {
    const report = await rehearse(fromPglite(lite), { migrations, tables: ["todos", "no_such_table"] });
    expect(report.ok).toBe(false);
    expect(report.counts).toHaveProperty("todos");
    expect(report.failures.join("\n")).toMatch(/read no_such_table/);
  });

  it("fails on an empty database (nothing restored)", async () => {
    const empty = await PGlite.create();
    try {
      const report = await rehearse(fromPglite(empty), { migrations });
      expect(report.ok).toBe(false);
      expect(report.recorded).toBe(0);
      expect(report.pending.length).toBe(migrations.length);
    } finally {
      await empty.close();
    }
  }, 30_000);
});
