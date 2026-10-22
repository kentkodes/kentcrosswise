import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MigrationError, checksumOf, fromPglite, loadMigrations, migrate, type SqlClient } from "../src/index";
import { freshDb } from "./helpers";

describe("loadMigrations", () => {
  it("finds 0001 and normalizes CRLF in checksums", async () => {
    const ms = await loadMigrations();
    expect(ms[0]?.version).toBe("0001");
    expect(checksumOf("a\r\nb")).toBe(checksumOf("a\nb"));
  });

  it("rejects badly named files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kcw-mig-"));
    try {
      await writeFile(join(dir, "1_bad.sql"), "SELECT 1;");
      await expect(loadMigrations(dir)).rejects.toBeInstanceOf(MigrationError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("migrate on PGlite", () => {
  it("is idempotent", async () => {
    const pg = new PGlite();
    const db = fromPglite(pg);
    const first = await migrate(db);
    expect(first.applied).toContain("0001");
    const second = await migrate(db);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(first.applied);
    await pg.close();
  });

  it("dry run applies nothing", async () => {
    const pg = new PGlite();
    const db = fromPglite(pg);
    const res = await migrate(db, { dryRun: true });
    expect(res.applied).toContain("0001");
    const { rows } = await db.query("SELECT to_regclass('public.entries')::text AS t");
    expect(rows[0]).toEqual({ t: null });
    await pg.close();
  });

  it("refuses an edited migration", async () => {
    const pg = new PGlite();
    const db = fromPglite(pg);
    const ms = await loadMigrations();
    await migrate(db, { migrations: ms });
    const edited = ms.map((m) => (m.version === "0001" ? { ...m, checksum: checksumOf(m.sql + "\n-- edit") } : m));
    await expect(migrate(db, { migrations: edited })).rejects.toThrow(/edited after it was applied/);
    await pg.close();
  });

  it("rolls back a failing migration and records nothing", async () => {
    const pg = new PGlite();
    const db = fromPglite(pg);
    const bad = [{ version: "0001", name: "bad", sql: "CREATE TABLE t1 (id int); SELECT nope();", checksum: "x" }];
    await expect(migrate(db, { migrations: bad })).rejects.toBeInstanceOf(MigrationError);
    const { rows } = await db.query(
      "SELECT to_regclass('public.t1')::text AS t, (SELECT count(*)::int FROM schema_migrations) AS n",
    );
    expect(rows[0]).toEqual({ t: null, n: 0 });
    await pg.close();
  });

  it("refuses when an applied migration is missing on disk", async () => {
    const pg = new PGlite();
    const db = fromPglite(pg);
    await migrate(db);
    await expect(migrate(db, { migrations: [] })).rejects.toThrow(/missing on disk/);
    await pg.close();
  });
});

describe("0001 constraints", () => {
  let pg: PGlite;
  let db: SqlClient;
  beforeAll(async () => {
    ({ pg, db } = await freshDb());
  });
  afterAll(async () => {
    await pg.close();
  });

  async function diary(): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO diary_entries (body) VALUES ('synthetic') RETURNING id",
    );
    return rows[0]!.id;
  }
  const moodSql = `INSERT INTO mood_scores (diary_entry_id, energy, stress, happiness, satisfaction, sadness, anger,
    anxiety, gratitude, sentiment, model) VALUES ($1, $2, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, $3, 'fake')`;

  it("mood scores accept 0..1 and sentiment -1..1", async () => {
    await expect(db.query(moodSql, [await diary(), 1, -1])).resolves.toBeDefined();
    await expect(db.query(moodSql, [await diary(), 0, 1])).resolves.toBeDefined();
  });

  it("mood scores reject out-of-range values", async () => {
    await expect(db.query(moodSql, [await diary(), 1.01, 0])).rejects.toThrow(/check constraint/);
    await expect(db.query(moodSql, [await diary(), -0.1, 0])).rejects.toThrow(/check constraint/);
    await expect(db.query(moodSql, [await diary(), 0.5, -1.2])).rejects.toThrow(/check constraint/);
    await expect(db.query(moodSql, [await diary(), 0.5, 1.2])).rejects.toThrow(/check constraint/);
  });

  it("social snapshots are unique per account and day", async () => {
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO social_accounts (platform, handle) VALUES ('youtube', 'demo-channel') RETURNING id",
    );
    const id = rows[0]!.id;
    const ins = "INSERT INTO social_snapshots (account_id, day, followers, views) VALUES ($1, $2, 10, 100)";
    await db.query(ins, [id, "2026-01-01"]);
    await db.query(ins, [id, "2026-01-02"]);
    await expect(db.query(ins, [id, "2026-01-01"])).rejects.toThrow(/duplicate key/);
  });

  it("essays.text_hash is unique and length_band is generated", async () => {
    const ins = `INSERT INTO essays (kind, title, author, word_count, text_hash, text_s3_key)
      VALUES ('full', $1, 'Anon', $2, $3, 'k') RETURNING length_band`;
    const a = await db.query<{ length_band: string }>(ins, ["A", 1999, "hash-a"]);
    const b = await db.query<{ length_band: string }>(ins, ["B", 2000, "hash-b"]);
    const c = await db.query<{ length_band: string }>(ins, ["C", 6000, "hash-c"]);
    expect([a.rows[0]?.length_band, b.rows[0]?.length_band, c.rows[0]?.length_band]).toEqual([
      "short",
      "medium",
      "long",
    ]);
    await expect(db.query(ins, ["D", 100, "hash-a"])).rejects.toThrow(/duplicate key/);
  });

  it("full-text essays need a text hash; link-only ones do not", async () => {
    await expect(db.query("INSERT INTO essays (kind, title, author) VALUES ('full', 'X', 'Y')")).rejects.toThrow(
      /check constraint/,
    );
    await expect(
      db.query("INSERT INTO essays (kind, title, author) VALUES ('link', 'X', 'Y')"),
    ).resolves.toBeDefined();
  });

  it("essay_prefs is a single row with known types and lengths", async () => {
    await db.query("INSERT INTO essay_prefs (types, lengths) VALUES ('{political,travel}', '{short}')");
    await expect(db.query("INSERT INTO essay_prefs (id) VALUES (2)")).rejects.toThrow(/check constraint/);
    await expect(db.query("UPDATE essay_prefs SET lengths = '{huge}'")).rejects.toThrow(/check constraint/);
  });

  it("ratings stars are 1..5", async () => {
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO essays (kind, title, author) VALUES ('link', 'R', 'S') RETURNING id",
    );
    await expect(
      db.query("INSERT INTO ratings (essay_id, stars) VALUES ($1, 6)", [rows[0]!.id]),
    ).rejects.toThrow(/check constraint/);
  });
});

