import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DEEPSEEK_MODEL, FakeProvider, type FakeProviderOptions } from "@kcw/core/models";
import { SecretKeyMissingError } from "@kcw/secrets";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { freshDb } from "../../packages/db/test/helpers";
import { registerGutenbergSource } from "../../packages/essays/src/registry/bootstrap";
import {
  EXCERPT_WORDS, ESSAY_TYPES, categorizePhase, modelsFromSecret, type CategorizeDeps,
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
  const IDS = { ok: 301, low: 302, mismatch: 303, perr: 304, models: 305, cap: 306, missing: 308, noFile: 309, bad: 311, unsafe: 312 };
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

  const deepseek = (classify: FakeProviderOptions["classify"]) => new FakeProvider({ name: "deepseek", model: DEFAULT_DEEPSEEK_MODEL, classify });

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
    const stored = [IDS.ok, IDS.low, IDS.mismatch, IDS.perr, IDS.models, IDS.cap, IDS.noFile, IDS.bad, IDS.unsafe];
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
    const primary = deepseek({ label: "argumentative", confidence: 0.91 });
    const res = await run([IDS.ok], async () => primary);
    expect(res).toEqual([{ id: IDS.ok, code: "categorized", type: "argumentative", confidence: 0.91, model: DEFAULT_DEEPSEEK_MODEL }]);
    expect(await statusOf(IDS.ok)).toBe("active");
    expect(await categories()).toEqual([{ type: "argumentative", confidence: expect.closeTo(0.91, 5), model: DEFAULT_DEEPSEEK_MODEL, source_url: urlOf(IDS.ok) }]);
    expect(primary.calls).toHaveLength(1);
    expect(primary.calls[0]?.labels).toEqual([
      "argumentative", "critical", "comedic", "creative_lyric", "personal_memoir",
      "philosophical", "political", "science_nature", "cultural", "travel",
    ]);
    expect([...ESSAY_TYPES]).toEqual(primary.calls[0]?.labels);
    expect(logs).toContain(`essay-ingest: id=${IDS.ok} code=categorized type=argumentative confidence=0.91 model=${DEFAULT_DEEPSEEK_MODEL}`);
  });

  it("rerun is a no-op and calls no provider", async () => {
    const primary = deepseek({ label: "travel", confidence: 1 });
    const before = await categories();
    expect(await run([IDS.ok], async () => primary)).toEqual([{ id: IDS.ok, code: "already_processed" }]);
    expect(primary.calls).toHaveLength(0);
    expect(await categories()).toEqual(before);
  });

  it("a low-confidence answer is accepted as is: stored with its confidence, essay active", async () => {
    const res = await run([IDS.low], async () => deepseek({ label: "cultural", confidence: 0.2 }));
    expect(res).toEqual([{ id: IDS.low, code: "categorized", type: "cultural", confidence: 0.2, model: DEFAULT_DEEPSEEK_MODEL }]);
    expect(await statusOf(IDS.low)).toBe("active");
    expect((await categories()).find((c) => c.source_url === urlOf(IDS.low))).toEqual(
      { type: "cultural", confidence: expect.closeTo(0.2, 5), model: DEFAULT_DEEPSEEK_MODEL, source_url: urlOf(IDS.low) });
    expect(logs).toContain(`essay-ingest: id=${IDS.low} code=categorized type=cultural confidence=0.20 model=${DEFAULT_DEEPSEEK_MODEL}`);
    const again = deepseek({ label: "travel", confidence: 1 });
    expect(await run([IDS.low], async () => again)).toEqual([{ id: IDS.low, code: "already_processed" }]);
    expect(again.calls).toHaveLength(0);
  });

  it("an unsafe returned model id is printed as unknown but stored as returned", async () => {
    const res = await run([IDS.unsafe], async () => deepseek({ label: "travel", confidence: 0.5, model: "evil\n::error::x" }));
    expect(res[0]).toMatchObject({ code: "categorized", model: "unknown" });
    expect(logs).toContain(`essay-ingest: id=${IDS.unsafe} code=categorized type=travel confidence=0.50 model=unknown`);
  });

  it("an unknown label is provider_error and writes nothing", async () => {
    const before = await categories();
    const res = await run([IDS.bad], async () => deepseek({ label: "diary", confidence: 0.95 }));
    expect(res).toEqual([{ id: IDS.bad, code: "provider_error" }]);
    expect(await statusOf(IDS.bad)).toBe("pending_category");
    expect(await categories()).toEqual(before);
  });

  it("text_mismatch when the local copy differs from the stored text: nothing written, no provider call", async () => {
    writeFileSync(join(dir, String(IDS.mismatch), `${IDS.mismatch}-0.txt`), ESSAY.replace("special receipt", "different receipt"));
    const primary = deepseek({ label: "travel", confidence: 1 });
    expect(await run([IDS.mismatch], async () => primary)).toEqual([{ id: IDS.mismatch, code: "text_mismatch" }]);
    expect(primary.calls).toHaveLength(0);
    expect(await statusOf(IDS.mismatch)).toBe("pending_category");
  });

  it("caps the excerpt at 2000 words", async () => {
    const primary = deepseek({ label: "cultural", confidence: 0.95 });
    const res = await run([IDS.cap], async () => primary);
    expect(res[0]?.code).toBe("categorized");
    const sent = primary.calls[0]?.input ?? "";
    expect(sent.split(/\s+/).filter(Boolean)).toHaveLength(EXCERPT_WORDS);
    expect(sent).not.toContain("padword2999");
    expect(sent.startsWith("Of Studies")).toBe(true);
  });

  it("provider errors give a fixed code and leak nothing", async () => {
    const boom = new Error("RESPONSEBODY Studies serve for delight KEYMATERIAL");
    const res = await run([IDS.perr], async () => deepseek(boom));
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

  it("builds the DeepSeek provider from the secret keys; the base URL and model keys are optional", async () => {
    const read: string[] = [];
    const m = await modelsFromSecret(async (key) => {
      read.push(key);
      return "KEYMATERIAL";
    });
    expect(read.sort()).toEqual(["deepseek_api_key", "deepseek_base_url", "deepseek_model"]);
    expect(m.name).toBe("deepseek");
    // a secret without the optional key still builds; a missing required key fails
    const noUrl = await modelsFromSecret(async (key) => {
      if (key === "deepseek_base_url") throw new SecretKeyMissingError("kcw/prod/models", key);
      return "KEYMATERIAL";
    });
    expect(noUrl.name).toBe("deepseek");
    await expect(modelsFromSecret(async (key) => {
      throw new SecretKeyMissingError("kcw/prod/models", key);
    })).rejects.toBeInstanceOf(SecretKeyMissingError);
  });

  const MISSING = Symbol("missing");
  it.each([
    ["both optional keys missing", MISSING, MISSING, "https://api.deepseek.com/chat/completions", "deepseek-flash"],
    ["both optional keys blank", "  ", "", "https://api.deepseek.com/chat/completions", "deepseek-flash"],
    ["both optional keys set", "https://gw.example.com/v1", " deepseek/dated-id ", "https://gw.example.com/v1/chat/completions", "deepseek/dated-id"],
    ["only the model set", MISSING, "deepseek-v4-pro", "https://api.deepseek.com/chat/completions", "deepseek-v4-pro"],
  ])("with %s calls the right URL and model (fake fetch, no network)", async (_n, url, model, expectedUrl, expectedModel) => {
    const calls: { url: string; model: string }[] = [];
    vi.stubGlobal("fetch", async (u: string, init: RequestInit) => {
      calls.push({ url: u, model: (JSON.parse(init.body as string) as { model: string }).model });
      const args = JSON.stringify({ label: "travel", confidence: 0.9 });
      return Response.json({ model: "returned-id", choices: [{ message: { tool_calls: [{ function: { name: "record_label", arguments: args } }] } }] });
    });
    try {
      const m = await modelsFromSecret(async (key) => {
        const v = key === "deepseek_base_url" ? url : key === "deepseek_model" ? model : "KEYMATERIAL";
        if (v === MISSING) throw new SecretKeyMissingError("kcw/prod/models", key);
        return v as string;
      });
      const out = await m.classify("text", ESSAY_TYPES);
      expect(out).toMatchObject({ label: "travel", model: "returned-id" });
      expect(calls).toEqual([{ url: expectedUrl, model: expectedModel }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("not stored, missing local file: fixed codes, nothing written", async () => {
    const primary = deepseek({ label: "travel", confidence: 1 });
    const res = await run([IDS.missing, IDS.noFile], async () => primary);
    expect(res.map((r) => r.code)).toEqual(["not_stored", "no_files"]);
    expect(primary.calls).toHaveLength(0);
  });

  it("does nothing while paused", async () => {
    const primary = deepseek({ label: "travel", confidence: 1 });
    const before = JSON.stringify([await categories(), await statusOf(IDS.bad)]);
    await setPaused(true);
    await expect(run([IDS.bad], async () => primary)).rejects.toThrow("pipelines_paused");
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
