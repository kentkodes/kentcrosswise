import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DEEPSEEK_MODEL, FakeProvider, type FakeProviderOptions } from "@kcw/core/models";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDb } from "../../packages/db/test/helpers";
import { registerGutenbergSource } from "../../packages/essays/src/registry/bootstrap";
import { syntheticBook } from "../../packages/essays/test/synthetic-book";
import { storePhase } from "../lib/essay-ingest";
import {
  HOOK_EXCERPT_WORDS, HOOK_MAX_CHARS, HOOK_SYSTEM, hooksPhase, validateHook, type HooksDeps,
} from "../lib/essay-hooks";

const FIXTURES = fileURLToPath(new URL("../../packages/essays/test/fixtures/gutenberg-text/", import.meta.url));
const ESSAY = readFileSync(join(FIXTURES, "essay.txt"), "utf8");
// Must never appear in output: essay text, the prompt, the produced hook, key material.
const LEAKS = ["Studies serve for delight", "wise men use them", "You write the one-line hook", "KEYMATERIAL", "RESPONSEBODY", "A quiet case for reading"];
const GOOD = "A quiet case for reading with a purpose instead of for show.";

describe("validateHook", () => {
  const ctx = { title: "Of Studies", author: "Francis Bacon", text: ESSAY };
  const ok = (text: string, stop = "end") => validateHook({ text, stop }, ctx);

  it("accepts one plain sentence and trims it", () => {
    expect(ok(`  ${GOOD}\n`)).toBe(GOOD);
    expect(ok("x".repeat(HOOK_MAX_CHARS))).toBe("x".repeat(HOOK_MAX_CHARS));
  });

  it.each([
    ["empty", ""],
    ["blank", " \n "],
    ["too long", "x".repeat(HOOK_MAX_CHARS + 1)],
    ["two lines", "First line.\nSecond line."],
    ["a control character", "One\tline."],
    ["markdown emphasis", "A **bold** claim about reading."],
    ["markdown heading", "# A heading about reading."],
    ["a list item", "- reading is good for you."],
    ["wrapped in quotes", "\"Reading is good for you.\""],
    ["a link", "Read [this](http://example.com) now."],
  ])("rejects %s", (_n, text) => {
    expect(ok(text)).toBeNull();
  });

  it("rejects a reply that did not end normally", () => {
    expect(ok(GOOD, "max_tokens")).toBeNull();
    expect(ok(GOOD, "refusal")).toBeNull();
  });

  it("rejects more than a few consecutive words of the essay but allows a short quotation", () => {
    expect(ok("Why studies serve for delight, for ornament, and for ability?")).toBeNull();
    expect(ok("What does it mean that studies serve for delight?")).not.toBeNull();
  });

  it("rejects the author name and a multi-word title, case-insensitively", () => {
    expect(ok("What Bacon thought about the value of reading.")).toBeNull();
    expect(ok("Why francis would read at all.")).toBeNull();
    expect(ok("A reflection on of studies and their use.")).toBeNull();
    expect(validateHook({ text: "A short word about walking.", stop: "end" }, { ...ctx, title: "Walking" })).not.toBeNull();
  });
});