describe("0001 roles", () => {
  let pg: PGlite;
  let db: SqlClient;
  beforeAll(async () => {
    ({ pg, db } = await freshDb());
    await db.query("INSERT INTO contacts (name, notes) VALUES ('Demo Person', 'synthetic note')");
  });
  afterAll(async () => {
    await pg.close();
  });

  async function as<T>(role: string, sql: string): Promise<T[]> {
    await db.exec(`SET ROLE ${role}`);
    try {
      return (await db.query<T>(sql)).rows;
    } finally {
      await db.exec("RESET ROLE");
    }
  }

  it("creates the five roles", async () => {
    const { rows } = await db.query<{ rolname: string }>(
      "SELECT rolname FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname",
      [["web_rw", "web_public", "orch_rw", "pipeline_rw", "migrator"]],
    );
    expect(rows.map((r) => r.rolname)).toEqual(["migrator", "orch_rw", "pipeline_rw", "web_public", "web_rw"]);
  });

  it("web_public cannot read app tables", async () => {
    await expect(as("web_public", "SELECT * FROM contacts")).rejects.toThrow(/permission denied/);
    await expect(as("web_public", "SELECT * FROM essays")).rejects.toThrow(/permission denied/);
  });

  it("web_rw can read app tables", async () => {
    expect(await as("web_rw", "SELECT name FROM contacts")).toEqual([{ name: "Demo Person" }]);
  });

  it("orch_rw reads contact names and aliases only", async () => {
    expect(await as("orch_rw", "SELECT name, aliases FROM contacts")).toEqual([
      { name: "Demo Person", aliases: [] },
    ]);
    await expect(as("orch_rw", "SELECT notes FROM contacts")).rejects.toThrow(/permission denied/);
    await expect(as("orch_rw", "SELECT * FROM diary_entries")).rejects.toThrow(/permission denied/);
  });

  it("pipeline_rw reaches essays tables but not owner data", async () => {
    await expect(as("pipeline_rw", "SELECT * FROM essays")).resolves.toBeDefined();
    await expect(as("pipeline_rw", "SELECT * FROM ratings")).rejects.toThrow(/permission denied/);
    await expect(as("pipeline_rw", "SELECT * FROM contacts")).rejects.toThrow(/permission denied/);
  });
});
