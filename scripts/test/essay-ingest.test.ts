import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDb } from "../../packages/db/test/helpers";
import { registerGutenbergSource } from "../../packages/essays/src/registry/bootstrap";
import {
  fetchPhase, IngestError, mapRsyncExit, MIRRORS, parseIds, rsyncCommand, spawnRunner, storePhase,
  type RunRsync, type StoreDeps,
} from "../lib/essay-ingest";
import { createTextObjectWriter } from "../lib/pipelines/aws";

const FIXTURES = fileURLToPath(new URL("../../packages/essays/test/fixtures/gutenberg-text/", import.meta.url));
const fixture = (name: string) => join(FIXTURES, name);
// Phrases from the public-domain fixture body: none may ever appear in output.
const LEAKS = ["Studies serve for delight", "wise men use them", "Bowling is good", "special receipt"];

const tmp = mkdtempSync(join(tmpdir(), "kcw-essay-ingest-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** `<root>/<id>/<name>` from a fixture file or literal bytes. */
function putFile(root: string, id: number, name: string, from: string | Uint8Array): void {
  mkdirSync(join(root, String(id)), { recursive: true });
  if (typeof from === "string") copyFileSync(fixture(from), join(root, String(id), name));
  else writeFileSync(join(root, String(id), name), from);
}

describe("ids", () => {
  it("accepts plain ids, de-duplicates, and refuses anything else without echoing it", () => {
    expect(parseIds("1342 84,1342  7")).toEqual([1342, 84, 7]);
    for (const bad of ["", "  ", "1342 ; rm -rf /", "0", "../1", "12345678", "abc"]) expect(() => parseIds(bad)).toThrow(IngestError);
    try {
      parseIds("secret-looking-value");
    } catch (e) {
      expect((e as Error).message).toBe("invalid_book_id");
    }
  });
});

describe("rsync command and exit codes", () => {
  it("builds the section 12.5 argument vector (no shell, one directory)", () => {
    expect(rsyncCommand("rsync.ibiblio.org", 12345, "/tmp/g/12345")).toEqual({
      command: "timeout",
      args: [
        "300", "rsync", "-rt", "--no-motd", "--contimeout=30", "--timeout=60", "--bwlimit=500", "--max-size=25m",
        "--include=*.txt", "--exclude=*",
        "rsync://rsync.ibiblio.org/gutenberg/1/2/3/4/12345/",
        "/tmp/g/12345/",
      ],
    });
    expect(rsyncCommand("gutenberg.pglaf.org", 7, "/tmp/g/7/").args.slice(-2)).toEqual(["rsync://gutenberg.pglaf.org/gutenberg/0/7/", "/tmp/g/7/"]);
    expect(MIRRORS).toEqual(["rsync.ibiblio.org", "gutenberg.pglaf.org"]);
  });

  it("maps exit codes to fixed codes", () => {
    const cases: Array<[number | null, string | null]> = [
      [0, null], [24, null], [10, "mirror_unreachable"], [5, "mirror_refused"], [12, "mirror_refused"],
      [30, "timeout"], [35, "timeout"], [124, "timeout"], [23, "no_files"], [1, "rsync_failed"], [127, "rsync_failed"], [null, "rsync_failed"],
    ];
    for (const [exit, code] of cases) expect(mapRsyncExit(exit)).toBe(code);
  });

  it("the real runner spawns without a shell and reports the exit code (node stands in for rsync)", async () => {
    expect(await spawnRunner({ command: process.execPath, args: ["-e", "process.exit(3)"] })).toEqual({ exitCode: 3 });
    expect(await spawnRunner({ command: "kcw-no-such-command-xyz", args: [] })).toEqual({ exitCode: null });
    // Shell metacharacters are plain arguments.
    expect(await spawnRunner({ command: process.execPath, args: ["-e", "process.exit(process.argv[1] === '; exit 9' ? 0 : 1)", "; exit 9"] })).toEqual({ exitCode: 0 });
  });
});

describe("fetch phase (fake runner, no network)", () => {
  /** A runner that records commands and answers per call; `write` puts files in the destination. */
  function runner(answers: Array<{ exit: number; write?: (dest: string) => void }>) {
    const calls: string[][] = [];
    const run: RunRsync = async (cmd) => {
      const a = answers[Math.min(calls.length, answers.length - 1)] as { exit: number; write?: (dest: string) => void };
      calls.push(cmd.args);
      a.write?.(cmd.args[cmd.args.length - 1] as string);
      return { exitCode: a.exit };
    };
    return { run, calls };
  }
  const base = (log: string[], run: RunRsync, dir: string, sleeps: number[] = []) => ({
    runRsync: run, dir, log: (l: string) => log.push(l), sleep: async (ms: number) => void sleeps.push(ms),
  });
  const writeTo = (name: string, from: string, id: number) => (dest: string) => copyFileSync(fixture(from), join(dest, name.replace("ID", String(id))));

  it("falls back to the second mirror after a connection-class failure and reports a verdict", async () => {
    const dir = join(tmp, "fetch-a");
    const r = runner([{ exit: 10 }, { exit: 0, write: writeTo("ID-0.txt", "essay.txt", 101) }]);
    const log: string[] = [];
    const res = await fetchPhase([101], base(log, r.run, dir));
    expect(res).toEqual([{ id: 101, code: null, verdict: "ok" }]);
    expect(r.calls.map((c) => c[10])).toEqual(["rsync://rsync.ibiblio.org/gutenberg/1/0/101/", "rsync://gutenberg.pglaf.org/gutenberg/1/0/101/"]);
    expect(log.join("\n")).toMatch(/mirror=rsync.ibiblio.org rsync_exit=10 code=mirror_unreachable/);
    expect(log.join("\n")).toMatch(/files=1 picked=101-0\.txt bytes=\d+ words=\d+ verdict=ok/);
  });

  it("stops after both mirrors refuse or time out, with the last fixed code", async () => {
    const r = runner([{ exit: 5 }, { exit: 124 }]);
    const res = await fetchPhase([102], base([], r.run, join(tmp, "fetch-b")));
    expect(res).toEqual([{ id: 102, code: "timeout", verdict: null }]);
    expect(r.calls).toHaveLength(2);
  });

  it("does not try the second mirror when the book is simply missing", async () => {
    const r = runner([{ exit: 23 }]);
    expect(await fetchPhase([103], base([], r.run, join(tmp, "fetch-c")))).toEqual([{ id: 103, code: "no_files", verdict: null }]);
    expect(r.calls).toHaveLength(1);
  });

  it("maps a clean exit with no .txt to no_files and a latin-1-only book to no_usable_text", async () => {
    expect(await fetchPhase([104], base([], runner([{ exit: 0 }]).run, join(tmp, "fetch-d")))).toEqual([{ id: 104, code: "no_files", verdict: null }]);
    const only8 = runner([{ exit: 0, write: writeTo("ID-8.txt", "essay.txt", 105) }]);
    expect(await fetchPhase([105], base([], only8.run, join(tmp, "fetch-e")))).toEqual([{ id: 105, code: "no_usable_text", verdict: null }]);
  });

  it("never prints raw mirror file names (no workflow-command injection)", async () => {
    const hostile = `x${String.fromCharCode(10)}::set-output name=pwn::1.txt`;
    const log: string[] = [];
    const r = runner([{ exit: 0, write: (dest) => {
      copyFileSync(fixture("essay.txt"), join(dest, "108-0.txt"));
      try { writeFileSync(join(dest, hostile), "junk"); } catch { /* the OS refuses such names (Windows): nothing to inject */ }
    } }]);
    await fetchPhase([108], base(log, r.run, join(tmp, "fetch-g")));
    const out = log.join(String.fromCharCode(10));
    expect(out).not.toContain("::set-output");
    expect(out).not.toContain("pwn");
    expect(out).toMatch(/files=[0-9]+ picked=108-0[.]txt bytes=[0-9]+ words=[0-9]+ verdict=ok/);
  });

  it("goes one book at a time with a 10 s pause between books, and an invalid book still reports a verdict", async () => {
    const dir = join(tmp, "fetch-f");
    const sleeps: number[] = [];
    const log: string[] = [];
    const answers = [
      { exit: 0, write: writeTo("ID-0.txt", "essay.txt", 106) },
      { exit: 0, write: writeTo("ID-0.txt", "truncated.txt", 107) },
    ];
    const r = runner(answers);
    const res = await fetchPhase([106, 107], base(log, r.run, dir, sleeps));
    expect(res.map((x) => x.verdict)).toEqual(["ok", "invalid"]);
    expect(sleeps).toEqual([10_000]);
    expect(log.join("\n")).toMatch(/verdict=invalid reasons=missing_end_marker/);
    for (const l of LEAKS) expect(log.join("\n")).not.toContain(l);
  });
});

describe("store phase on PGlite as a pipeline_rw member", () => {
  const LOGIN = "ingest_test_app";
  const IDS = { ok: 201, dup: 202, trunc: 203, stub: 204, garbled: 205, none: 206, only8: 207, latin1: 208, unapproved: 209, nolink: 210, crash: 211 };
  let fresh: Awaited<ReturnType<typeof freshDb>>;
  let dir: string;
  let sourceId: string;
  const objects = new Map<string, string>();
  const puts: string[] = [];
  const logs: string[] = [];

  const q = async <T>(sql: string, params: unknown[] = []) => (await fresh.db.query<T>(sql, params)).rows;
  const putObject = async (key: string, body: Uint8Array) => {
    puts.push(key);
    objects.set(key, Buffer.from(body).toString("utf8"));
  };
  const deps = (over: Partial<StoreDeps> = {}): StoreDeps => ({ db: fresh.db, putObject, dir, log: (l) => logs.push(l), ...over });
  /** Runs `fn` as the login (a plain member of pipeline_rw, INHERIT), then back as the superuser. */
  async function asIngest<T>(fn: () => Promise<T>): Promise<T> {
    await fresh.db.exec(`SET ROLE ${LOGIN}`);
    try {
      return await fn();
    } finally {
      await fresh.db.exec("RESET ROLE");
    }
  }
  const run = (ids: number[], over: Partial<StoreDeps> = {}) => asIngest(() => storePhase(ids, deps(over)));
  const urlOf = (id: number) => `https://www.gutenberg.org/ebooks/${id}`;
  const setPaused = (v: boolean) =>
    q("INSERT INTO system_flags (key, value) VALUES ('pipelines_paused', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [String(v)]);
  const counts = async () => ({
    essays: Number((await q<{ n: string }>("SELECT count(*) AS n FROM essays"))[0]?.n),
    quarantine: Number((await q<{ n: string }>("SELECT count(*) AS n FROM quarantine"))[0]?.n),
  });
  const urlRow = async (id: number) => (await q<{ status: string; attempts: number }>("SELECT status, attempts FROM essay_urls WHERE url = $1", [urlOf(id)]))[0];

  beforeAll(async () => {
    fresh = await freshDb();
    dir = join(tmp, "store");
    sourceId = (await registerGutenbergSource(fresh.db)).id;
    await fresh.db.exec(`CREATE ROLE ${LOGIN} LOGIN; GRANT pipeline_rw TO ${LOGIN};`);
    await setPaused(false);
    for (const id of Object.values(IDS)) {
      const status = id === IDS.unapproved ? "proposed" : "approved";
      if (id === IDS.nolink) continue;
      const seed = await q<{ id: string }>(
        "INSERT INTO seed_items (title, author, year, status) VALUES ($1, 'Francis Bacon', 1625, 'approved') RETURNING id", [`Seed title ${id}`]);
      await q(
        `INSERT INTO seed_source_links (seed_item_id, source_id, candidate_url, candidate_title, candidate_author, tier, score, status)
         VALUES ($1, $2, $3, 't', 'a', 'A', 1, $4)`, [seed[0]?.id, sourceId, urlOf(id), status]);
    }
    putFile(dir, IDS.ok, `${IDS.ok}-0.txt`, "essay.txt");
    putFile(dir, IDS.dup, `${IDS.dup}.txt`, "legacy.txt"); // same text as the essay fixture
    putFile(dir, IDS.trunc, `${IDS.trunc}-0.txt`, "truncated.txt");
    putFile(dir, IDS.stub, `${IDS.stub}-0.txt`, "stub.txt");
    putFile(dir, IDS.garbled, `${IDS.garbled}-0.txt`, "replacement.txt");
    mkdirSync(join(dir, String(IDS.none)), { recursive: true });
    putFile(dir, IDS.only8, `${IDS.only8}-8.txt`, "essay.txt");
    putFile(dir, IDS.latin1, `${IDS.latin1}.txt`, Uint8Array.from([0x63, 0x61, 0x66, 0xe9]));
    putFile(dir, IDS.unapproved, `${IDS.unapproved}-0.txt`, "essay.txt");
    putFile(dir, IDS.nolink, `${IDS.nolink}-0.txt`, "essay.txt");
    // A different text, so it is not a duplicate of the first book.
    mkdirSync(join(dir, String(IDS.crash)), { recursive: true });
    writeFileSync(
      join(dir, String(IDS.crash), `${IDS.crash}-0.txt`),
      readFileSync(fixture("essay.txt"), "utf8").replace("Studies serve", "Studies truly serve"),
    );
  });
  afterAll(async () => {
    await fresh.pg.close();
  });

  it("stores a valid book: one object, one essays row, URL fetched, a console-ready row", async () => {
    const res = await run([IDS.ok]);
    expect(res).toEqual([{ id: IDS.ok, code: "stored" }]);
    const [row] = await q<Record<string, unknown>>("SELECT * FROM essays");
    const body = [...objects.values()][0] as string;
    const sha = createHash("sha256").update(body).digest("hex");
    expect(objects.size).toBe(1);
    expect([...objects.keys()]).toEqual([`essays/text/${sha}.txt`]);
    expect(row).toMatchObject({
      kind: "full", status: "pending_category", title: `Seed title ${IDS.ok}`, author: "Francis Bacon", year: 1625, language: "en",
      source_id: sourceId, source_url: urlOf(IDS.ok), text_hash: sha, text_s3_key: `essays/text/${sha}.txt`,
    });
    expect(Number(row?.word_count)).toBeGreaterThanOrEqual(300);
    expect(await urlRow(IDS.ok)).toEqual({ status: "fetched", attempts: 0 });
    const url = (await q<Record<string, unknown>>("SELECT * FROM essay_urls WHERE url = $1", [urlOf(IDS.ok)]))[0];
    expect(url).toMatchObject({ source_id: sourceId, seed_item_id: row?.seed_item_id });
    expect(url?.url_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rerun is a no-op: one object, one row, no second put", async () => {
    const before = puts.length;
    expect(await run([IDS.ok])).toEqual([{ id: IDS.ok, code: "already_processed" }]);
    expect(puts.length).toBe(before);
    expect(objects.size).toBe(1);
    expect((await counts()).essays).toBe(1);
  });

  it("records the same text under another book as a duplicate (URL fetched, no second row or object)", async () => {
    expect(await run([IDS.dup])).toEqual([{ id: IDS.dup, code: "duplicate" }]);
    expect(await urlRow(IDS.dup)).toEqual({ status: "fetched", attempts: 0 });
    expect((await counts()).essays).toBe(1);
    expect(objects.size).toBe(1);
    expect((await q("SELECT 1 FROM essays WHERE source_url = $1", [urlOf(IDS.dup)])).length).toBe(0);
  });

  it("quarantines invalid books with fixed reason codes and stores nothing", async () => {
    const putsBefore = puts.length;
    const res = await run([IDS.trunc, IDS.stub, IDS.garbled]);
    expect(res.map((r) => r.code)).toEqual(["quarantined", "quarantined", "quarantined"]);
    expect(puts.length).toBe(putsBefore);
    const rows = await q<{ essay_url: string; reasons: string[] }>("SELECT essay_url, reasons FROM quarantine ORDER BY essay_url");
    expect(rows).toEqual([
      { essay_url: urlOf(IDS.trunc), reasons: ["missing_end_marker"] },
      { essay_url: urlOf(IDS.stub), reasons: ["too_short"] },
      { essay_url: urlOf(IDS.garbled), reasons: ["bad_characters"] },
    ]);
    expect((await urlRow(IDS.trunc))?.status).toBe("quarantined");
    // A quarantined book is not retried.
    expect(await run([IDS.trunc])).toEqual([{ id: IDS.trunc, code: "already_processed" }]);
    expect((await counts()).quarantine).toBe(3);
  });

  it("counts an attempt for no files or no usable encoding, failing at MAX_URL_ATTEMPTS, with no quarantine row", async () => {
    const q0 = (await counts()).quarantine;
    expect(await run([IDS.none, IDS.only8, IDS.latin1])).toEqual([
      { id: IDS.none, code: "no_files" }, { id: IDS.only8, code: "no_usable_text" }, { id: IDS.latin1, code: "no_usable_text" },
    ]);
    expect(await urlRow(IDS.none)).toEqual({ status: "new", attempts: 1 });
    for (let i = 0; i < 4; i++) await run([IDS.none]);
    expect(await urlRow(IDS.none)).toEqual({ status: "failed", attempts: 5 });
    expect((await counts()).quarantine).toBe(q0);
  });

  it("writes nothing for an id without an approved link", async () => {
    const putsBefore = puts.length;
    expect(await run([IDS.unapproved, IDS.nolink])).toEqual([
      { id: IDS.unapproved, code: "not_approved" }, { id: IDS.nolink, code: "not_approved" },
    ]);
    expect(await q("SELECT 1 FROM essay_urls WHERE url = ANY($1::text[])", [[urlOf(IDS.unapproved), urlOf(IDS.nolink)]])).toHaveLength(0);
    expect(puts.length).toBe(putsBefore);
  });

  it("a crash between the S3 put and the DB commit, then a rerun, leaves one object and one row", async () => {
    const essaysBefore = (await counts()).essays;
    const objectsBefore = objects.size;
    const failing: StoreDeps["db"] = {
      query: (sql, params) => (/^INSERT INTO essays/.test(sql.trim()) ? Promise.reject(new Error("simulated crash")) : fresh.db.query(sql, params)),
    };
    await expect(run([IDS.crash], { db: failing })).rejects.toThrow("simulated crash");
    expect(objects.size).toBe(objectsBefore + 1); // the object was put
    expect((await counts()).essays).toBe(essaysBefore); // nothing committed
    expect((await urlRow(IDS.crash))?.status).toBe("new");

    expect(await run([IDS.crash])).toEqual([{ id: IDS.crash, code: "stored" }]);
    expect(objects.size).toBe(objectsBefore + 1);
    expect((await counts()).essays).toBe(essaysBefore + 1);
    expect((await urlRow(IDS.crash))?.status).toBe("fetched");
  });

  it("does nothing while pipelines are paused, and when the flag is missing or malformed", async () => {
    const snapshot = JSON.stringify([await counts(), puts.length]);
    await setPaused(true);
    await expect(run([IDS.ok])).rejects.toThrow("pipelines_paused");
    await q("DELETE FROM system_flags WHERE key = 'pipelines_paused'");
    await expect(run([IDS.ok])).rejects.toThrow("pipelines_paused");
    await setPaused(false);
    expect(JSON.stringify([await counts(), puts.length])).toBe(snapshot);
  });

  it("never puts essay text in log lines or error messages", async () => {
    const all = logs.join("\n");
    expect(all).toMatch(/id=201 code=stored/);
    for (const l of LEAKS) expect(all).not.toContain(l);
    const errors: string[] = [];
    await setPaused(true);
    await run([IDS.ok]).catch((e: Error) => errors.push(e.message));
    await setPaused(false);
    for (const l of LEAKS) expect(errors.join("")).not.toContain(l);
  });
});

describe("S3 writer", () => {
  const sent: Array<{ input: Record<string, unknown> }> = [];
  const client = (fail?: number) => ({
    send: async (cmd: { input: Record<string, unknown> }) => {
      sent.push(cmd);
      if (fail) throw Object.assign(new Error("boom"), { $metadata: { httpStatusCode: fail } });
      return {};
    },
    destroy: () => undefined,
  });

  it("puts with a conditional write and treats an existing key (412) as stored", async () => {
    await createTextObjectWriter("b", "us-east-1", client() as never).putObject("essays/text/x.txt", new Uint8Array([1]));
    expect(sent[0]?.input).toMatchObject({ Bucket: "b", Key: "essays/text/x.txt", IfNoneMatch: "*" });
    await expect(createTextObjectWriter("b", "us-east-1", client(412) as never).putObject("k", new Uint8Array())).resolves.toBeUndefined();
    await expect(createTextObjectWriter("b", "us-east-1", client(403) as never).putObject("k", new Uint8Array())).rejects.toThrow("boom");
  });
});

describe("CLI", () => {
  const scriptsDir = fileURLToPath(new URL("..", import.meta.url));
  const runCli = (argv: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "essay-ingest.ts", ...argv], {
      cwd: scriptsDir, encoding: "utf8", timeout: 40_000,
      // An unroutable DATABASE_URL: without the guard the script would try to connect and hang.
      env: { ...process.env, DATABASE_URL: "postgres://u:p@10.255.255.1:5432/x" },
    });

  it("the store phase refuses a non-PGlite target without --confirm, before connecting", () => {
    const r = runCli(["--phase", "store", "--ids", "1342", "--bucket", "b"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--confirm");
    expect(r.stderr).not.toContain("10.255.255.1");
  }, 60_000);

  it("rejects bad ids before any rsync or database work, without echoing them", () => {
    const r = runCli(["--phase", "fetch", "--ids", "1342; touch pwned"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("invalid_book_id");
    expect(r.stderr).not.toContain("pwned");
  }, 60_000);
});
