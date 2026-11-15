import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../packages/db/test/helpers";
import { minhash, normalizedTextHash } from "../../packages/essays/src/validate/duplicates";
import { syntheticBook } from "../../packages/essays/test/synthetic-book";
import { acceptancePhase, type AcceptanceReport } from "../lib/essay-acceptance";

const LOGIN = "acceptance_test_app";
const SIG_A = minhash(syntheticBook("*** START\n*** END", "a", 300));
const SIG_B = minhash(syntheticBook("*** START\n*** END", "b", 300));

describe("acceptance phase on PGlite as a pipeline_rw member", () => {
  let fresh: Awaited<ReturnType<typeof freshDb>>;
  const logs: string[] = [];
  const q = async <T>(sql: string, params: unknown[] = []) => (await fresh.db.query<T>(sql, params)).rows;

  const seed = async (title: string, status = "approved", author = "Seed Author") =>
    (await q<{ id: string }>("INSERT INTO seed_items (title, author, status) VALUES ($1, $2, $3) RETURNING id", [title, author, status]))[0]!.id;

  interface E {
    seedId?: string; kind?: "full" | "link"; title?: string; author?: string; status?: string; hook?: string | null;
    hash?: string | null; sig?: number[] | null; words?: number | null; key?: string | null; url?: string | null;
  }
  const essay = async (e: E = {}) => {
    const full = (e.kind ?? "full") === "full";
    const n = Math.random().toString(36).slice(2);
    return (await q<{ id: string }>(
      `INSERT INTO essays (kind, title, author, source_url, word_count, hook, text_s3_key, text_hash, minhash, status, seed_item_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::integer[], $10, $11) RETURNING id`,
      [
        e.kind ?? "full", e.title ?? `Title ${n}`, e.author ?? "Seed Author",
        e.url === undefined ? `https://example.com/${n}` : e.url,
        e.words === undefined ? (full ? 500 : null) : e.words, e.hook ?? null,
        e.key === undefined ? (full ? `essays/text/${n}.txt` : null) : e.key,
        e.hash === undefined ? (full ? normalizedTextHash(n) : null) : e.hash,
        e.sig === undefined ? (full ? SIG_A : null) : e.sig, e.status ?? "active", e.seedId ?? null,
      ],
    ))[0]!.id;
  };

  const run = async (): Promise<AcceptanceReport> => {
    logs.length = 0;
    await fresh.db.exec(`SET ROLE ${LOGIN}`);
    try {
      return await acceptancePhase({ db: fresh.db, log: (l) => logs.push(l) });
    } finally {
      await fresh.db.exec("RESET ROLE");
    }
  };
  const codes = (r: AcceptanceReport) => [...r.check1, ...r.check2].map((f) => f.code).sort();

  beforeAll(async () => {
    fresh = await freshDb();
    await fresh.db.exec(`CREATE ROLE ${LOGIN} LOGIN; GRANT pipeline_rw TO ${LOGIN};`);
  });
  beforeEach(async () => {
    await q("UPDATE seed_items SET essay_id = NULL");
    await q("DELETE FROM essay_categories");
    await q("DELETE FROM essays");
    await q("DELETE FROM seed_items");
  });
  afterAll(async () => {
    await fresh.pg.close();
  });

  it("passes for full, link-only and ignored (draft or rejected) seeds, and reports totals", async () => {
    const s1 = await seed("Violet Harbour");
    const s2 = await seed("Copper Lantern");
    await seed("Draft Piece", "draft");
    await seed("Rejected Piece", "rejected");
    const full = await essay({ seedId: s1, title: "Violet Harbour", hook: "A hook." });
    await essay({ seedId: s2, kind: "link", title: "Copper Lantern", sig: null });
    await essay({ status: "pending_category", title: "Amber Meadow", sig: SIG_B });
    await essay({ status: "quarantined", title: "Silver Orchard", sig: SIG_A, hook: null });
    await q("INSERT INTO essay_categories (essay_id, type, confidence, model) VALUES ($1, 'travel', 1, 'seed-list')", [full]);
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.check1).toEqual([]);
    expect(r.check2).toEqual([]);
    expect(r.totals).toEqual({
      approved_seeds: 2, full: 2, link_only: 1, quarantined: 1, pending_category: 1, with_hook: 1, without_hook: 1,
      categorized_by_model: 0, categorized_seed_list: 1, uncategorized: 3,
    });
    expect(logs).toContain("essay-acceptance: result=pass");
  });

  it("splits categories by model and seed-list; an essay with both counts as model", async () => {
    const a = await essay({ title: "Violet Harbour" });
    const b = await essay({ title: "Copper Lantern", sig: SIG_B });
    await q("INSERT INTO essay_categories (essay_id, type, confidence, model) VALUES ($1, 'travel', 1, 'seed-list'), ($1, 'critical', 0.8, 'deepseek-flash')", [a]);
    await q("INSERT INTO essay_categories (essay_id, type, confidence, model) VALUES ($1, 'cultural', 1, 'seed-list')", [b]);
    const r = await run();
    expect(r.totals).toMatchObject({ categorized_by_model: 1, categorized_seed_list: 1, uncategorized: 0 });
  });

  it("seed_without_essay: an approved seed with no essay row", async () => {
    const s = await seed("Violet Harbour");
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.check1).toEqual([{ code: "seed_without_essay", ids: [s] }]);
    expect(logs).toContain(`essay-acceptance: failure code=seed_without_essay ids=${s}`);
    expect(logs).toContain("essay-acceptance: result=fail");
  });

  it.each([
    ["not active", { status: "pending_category" }],
    ["no text key", { key: null }],
    ["no hash", { hash: null }],
    ["no word count", { words: null }],
  ] as const)("full_incomplete: a full essay that is %s", async (_n, patch) => {
    // The schema CHECK forbids a full row without key or hash; lift it so the report is proven to see it anyway.
    await q("ALTER TABLE essays DROP CONSTRAINT essays_check");
    try {
      const s = await seed("Violet Harbour");
      const id = await essay({ seedId: s, ...patch });
      const r = await run();
      expect(r.check1).toEqual([{ code: "full_incomplete", ids: [id] }]);
      expect(r.ok).toBe(false);
    } finally {
      await q("DELETE FROM essays");
      await q("ALTER TABLE essays ADD CONSTRAINT essays_check CHECK (kind = 'link' OR (text_hash IS NOT NULL AND text_s3_key IS NOT NULL))");
    }
  });

  it("link_incomplete: a link-only essay without a source URL", async () => {
    const s = await seed("Violet Harbour");
    const id = await essay({ seedId: s, kind: "link", url: null });
    const r = await run();
    expect(r.check1).toEqual([{ code: "link_incomplete", ids: [id] }]);
  });

  it("repeated_text_hash: two active essays with one hash", async () => {
    await q("ALTER TABLE essays DROP CONSTRAINT essays_text_hash_key"); // the schema forbids it; prove the check still sees it
    const h = normalizedTextHash("same");
    const a = await essay({ hash: h, sig: SIG_A, title: "Violet Harbour" });
    const b = await essay({ hash: h, sig: SIG_B, title: "Copper Lantern" });
    const r = await run();
    expect(r.check2).toEqual([{ code: "repeated_text_hash", ids: [a, b].sort() }]);
    expect(r.ok).toBe(false);
    await q("DELETE FROM essays");
    await q("ALTER TABLE essays ADD CONSTRAINT essays_text_hash_key UNIQUE (text_hash)");
  });

  it("near_duplicate: two full texts with the same MinHash signature; a distinct one is fine; link and non-active rows are ignored", async () => {
    const a = await essay({ sig: SIG_A, title: "Violet Harbour" });
    const b = await essay({ sig: SIG_A, title: "Copper Lantern" });
    await essay({ sig: SIG_B, title: "Amber Meadow" });
    await essay({ sig: SIG_A, title: "Silver Orchard", status: "quarantined" });
    const r = await run();
    expect(r.check2).toEqual([{ code: "near_duplicate", ids: [a, b].sort() }]);
  });

  it("metadata_duplicate: same author and a near-identical title; a different author is fine", async () => {
    const a = await essay({ author: "Mary Example", title: "The Quiet Garden", sig: SIG_A });
    const b = await essay({ author: "Mary Example", title: "The Quiet Garden", sig: SIG_B });
    await essay({ author: "Other Person", title: "The Quiet Garden", sig: minhash("another text entirely different words here now") });
    const r = await run();
    expect(r.check2).toEqual([{ code: "metadata_duplicate", ids: [a, b].sort() }]);
  });

  it("minhash_missing: a full text without a signature cannot be proven distinct", async () => {
    const id = await essay({ sig: null, title: "Violet Harbour" });
    const r = await run();
    expect(r.check2).toEqual([{ code: "minhash_missing", ids: [id] }]);
    expect(codes(r)).toEqual(["minhash_missing"]);
  });

  it("prints only counts, codes and ids (no titles or authors)", async () => {
    await seed("Violet Harbour Secret");
    await essay({ author: "Hidden Writer", title: "Hidden Title", sig: SIG_A });
    await run();
    const all = logs.join("\n");
    for (const l of ["Violet Harbour Secret", "Hidden Writer", "Hidden Title", "Seed Author"]) expect(all).not.toContain(l);
  });
});

