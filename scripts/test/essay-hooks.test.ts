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
  HOOK_CORRECTIONS, HOOK_EXCERPT_WORDS, HOOK_MAX_CHARS, HOOK_PROMPT_CHARS, HOOK_SYSTEM, hooksPhase, validateHook, type HooksDeps,
} from "../lib/essay-hooks";

const FIXTURES = fileURLToPath(new URL("../../packages/essays/test/fixtures/gutenberg-text/", import.meta.url));
const ESSAY = readFileSync(join(FIXTURES, "essay.txt"), "utf8");
// Must never appear in output: essay text, the prompt, the produced hook, key material.
const LEAKS = ["Studies serve for delight", "wise men use them", "You write the one-line hook", "KEYMATERIAL", "RESPONSEBODY", "A quiet case for reading"];
const GOOD = "A quiet case for reading with a purpose instead of for show.";

describe("validateHook", () => {
  const ctx = { title: "Of Studies", author: "Francis Bacon", text: ESSAY };
  const run1 = (text: string, stop = "end", c = ctx) => validateHook({ text, stop }, c);
  /** The accepted hook, or null. */
  const ok = (text: string, stop = "end", c = ctx) => {
    const v = run1(text, stop, c);
    return "hook" in v ? v.hook : null;
  };
  const why = (text: string, stop = "end", c = ctx) => {
    const v = run1(text, stop, c);
    return "reason" in v ? v.reason : null;
  };

  it.each([
    ["stop", "A fine hook for reading.", "max_tokens", "stop"],
    ["stop", "A fine hook for reading.", "refusal", "stop"],
    ["empty", " \n ", "end", "empty"],
    ["too_long", "x".repeat(HOOK_MAX_CHARS + 1), "end", "too_long"],
    ["control_char", "First line.\nSecond line.", "end", "control_char"],
    ["control_char", "One\tline.", "end", "control_char"],
    ["markdown", "A **bold** claim about reading.", "end", "markdown"],
    ["markdown", "- reading is good for you.", "end", "markdown"],
    ["quote_edge", "“Reading is good for you.”", "end", "quote_edge"],
    ["copied_run", "Why studies serve for delight for ornament?", "end", "copied_run"],
    ["author_name", "What Bacon thought about reading.", "end", "author_name"],
    ["title", "A reflection on of studies and their use.", "end", "title"],
  ])("reason code %s for %j", (_n, text, stop, reason) => {
    expect(why(text, stop)).toBe(reason);
  });

  it("every correction sentence is fixed, one per retryable reason", () => {
    expect(Object.keys(HOOK_CORRECTIONS).sort()).toEqual(
      ["author_name", "control_char", "copied_run", "empty", "markdown", "quote_edge", "title", "too_long"]);
    expect(HOOK_CORRECTIONS.too_long).toContain("at most 120 characters");
    expect(HOOK_CORRECTIONS.author_name).toBe("Do not name the author.");
    expect(HOOK_CORRECTIONS.title).toBe("Do not repeat the title.");
    expect(HOOK_CORRECTIONS.copied_run).toBe("Use your own words; do not quote the essay.");
  });

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

  it.each([
    ["a straight pair", "\"Reading is good for you.\""],
    ["curly double quotes", "“Reading is good for you.”"],
    ["low-9 quotes", "„Reading is good for you.“"],
    ["single curly quotes", "‘Reading is good for you.’"],
    ["low-9 single quote", "‚Reading is good for you.‘"],
    ["guillemets", "«Reading is good for you.»"],
    ["reversed guillemets", "»Reading is good for you.«"],
  ])("rejects a hook wrapped in %s", (_n, text) => {
    expect(ok(text)).toBeNull();
  });

  it("the copied-run limit is 5 words: five consecutive essay words pass, six are rejected", () => {
    expect(ok("Do studies serve for delight for real?")).not.toBeNull(); // 5-word run "studies serve for delight for"
    expect(ok("Why studies serve for delight for ornament?")).toBeNull(); // 6-word run
  });

  it("rejects the author as a whole word, also as a possessive, and short name parts in their exact case", () => {
    expect(ok("Bacon's case for reading is quiet.")).toBeNull();
    expect(ok("Bacon’s case for reading is quiet.")).toBeNull();
    expect(ok("The case of BACON for reading is quiet.")).toBeNull();
    const lu = { title: "Plain Notes", author: "Lu Xun", text: "unrelated words" };
    expect(ok("Lu notes how people read.", "end", lu)).toBeNull();
    expect(ok("How Xun saw people read.", "end", lu)).toBeNull();
    expect(ok("How people read, lu aside.", "end", lu)).not.toBeNull();
    // a short common word equal to a lower-cased name part passes
    const an = { title: "Plain Notes", author: "An Wang", text: "unrelated words" };
    expect(ok("Why an essay on reading still matters.", "end", an)).not.toBeNull();
    expect(ok("An essay on reading still matters.", "end", an)).toBeNull();
    // a longer word that merely contains a name part is fine
    expect(ok("A baconian habit of mind, in short.")).not.toBeNull();
  });

  it("rejects the author name and a multi-word title, case-insensitively", () => {
    expect(ok("What Bacon thought about the value of reading.")).toBeNull();
    expect(ok("Why francis would read at all.")).toBeNull();
    expect(ok("A reflection on of studies and their use.")).toBeNull();
    expect(ok("A short word about walking.", "end", { ...ctx, title: "Walking" })).not.toBeNull();
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
  const everything: string[] = [];

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
      return await hooksPhase(ids, { db: fresh.db, dir, getModels, log: (l) => { logs.push(l); everything.push(l); } });
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
    // The store phase leaves essays pending_category; the hooks phase works on active ones.
    await q("UPDATE essays SET status = 'active' WHERE kind = 'full'");
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
    expect(res).toEqual([{ id: IDS.ok, code: "hooked", model: DEFAULT_DEEPSEEK_MODEL, calls: 1 }]);
    expect(await hookOf(IDS.ok)).toBe(GOOD);
    expect(primary.calls).toHaveLength(1);
    expect(primary.calls[0]?.op).toBe("complete");
    expect(logs).toContain(`essay-ingest: id=${IDS.ok} code=hooked model=${DEFAULT_DEEPSEEK_MODEL} calls=1`);
    expect(HOOK_SYSTEM).toContain(String(HOOK_PROMPT_CHARS));
  });

  it("is idempotent: an essay with a hook is already_processed and calls no provider", async () => {
    const primary = deepseek({ text: "A different hook that must not replace the first one." });
    expect(await run([IDS.ok], async () => primary)).toEqual([{ id: IDS.ok, code: "already_processed" }]);
    expect(primary.calls).toHaveLength(0);
    expect(await hookOf(IDS.ok)).toBe(GOOD);
  });

  it("an invalid reply is retried once; a second invalid reply is invalid_hook with the second reason and stores nothing", async () => {
    const cases = [
      { text: "", reason: "empty" },
      { text: "x".repeat(HOOK_MAX_CHARS + 1), reason: "too_long" },
      { text: "Line one.\nLine two.", reason: "control_char" },
      { text: "A **bold** claim.", reason: "markdown" },
      { text: "“Quoted hook.”", reason: "quote_edge" },
      { text: "What Bacon wanted readers to notice.", reason: "author_name" },
    ];
    for (const c of cases) {
      logs.length = 0;
      const primary = deepseek({ text: c.text });
      const res = await run([IDS.invalid], async () => primary);
      expect(res).toEqual([{ id: IDS.invalid, code: "invalid_hook", reason: c.reason, model: DEFAULT_DEEPSEEK_MODEL, calls: 2 }]);
      expect(primary.calls).toHaveLength(2);
      expect(logs).toEqual([`essay-ingest: id=${IDS.invalid} code=invalid_hook reason=${c.reason} model=${DEFAULT_DEEPSEEK_MODEL} calls=2`]);
      expect(await hookOf(IDS.invalid)).toBeNull();
    }
  });

  it("the retry adds one fixed sentence for the first reason, keeps the excerpt, and stores a valid second reply", async () => {
    const systems: string[] = [];
    const replies = ["What Bacon wanted readers to notice.", GOOD];
    const primary = deepseek((req) => {
      systems.push(req.system ?? "");
      return { text: replies[systems.length - 1] ?? "" };
    });
    logs.length = 0;
    const res = await run([IDS.invalid], async () => primary);
    expect(res).toEqual([{ id: IDS.invalid, code: "hooked", model: DEFAULT_DEEPSEEK_MODEL, calls: 2 }]);
    expect(await hookOf(IDS.invalid)).toBe(GOOD);
    expect(primary.calls).toHaveLength(2);
    expect(primary.calls[1]?.input).toBe(primary.calls[0]?.input);
    expect(systems[0]).toBe(HOOK_SYSTEM);
    expect(systems[1]).toBe(`${HOOK_SYSTEM} ${HOOK_CORRECTIONS.author_name}`);
    expect(logs).toEqual([`essay-ingest: id=${IDS.invalid} code=hooked model=${DEFAULT_DEEPSEEK_MODEL} calls=2`]);
    await q("UPDATE essays SET hook = NULL WHERE source_url = $1", [urlOf(IDS.invalid)]);
  });

  it("the second invalid reply's reason is the one reported", async () => {
    const replies = [{ text: "x".repeat(HOOK_MAX_CHARS + 1) }, { text: "What Bacon wanted readers to notice." }];
    let n = 0;
    const res = await run([IDS.invalid], async () => deepseek(() => replies[n++] ?? { text: "" }));
    expect(res).toEqual([{ id: IDS.invalid, code: "invalid_hook", reason: "author_name", model: DEFAULT_DEEPSEEK_MODEL, calls: 2 }]);
    expect(await hookOf(IDS.invalid)).toBeNull();
  });

  it("a reply that did not end (stop) is not retried", async () => {
    for (const stop of ["max_tokens", "refusal"] as const) {
      const primary = deepseek({ text: GOOD, stop });
      logs.length = 0;
      const res = await run([IDS.invalid], async () => primary);
      expect(res).toEqual([{ id: IDS.invalid, code: "invalid_hook", reason: "stop", model: DEFAULT_DEEPSEEK_MODEL, calls: 1 }]);
      expect(primary.calls).toHaveLength(1);
      expect(logs).toEqual([`essay-ingest: id=${IDS.invalid} code=invalid_hook reason=stop model=${DEFAULT_DEEPSEEK_MODEL} calls=1`]);
    }
    expect(await hookOf(IDS.invalid)).toBeNull();
  });

  it("a provider error on the retry is provider_error with calls=2 and stores nothing", async () => {
    let n = 0;
    const primary = deepseek(() => (n++ === 0 ? { text: "" } : new Error("RESPONSEBODY KEYMATERIAL")));
    logs.length = 0;
    const res = await run([IDS.invalid], async () => primary);
    expect(res).toEqual([{ id: IDS.invalid, code: "provider_error", calls: 2, model: DEFAULT_DEEPSEEK_MODEL }]);
    expect(logs).toEqual([`essay-ingest: id=${IDS.invalid} code=provider_error model=${DEFAULT_DEEPSEEK_MODEL} calls=2`]);
    expect(await hookOf(IDS.invalid)).toBeNull();
  });

  it("the system prompt asks for less than the validator accepts and states the rules", () => {
    expect(HOOK_PROMPT_CHARS).toBeLessThan(HOOK_MAX_CHARS);
    expect(HOOK_SYSTEM).toContain(`at most ${HOOK_PROMPT_CHARS} characters`);
    expect(HOOK_SYSTEM).not.toContain(String(HOOK_MAX_CHARS));
    for (const rule of ["one", "plain-text sentence", "own words", "do not name the author", "do not repeat the title", "no markdown"]) {
      expect(HOOK_SYSTEM.toLowerCase()).toContain(rule);
    }
  });

  it("a provider error is provider_error, leaks nothing and stores nothing", async () => {
    const res = await run([IDS.perr], async () => deepseek(new Error("RESPONSEBODY Studies serve for delight KEYMATERIAL")));
    expect(res).toEqual([{ id: IDS.perr, code: "provider_error", calls: 1 }]);
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

  it("a row quarantined during the model call gets no hook (changed_concurrently)", async () => {
    const primary = deepseek(async () => {
      await q("UPDATE essays SET status = 'quarantined' WHERE source_url = $1", [urlOf(IDS.stop)]);
      return { text: GOOD };
    });
    expect(await run([IDS.stop], async () => primary)).toEqual([{ id: IDS.stop, code: "changed_concurrently", model: DEFAULT_DEEPSEEK_MODEL, calls: 1 }]);
    expect(await hookOf(IDS.stop)).toBeNull();
    expect(await run([IDS.stop], async () => deepseek({ text: GOOD }))).toEqual([{ id: IDS.stop, code: "quarantined" }]);
  });

  it("a pending_category essay is not_active: no provider call", async () => {
    await q("UPDATE essays SET status = 'pending_category' WHERE source_url = $1", [urlOf(IDS.noFile)]);
    const primary = deepseek({ text: GOOD });
    expect(await run([IDS.noFile], async () => primary)).toEqual([{ id: IDS.noFile, code: "not_active" }]);
    expect(primary.calls).toHaveLength(0);
    await q("UPDATE essays SET status = 'active' WHERE source_url = $1", [urlOf(IDS.noFile)]);
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
    const all = everything.join("\n");
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
