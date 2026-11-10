import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeProvider, type FakeProviderOptions } from "@kcw/core/models";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDb } from "../../packages/db/test/helpers";
import { registerGutenbergSource } from "../../packages/essays/src/registry/bootstrap";
import {
  CONFIDENCE_THRESHOLD, EXCERPT_WORDS, ESSAY_TYPES, categorizePhase, modelsFromSecret, type CategorizeDeps, type Models,
} from "../lib/essay-categorize";
import { storePhase } from "../lib/essay-ingest";

const FIXTURES = fileURLToPath(new URL("../../packages/essays/test/fixtures/gutenberg-text/", import.meta.url));
const ESSAY = readFileSync(join(FIXTURES, "essay.txt"), "utf8");
// Phrases that must never appear in output: essay text, the prompt instructions, key material.
const LEAKS = ["Studies serve for delight", "wise men use them", "Bowling is good", "Choose the one label", "KEYMATERIAL", "RESPONSEBODY"];

const tmp = mkdtempSync(join(tmpdir(), "kcw-essay-cat-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("categorize phase on PGlite as a pipeline_rw member", () => {
  const LOGIN = "categorize_test_app";
  const IDS = { ok: 301, low: 302, mismatch: 303, perr: 304, models: 305, cap: 306, fb: 307, missing: 308, noFile: 309, fb2: 310, bad: 311 };
  let fresh: Awaited<ReturnType<typeof freshDb>>;
  let dir: string;
  const logs: string[] = [];

  const q = async <T>(sql: string, params: unknown[] = []) => (await fresh.db.query<T>(sql, params)).rows;
  const urlOf = (id: number) => `https://www.gutenberg.org/ebooks/${id}`;
  const statusOf = async (id: number) => (await q<{ status: string }>("SELECT status FROM essays WHERE source_url = $1", [urlOf(id)]))[0]?.status;
  const categories = async () => q<{ type: string; confidence: number; model: string; source_url: string }>(
    "SELECT c.type, c.confidence, c.model, e.source_url FROM essay_categories c JOIN essays e ON e.id = c.essay_id ORDER BY e.source_url");
  const setPaused = (v: boolean) =>
    q("INSERT INTO system_flags (key, value) VALUES ('pipelines_paused', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [String(v)]);

  const jev = (classify: FakeProviderOptions["classify"]) => new FakeProvider({ name: "jev", model: "jev-1.13.0", classify });
  const haiku = (classify: FakeProviderOptions["classify"]) => new FakeProvider({ name: "anthropic", model: "claude-haiku-5-5", classify });
  const models = (primary: FakeProvider, fallback: FakeProvider): Models => ({ primary, fallback });

  const run = async (ids: number[], getModels: CategorizeDeps["getModels"]) => {
    await fresh.db.exec(`SET ROLE ${LOGIN}`);
    try {
      return await categorizePhase(ids, { db: fresh.db, dir, getModels, log: (l) => logs.push(l) });
    } finally {
      await fresh.db.exec("RESET ROLE");
    }
  };

  function writeBook(id: number, extraWords = 0): void {
    mkdirSync(join(dir, String(id)), { recursive: true });
    const extra = extraWords ? `\n\n${Array.from({ length: extraWords }, (_, i) => `padword${i}`).join(" ")}\n\n` : "";
    const text = ESSAY.replace("special receipt", `special receipt ${id}`).replace("*** END OF", `${extra}*** END OF`);
    writeFileSync(join(dir, String(id), `${id}-0.txt`), text);
  }

  beforeAll(async () => {
    fresh = await freshDb();
    dir = join(tmp, "books");
    const sourceId = (await registerGutenbergSource(fresh.db)).id;
    await fresh.db.exec(`CREATE ROLE ${LOGIN} LOGIN; GRANT pipeline_rw TO ${LOGIN};`);
    await setPaused(false);
    const stored = [IDS.ok, IDS.low, IDS.mismatch, IDS.perr, IDS.models, IDS.cap, IDS.fb, IDS.noFile, IDS.fb2, IDS.bad];
    for (const id of [...stored, IDS.missing]) {
      const seed = await q<{ id: string }>(
        "INSERT INTO seed_items (title, author, year, status) VALUES ($1, 'Francis Bacon', 1625, 'approved') RETURNING id", [`Seed title ${id}`]);
      await q(
        `INSERT INTO seed_source_links (seed_item_id, source_id, candidate_url, candidate_title, candidate_author, tier, score, status)
         VALUES ($1, $2, $3, 't', 'a', 'A', 1, 'approved')`, [seed[0]?.id, sourceId, urlOf(id)]);
    }
    for (const id of stored) writeBook(id, id === IDS.cap ? 3000 : 0);
    // The store phase creates the pending_category rows (as the superuser; the grants are exercised below).
    const res = await storePhase(stored, { db: fresh.db, putObject: async () => undefined, dir, log: () => undefined });
    expect(res.every((r) => r.code === "stored")).toBe(true);
    rmSync(join(dir, String(IDS.noFile)), { recursive: true, force: true });
  });
  afterAll(async () => {
    await fresh.pg.close();
  });

  it("happy path: one category row, essay active; the labels are exactly the ten type ids", async () => {
    const primary = jev({ label: "argumentative", confidence: 0.91 });
    const fallback = haiku({ label: "travel", confidence: 1 });
    const res = await run([IDS.ok], async () => models(primary, fallback));
    expect(res).toEqual([{ id: IDS.ok, code: "categorized", type: "argumentative", confidence: 0.91, model: "jev-1.13.0" }]);
    expect(await statusOf(IDS.ok)).toBe("active");
    expect(await categories()).toEqual([{ type: "argumentative", confidence: expect.closeTo(0.91, 5), model: "jev-1.13.0", source_url: urlOf(IDS.ok) }]);
    expect(primary.calls).toHaveLength(1);
    expect(fallback.calls).toHaveLength(0);
    expect(primary.calls[0]?.labels).toEqual([
      "argumentative", "critical", "comedic", "creative_lyric", "personal_memoir",
      "philosophical", "political", "science_nature", "cultural", "travel",
    ]);
    expect([...ESSAY_TYPES]).toEqual(primary.calls[0]?.labels);
    expect(logs).toContain(`essay-ingest: id=${IDS.ok} code=categorized type=argumentative confidence=0.91 model=jev-1.13.0`);
  });

  it("rerun is a no-op and calls no provider", async () => {
    const primary = jev({ label: "travel", confidence: 1 });
    const before = await categories();
    expect(await run([IDS.ok], async () => models(primary, haiku({ label: "travel", confidence: 1 })))).toEqual([{ id: IDS.ok, code: "already_processed" }]);
    expect(primary.calls).toHaveLength(0);
    expect(await categories()).toEqual(before);
  });

  it("uses the fallback below the threshold and records its model id", async () => {
    const res = await run([IDS.fb], async () =>
      models(jev({ label: "travel", confidence: CONFIDENCE_THRESHOLD - 0.1 }), haiku({ label: "critical", confidence: 0.8, model: "claude-haiku-5-5-20260101" })));
    expect(res).toEqual([{ id: IDS.fb, code: "categorized", type: "critical", confidence: 0.8, model: "claude-haiku-5-5-20260101" }]);
    expect((await categories()).find((c) => c.source_url === urlOf(IDS.fb))?.model).toBe("claude-haiku-5-5-20260101");
  });

  it("a low-confidence fallback answer is final: stored, essay active, log says why Jev was not used", async () => {
    const res = await run([IDS.low], async () => models(jev({ label: "travel", confidence: 0.3456 }), haiku({ label: "cultural", confidence: 0.2 })));
    expect(res).toEqual([{ id: IDS.low, code: "categorized", type: "cultural", confidence: 0.2, model: "claude-haiku-5-5" }]);
    expect(await statusOf(IDS.low)).toBe("active");
    expect((await categories()).find((c) => c.source_url === urlOf(IDS.low))).toEqual(
      { type: "cultural", confidence: expect.closeTo(0.2, 5), model: "claude-haiku-5-5", source_url: urlOf(IDS.low) });
    expect(logs).toContain(
      `essay-ingest: id=${IDS.low} code=categorized type=cultural confidence=0.20 model=claude-haiku-5-5 fallback=low_confidence primary_confidence=0.35`);
    const again = jev({ label: "travel", confidence: 1 });
    expect(await run([IDS.low], async () => models(again, haiku({ label: "travel", confidence: 1 })))).toEqual([{ id: IDS.low, code: "already_processed" }]);
    expect(again.calls).toHaveLength(0);
  });

  it("logs fallback=error when Jev throws, without the error text", async () => {
    const res = await run([IDS.fb2], async () => models(jev(new Error("RESPONSEBODY KEYMATERIAL")), haiku({ label: "travel", confidence: 0.5 })));
    expect(res[0]?.code).toBe("categorized");
    expect(logs).toContain(`essay-ingest: id=${IDS.fb2} code=categorized type=travel confidence=0.50 model=claude-haiku-5-5 fallback=error`);
  });

  it("an unknown label is provider_error and writes nothing", async () => {
    const before = await categories();
    const res = await run([IDS.bad], async () => models(jev({ label: "diary", confidence: 0.95 }), haiku({ label: "diary", confidence: 0.9 })));
    expect(res).toEqual([{ id: IDS.bad, code: "provider_error" }]);
    expect(await statusOf(IDS.bad)).toBe("pending_category");
    expect(await categories()).toEqual(before);
  });

  it("text_mismatch when the local copy differs from the stored text: nothing written, no provider call", async () => {
    writeFileSync(join(dir, String(IDS.mismatch), `${IDS.mismatch}-0.txt`), ESSAY.replace("special receipt", "different receipt"));
    const primary = jev({ label: "travel", confidence: 1 });
    expect(await run([IDS.mismatch], async () => models(primary, haiku({ label: "travel", confidence: 1 })))).toEqual([{ id: IDS.mismatch, code: "text_mismatch" }]);
    expect(primary.calls).toHaveLength(0);
    expect(await statusOf(IDS.mismatch)).toBe("pending_category");
  });

  it("caps the excerpt at 2000 words", async () => {
    const primary = jev({ label: "cultural", confidence: 0.95 });
    const res = await run([IDS.cap], async () => models(primary, haiku({ label: "cultural", confidence: 1 })));
    expect(res[0]?.code).toBe("categorized");
    const sent = primary.calls[0]?.input ?? "";
    expect(sent.split(/\s+/).filter(Boolean)).toHaveLength(EXCERPT_WORDS);
    expect(sent).not.toContain("padword2999");
    expect(sent.startsWith("Of Studies")).toBe(true);
  });

  it("provider errors give a fixed code and leak nothing", async () => {
    const boom = new Error("RESPONSEBODY Studies serve for delight KEYMATERIAL");
    const res = await run([IDS.perr], async () => models(jev(boom), haiku(boom)));
    expect(res).toEqual([{ id: IDS.perr, code: "provider_error" }]);
    expect(await statusOf(IDS.perr)).toBe("pending_category");
  });

  it("a failing models secret gives models_unavailable and leaks nothing", async () => {
    const res = await run([IDS.models], () =>
      modelsFromSecret(async () => {
        throw new Error("KEYMATERIAL RESPONSEBODY");
      }));
    expect(res).toEqual([{ id: IDS.models, code: "models_unavailable" }]);
    expect(await statusOf(IDS.models)).toBe("pending_category");
  });

  it("builds Jev and Haiku providers from the two secret keys without any network call", async () => {
    const read: string[] = [];
    const m = await modelsFromSecret(async (key) => {
      read.push(key);
      return "KEYMATERIAL";
    });
    expect(read.sort()).toEqual(["anthropic_api_key", "typesafe_api_key"]);
    expect([m.primary.name, m.fallback.name]).toEqual(["jev", "anthropic"]);
  });

  it("not stored, missing local file: fixed codes, nothing written", async () => {
    const primary = jev({ label: "travel", confidence: 1 });
    const res = await run([IDS.missing, IDS.noFile], async () => models(primary, haiku({ label: "travel", confidence: 1 })));
    expect(res.map((r) => r.code)).toEqual(["not_stored", "no_files"]);
    expect(primary.calls).toHaveLength(0);
  });

  it("does nothing while paused", async () => {
    const primary = jev({ label: "travel", confidence: 1 });
    const before = JSON.stringify([await categories(), await statusOf(IDS.bad)]);
    await setPaused(true);
    await expect(run([IDS.bad], async () => models(primary, haiku({ label: "travel", confidence: 1 })))).rejects.toThrow("pipelines_paused");
    await setPaused(false);
    expect(primary.calls).toHaveLength(0);
    expect(JSON.stringify([await categories(), await statusOf(IDS.bad)])).toBe(before);
  });

  it("never prints essay text, prompts, responses or keys", () => {
    const all = logs.join("\n");
    expect(all).toMatch(/id=301 code=categorized/);
    for (const l of LEAKS) expect(all).not.toContain(l);
  });
});

describe("CLI", () => {
  const scriptsDir = fileURLToPath(new URL("..", import.meta.url));
  it("the categorize phase refuses a non-PGlite target without --confirm, before connecting", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", "essay-ingest.ts", "--phase", "categorize", "--ids", "1342"], {
      cwd: scriptsDir, encoding: "utf8", timeout: 40_000,
      env: { ...process.env, DATABASE_URL: "postgres://u:p@10.255.255.1:5432/x" },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--confirm");
    expect(r.stderr).not.toContain("10.255.255.1");
  }, 60_000);
});