describe("CLI", () => {
  const scriptsDir = fileURLToPath(new URL("..", import.meta.url));
  const tmp = mkdtempSync(join(tmpdir(), "kcw-acceptance-cli-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("--phase acceptance needs no ids and exits 0 on an empty library, 1 with an uncovered approved seed", async () => {
    const pglite = join(tmp, "db");
    const cli = () => spawnSync(process.execPath, ["--import", "tsx", "essay-ingest.ts", "--phase", "acceptance", "--pglite", pglite], {
      cwd: scriptsDir, encoding: "utf8", timeout: 120_000,
    });
    // migrate a PGlite directory, then run
    const { PGlite } = await import("@electric-sql/pglite");
    const { fromPglite, migrate } = await import("../../packages/db/src/index");
    const lite = new PGlite(pglite);
    await migrate(fromPglite(lite));
    await lite.close();
    const empty = cli();
    expect(empty.stderr).toBe("");
    expect(empty.status).toBe(0);
    expect(empty.stdout).toContain("essay-acceptance: result=pass");
    const again = new PGlite(pglite);
    await again.exec("INSERT INTO seed_items (title, author, status) VALUES ('Violet Harbour', 'A B', 'approved')");
    await again.close();
    const failing = cli();
    expect(failing.status).toBe(1);
    expect(failing.stdout).toContain("code=seed_without_essay");
    expect(failing.stdout).not.toContain("Violet Harbour");
  }, 240_000);
});