describe("hooks phase on PGlite as a pipeline_rw member", () => {
  const LOGIN = "hooks_test_app";
  const IDS = { ok: 401, invalid: 402, perr: 403, models: 404, mismatch: 405, cap: 406, link: 407, missing: 408, noFile: 409, stop: 410 };
  const TITLES: Record<number, string> = {
    401: "Violet Harbour", 402: "Copper Lantern", 403: "Amber Meadow", 404: "Silver Orchard", 405: "Winter Compass",
    406: "Marble Anchor", 409: "Ember Falcon", 410: "Glacier Basket",
  };
  const tmp = mkdtempSync(join(tmpdir(), "kcw-essay-hooks-"));
  let fresh: Awaited<ReturnType<typeof freshDb>>;
  let dir: string;
  const logs: string[] = [];

  const q = async <T>(sql: string, params: unknown[] = []) => (await fresh.db.query<T>(sql, params)).rows;
  const urlOf = (id: number) => `https://www.gutenberg.org/ebooks/${id}`;
  const hookOf = async (id: number) => (await q<{ hook: string | null }>("SELECT hook FROM essays WHERE source_url = $1", [urlOf(id)]))[0]?.hook;
  const allHooks = async () => q<{ source_url: string; hook: string | null }>("SELECT source_url, hook FROM essays ORDER BY source_url");
  const setPaused = (v: boolean) =>
    q("INSERT INTO system_flags (key, value) VALUES ('pipelines_paused', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [String(v)]);
  const deepseek = (complete: FakeProviderOptions["complete"]) => new FakeProvider({ name: "deepseek", model: DEFAULT_DEEPSEEK_MODEL, complete });

  const run = async (ids: number[], getModels: HooksDeps["getModels"]) => {
    await fresh.db.exec(`SET ROLE ${LOGIN}`);
    try {
      return await hooksPhase(ids, { db: fresh.db, dir, getModels, log: (l) => logs.push(l) });
    } finally {
      await fresh.db.exec("RESET ROLE");
    }
  };

  function writeBook(id: number, extraWords = 0): void {
    mkdirSync(join(dir, String(id)), { recursive: true });
    const extra = extraWords ? `\n\n${Array.from({ length: extraWords }, (_, i) => `padword${i}`).join(" ")}\n\n` : "";
    const base = id === IDS.ok
      ? ESSAY.replace("special receipt", `special receipt ${id}`)
      : syntheticBook(ESSAY, `book-${id}`, 420, "Of Studies\nby Francis Bacon\n\n");
    writeFileSync(join(dir, String(id), `${id}-0.txt`), base.replace("*** END OF", `${extra}*** END OF`));
  }

  beforeAll(async () => {
    fresh = await freshDb();
    dir = join(tmp, "books");
    const sourceId = (await registerGutenbergSource(fresh.db)).id;
    await fresh.db.exec(`CREATE ROLE ${LOGIN} LOGIN; GRANT pipeline_rw TO ${LOGIN};`);
    await setPaused(false);
    const stored = [IDS.ok, IDS.invalid, IDS.perr, IDS.models, IDS.mismatch, IDS.cap, IDS.noFile, IDS.stop];
    for (const id of stored) {
      const seed = await q<{ id: string }>(
        "INSERT INTO seed_items (title, author, year, status) VALUES ($1, 'Francis Bacon', 1625, 'approved') RETURNING id", [TITLES[id]]);
      await q(
        `INSERT INTO seed_source_links (seed_item_id, source_id, candidate_url, candidate_title, candidate_author, tier, score, status)
         VALUES ($1, $2, $3, 't', 'a', 'A', 1, 'approved')`, [seed[0]?.id, sourceId, urlOf(id)]);
      writeBook(id, id === IDS.cap ? 3000 : 0);
    }
    const res = await storePhase(stored, { db: fresh.db, putObject: async () => undefined, dir, log: () => undefined });
    expect(res.every((r) => r.code === "stored")).toBe(true);
    rmSync(join(dir, String(IDS.noFile)), { recursive: true, force: true });
    await q("INSERT INTO essays (kind, title, author, source_url, status) VALUES ('link', 'Link Piece', 'Some Writer', $1, 'active')", [urlOf(IDS.link)]);
  });
  afterAll(async () => {
    await fresh.pg.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("stores one validated hook and reports the returned model id", async () => {
    const primary = deepseek({ text: `${GOOD}\n` });
    const res = await run([IDS.ok], async () => primary);
    expect(res).toEqual([{ id: IDS.ok, code: "hooked", model: DEFAULT_DEEPSEEK_MODEL }]);
    expect(await hookOf(IDS.ok)).toBe(GOOD);
    expect(primary.calls).toHaveLength(1);
    expect(primary.calls[0]?.op).toBe("complete");
    expect(logs).toContain(`essay-ingest: id=${IDS.ok} code=hooked model=${DEFAULT_DEEPSEEK_MODEL}`);
    expect(HOOK_SYSTEM).toContain(String(HOOK_MAX_CHARS));
  });

  it("is idempotent: an essay with a hook is already_processed and calls no provider", async () => {
    const primary = deepseek({ text: "A different hook that must not replace the first one." });
    expect(await run([IDS.ok], async () => primary)).toEqual([{ id: IDS.ok, code: "already_processed" }]);
    expect(primary.calls).toHaveLength(0);
    expect(await hookOf(IDS.ok)).toBe(GOOD);
  });

  it("an invalid reply is invalid_hook and stores nothing (empty, long, multi-line, author, cut off)", async () => {
    const replies = [
      { text: "" },
      { text: "x".repeat(HOOK_MAX_CHARS + 1) },
      { text: "Line one.\nLine two." },
      { text: "What Bacon wanted readers to notice." },
      { text: GOOD, stop: "max_tokens" as const },
      { text: GOOD, stop: "refusal" as const },
    ];
    for (const reply of replies) {
      const res = await run([IDS.invalid], async () => deepseek(reply));
      expect(res).toEqual([{ id: IDS.invalid, code: "invalid_hook", model: DEFAULT_DEEPSEEK_MODEL }]);
      expect(await hookOf(IDS.invalid)).toBeNull();
    }
  });

  it("a provider error is provider_error, leaks nothing and stores nothing", async () => {
    const res = await run([IDS.perr], async () => deepseek(new Error("RESPONSEBODY Studies serve for delight KEYMATERIAL")));
    expect(res).toEqual([{ id: IDS.perr, code: "provider_error" }]);
    expect(await hookOf(IDS.perr)).toBeNull();
  });

  it("a failing models secret is models_unavailable", async () => {
    const res = await run([IDS.models], async () => {
      throw new Error("KEYMATERIAL RESPONSEBODY");
    });
    expect(res).toEqual([{ id: IDS.models, code: "models_unavailable" }]);
    expect(await hookOf(IDS.models)).toBeNull();
  });

  it("text_mismatch when the local copy differs from the stored text: no provider call", async () => {
    writeFileSync(join(dir, String(IDS.mismatch), `${IDS.mismatch}-0.txt`), ESSAY.replace("special receipt", "different receipt"));
    const primary = deepseek({ text: GOOD });
    expect(await run([IDS.mismatch], async () => primary)).toEqual([{ id: IDS.mismatch, code: "text_mismatch" }]);
    expect(primary.calls).toHaveLength(0);
    expect(await hookOf(IDS.mismatch)).toBeNull();
  });

  it("sends at most the first HOOK_EXCERPT_WORDS words", async () => {
    const primary = deepseek({ text: GOOD });
    expect((await run([IDS.cap], async () => primary))[0]?.code).toBe("hooked");
    const sent = primary.calls[0]?.input ?? "";
    expect(sent.split(/\s+/).filter(Boolean)).toHaveLength(HOOK_EXCERPT_WORDS);
    expect(sent).not.toContain("padword2999");
  });

  it("link-only essays get no hook and no provider call; unknown ids and missing files have fixed codes", async () => {
    const primary = deepseek({ text: GOOD });
    const res = await run([IDS.link, IDS.missing, IDS.noFile], async () => primary);
    expect(res.map((r) => r.code)).toEqual(["link_only", "not_stored", "no_files"]);
    expect(primary.calls).toHaveLength(0);
    expect(await hookOf(IDS.link)).toBeNull();
  });

  it("does nothing while paused", async () => {
    const primary = deepseek({ text: GOOD });
    const before = JSON.stringify(await allHooks());
    await setPaused(true);
    await expect(run([IDS.stop], async () => primary)).rejects.toThrow("pipelines_paused");
    await setPaused(false);
    expect(primary.calls).toHaveLength(0);
    expect(JSON.stringify(await allHooks())).toBe(before);
  });

  it("never prints essay text, the prompt, the hook, responses or keys", () => {
    const all = logs.join("\n");
    expect(all).toMatch(/id=401 code=hooked/);
    for (const l of LEAKS) expect(all).not.toContain(l);
  });
});

describe("CLI", () => {
  const scriptsDir = fileURLToPath(new URL("..", import.meta.url));
  it("the hooks phase refuses a non-PGlite target without --confirm, before connecting", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", "essay-ingest.ts", "--phase", "hooks", "--ids", "1342"], {
      cwd: scriptsDir, encoding: "utf8", timeout: 40_000,
      env: { ...process.env, DATABASE_URL: "postgres://u:p@10.255.255.1:5432/x" },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--confirm");
    expect(r.stderr).not.toContain("10.255.255.1");
  }, 60_000);

  it("the hooks phase still needs book ids; the acceptance phase does not", () => {
    const hooks = spawnSync(process.execPath, ["--import", "tsx", "essay-ingest.ts", "--phase", "hooks", "--confirm"], {
      cwd: scriptsDir, encoding: "utf8", timeout: 40_000,
    });
    expect(hooks.status).toBe(1);
    expect(hooks.stderr).toContain("no_book_ids");
    const acc = spawnSync(process.execPath, ["--import", "tsx", "essay-ingest.ts", "--phase", "acceptance"], {
      cwd: scriptsDir, encoding: "utf8", timeout: 40_000, env: { ...process.env, DATABASE_URL: "" },
    });
    expect(acc.stderr).not.toContain("no_book_ids");
    expect(acc.stderr).toContain("No database");
  }, 60_000);
});
