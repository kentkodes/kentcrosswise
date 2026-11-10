import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSeedList, type SeedListEntry } from "@kcw/db/seed-list";
import { freshDb } from "../../packages/db/test/helpers";
import { parseReviewTable } from "../../packages/essays/src/match/review";
import { loadApprovedSeeds } from "../../packages/essays/src/match/links";
import { parseArgs } from "../lib/args";
import {
  buildPlan, countLinks, fetchCatalogCsv, formatLinks, parseOnly, runApply, runPlan, seedsFromDb, seedsFromList,
} from "../lib/match-runner";
import { formatRegister, runRegisterSource } from "../lib/register-source";
import { formatSeedImport, runSeedImport } from "../lib/seed-import";
import { assertWriteAllowed } from "../lib/write-guard";

const fixtureUrl = (rel: string) => new URL(`../../packages/essays/test/fixtures/${rel}`, import.meta.url);
const catalogFile = JSON.parse(readFileSync(fixtureUrl("gutenberg-catalog-sample.json"), "utf8")) as {
  provenance: string; rows: Array<{ id: number; type: string; title: string; language: string; authors: string }>;
};
const seedFile = JSON.parse(readFileSync(fixtureUrl("seeds-sample.json"), "utf8")) as {
  provenance: string; seeds: Array<{ id: string; title: string; author: string; year: number; publicDomainLikely: boolean | null }>;
};
const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
const CSV = ["Text#,Type,Issued,Title,Language,Authors,Subjects,LoCC,Bookshelves"]
  .concat(catalogFile.rows.map((r) => `${r.id},${r.type},2000-01-01,${q(r.title)},${r.language},${q(r.authors)},,,`))
  .join("\n");
const keyOf = (id: string) => createHash("sha256").update(id).digest("hex");

describe("fixtures", () => {
  it("carry public-domain provenance", () => {
    expect(catalogFile.provenance).toMatch(/public-domain/);
    expect(seedFile.provenance).toContain("No essay text");
  });
});

describe("write guard", () => {
  it("lets PGlite through and requires --confirm for anything else", () => {
    expect(() => assertWriteAllowed(parseArgs(["--pglite", ".pglite/x"]), "t")).not.toThrow();
    expect(() => assertWriteAllowed(parseArgs(["--secret", "kcw/prod/migrator"]), "t")).toThrow(/--confirm/);
    expect(() => assertWriteAllowed(parseArgs([]), "t")).toThrow(/--confirm/); // DATABASE_URL target
    expect(() => assertWriteAllowed(parseArgs(["--secret", "kcw/prod/migrator", "--confirm"]), "t")).not.toThrow();
  });
});

describe("confirm guard runs before any connection", () => {
  // DATABASE_URL points at an unroutable address: without the guard the script would try to connect and hang.
  const scriptsDir = fileURLToPath(new URL("..", import.meta.url));
  const cases: Array<[string, string[]]> = [
    ["import-seed-list.ts", []],
    ["register-source.ts", []],
    ["match-seeds.ts", ["apply", "--ref", "r1"]],
  ];
  it.each(cases)("%s refuses a non-PGlite target without --confirm", (file, extra) => {
    const run = spawnSync(process.execPath, ["--import", "tsx", file, ...extra], {
      cwd: scriptsDir, encoding: "utf8", timeout: 40_000,
      env: { ...process.env, DATABASE_URL: "postgres://u:p@10.255.255.1:5432/x" },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("--confirm");
    expect(run.stderr).not.toContain("10.255.255.1");
  }, 60_000);
});

describe("seed import counts", () => {
  let fresh: Awaited<ReturnType<typeof freshDb>>;
  let entries: SeedListEntry[];
  beforeAll(async () => {
    fresh = await freshDb();
    entries = await loadSeedList();
  });
  afterAll(async () => {
    await fresh.pg.close();
  });

  it("imports 300, reruns with identical counts, and prints counts only", async () => {
    const first = await runSeedImport(fresh.db, entries);
    expect(first).toMatchObject({ entries: 300, inserted: 300, before: { total: 0, approved: 0, listed: 0 }, after: { total: 300, approved: 300, listed: 300 } });
    const again = await runSeedImport(fresh.db, entries);
    expect(again).toMatchObject({ inserted: 0, before: first.after, after: first.after });
    const out = [...formatSeedImport("PGlite (x)", first), ...formatSeedImport("PGlite (x)", again)].join("\n");
    expect(out).toContain("seed_items before: total=0 approved=0 listed=0");
    expect(out).toContain("300 entries, 300 inserted");
    expect(out).toContain("300 entries, 0 inserted");
    for (const e of entries) expect(out).not.toContain(e.title);
    expect(out).not.toMatch(/postgres(ql)?:\/\//);
  });

  it("stays one transaction: a failing entry leaves no partial import", async () => {
    const before = (await fresh.db.query<{ n: string }>("SELECT count(*) AS n FROM seed_items")).rows[0]!.n;
    const fresh1 = { ...entries[0]!, title: "New Title For Rollback", author: "Rollback Author" };
    const broken = { ...entries[1]!, title: "Another New Title", author: null } as unknown as SeedListEntry;
    await expect(runSeedImport(fresh.db, [fresh1, broken])).rejects.toThrow();
    expect((await fresh.db.query<{ n: string }>("SELECT count(*) AS n FROM seed_items")).rows[0]!.n).toBe(before);
  });
});

describe("register-source", () => {
  it("reports counts and is idempotent", async () => {
    const { pg, db } = await freshDb();
    try {
      const a = await runRegisterSource(db);
      expect(a).toEqual({ before: 0, after: 1, inserted: true });
      const b = await runRegisterSource(db);
      expect(b).toEqual({ before: 1, after: 1, inserted: false });
      expect(formatRegister("PGlite (x)", a)).toEqual([
        "PGlite (x): sources before: 0", "PGlite (x): gutenberg source inserted", "PGlite (x): sources after: 1",
      ]);
    } finally {
      await pg.close();
    }
  });
});

describe("match runner", () => {
  let dir: string;
  let fresh: Awaited<ReturnType<typeof freshDb>>;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "kcw-match-"));
    fresh = await freshDb();
    await runRegisterSource(fresh.db);
    for (const s of seedFile.seeds) {
      await fresh.db.query(
        "INSERT INTO seed_items (title, author, year, status, public_domain_likely, seed_list_key) VALUES ($1, $2, $3, 'approved', $4, $5)",
        [s.title, s.author, s.year, s.publicDomainLikely, keyOf(s.id)],
      );
    }
    // A seed without a list key cannot be tracked by the table and is left out.
    await fresh.db.query("INSERT INTO seed_items (title, author, status) VALUES ('Unkeyed', 'Nobody', 'approved')");
  });
  afterAll(async () => {
    await fresh.pg.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("maps the real seed list to keyed seeds without a database", async () => {
    const seeds = seedsFromList(await loadSeedList());
    expect(seeds).toHaveLength(300);
    expect(new Set(seeds.map((s) => s.seedKey)).size).toBe(300);
    expect(seeds.filter((s) => s.publicDomainLikely === true)).toHaveLength(63);
  });

  it("plan: offline from a catalog file, deterministic, no database writes", async () => {
    const seeds = await seedsFromDb(fresh.db);
    expect(seeds).toHaveLength(seedFile.seeds.length);
    const linksBefore = await countLinks(fresh.db);
    const out = join(dir, "review.md");
    const input = { seeds, catalogCsv: CSV, catalogDate: "2026-11-10", outPath: out };
    const counts = await runPlan(input);
    expect(counts).toEqual({ seeds: 8, candidates: 4, tierA: 3, tierB: 1, autoApprovable: 3 });
    const first = await readFile(out, "utf8");
    expect(first).toContain("Catalog fetched: 2026-11-10");
    await runPlan({ ...input, seeds: [...seeds].reverse() });
    expect(await readFile(out, "utf8")).toBe(first);
    expect(await countLinks(fresh.db)).toEqual(linksBefore);
    expect(buildPlan({ seeds, catalogCsv: CSV, catalogDate: "2026-11-10" }).markdown).toBe(first);
  });

  it("plan keeps hand-filled cells when it is run again", async () => {
    const out = join(dir, "kept.md");
    const seeds = await seedsFromDb(fresh.db);
    const input = { seeds, catalogCsv: CSV, catalogDate: "2026-11-10", outPath: out };
    await runPlan(input);
    const rows = parseReviewTable(await readFile(out, "utf8"));
    const b = rows.find((r) => r.tier === "B")!;
    const text = (await readFile(out, "utf8")).replace(`| ${b.action} |  |  |`, `| ${b.action} | same work | approve |`);
    await writeFile(out, text, "utf8");
    await runPlan(input);
    expect(await readFile(out, "utf8")).toBe(text);
  });

  it("apply: --only approves just the named link and reports counts", async () => {
    const out = join(dir, "apply.md");
    const seeds = await seedsFromDb(fresh.db);
    await runPlan({ seeds, catalogCsv: CSV, catalogDate: "2026-11-10", outPath: out });
    const r = await runApply({ db: fresh.db, tablePath: out, ref: "review1", only: [1001] });
    expect(r.before).toEqual({ proposed: 0, approved: 0, rejected: 0 });
    expect(r.after).toEqual({ proposed: 3, approved: 1, rejected: 0 });
    expect(r.result).toEqual({ inserted: 4, updated: 0, skipped: 0 });
    expect(formatLinks(r.after)).toBe("proposed=3 approved=1 rejected=0");
    const again = await runApply({ db: fresh.db, tablePath: out, ref: "review1", only: [1001] });
    expect(again.after).toEqual(r.after);
    expect(again.result).toEqual({ inserted: 0, updated: 0, skipped: 4 });
  });

  it("apply aborts without writes for a tampered table and for a missing source", async () => {
    const out = join(dir, "tampered.md");
    const bad = join(dir, "bad.md");
    const seeds = await seedsFromDb(fresh.db);
    await fresh.db.query("DELETE FROM seed_source_links");
    await runPlan({ seeds, catalogCsv: CSV, catalogDate: "2026-11-10", outPath: out });
    const original = parseReviewTable(await readFile(out, "utf8"))[0]!.seedKey;
    await writeFile(bad, (await readFile(out, "utf8")).replace(original, keyOf("unknown-seed")), "utf8");
    await expect(runApply({ db: fresh.db, tablePath: bad, ref: "r" })).rejects.toThrow("apply_aborted unknown_seed (1)");
    expect(await countLinks(fresh.db)).toEqual({ proposed: 0, approved: 0, rejected: 0 });

    const empty = await freshDb();
    try {
      await expect(runApply({ db: empty.db, tablePath: out, ref: "r" })).rejects.toThrow(/source_missing/);
    } finally {
      await empty.pg.close();
    }
  });

  it("loads approved seeds with keys for the table", async () => {
    expect((await loadApprovedSeeds(fresh.db)).filter((s) => !s.seedKey)).toHaveLength(1);
  });

  it("parses --only", () => {
    expect(parseOnly("1342 2701,1342")).toEqual([1342, 2701]);
    for (const bad of ["", "abc", "0", "12345678", "1;2"]) expect(() => parseOnly(bad)).toThrow(/Gutenberg ids/);
  });
});

describe("catalog fetch", () => {
  const reply = (robots: string, seen: Array<{ url: string; ua: string }>): typeof fetch =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, ua: new Headers(init?.headers).get("user-agent") ?? "" });
      if (url.endsWith("/robots.txt")) return new Response(robots, { status: 200, headers: { "content-type": "text/plain" } });
      return new Response(CSV, { status: 200, headers: { "content-type": "text/csv" } });
    }) as typeof fetch;
  // A virtual clock: the rate lease compares against it and the injected sleep advances it.
  const clock = () => {
    let t = new Date("2026-11-10T12:00:00Z").getTime();
    return { now: () => new Date(t), sleep: async (ms: number) => { t += ms; } };
  };

  it("makes one politely identified catalog request after robots.txt, nothing else", async () => {
    const seen: Array<{ url: string; ua: string }> = [];
    const body = await fetchCatalogCsv({ fetch: reply("User-agent: *\nDisallow: /ebooks/search\n", seen), ...clock() });
    expect(body).toBe(CSV);
    expect(seen.map((s) => s.url)).toEqual([
      "https://www.gutenberg.org/robots.txt", "https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv",
    ]);
    expect(seen.every((s) => s.ua.startsWith("KentcrosswiseBot/"))).toBe(true);
  });

  it("fails closed when robots.txt disallows the catalog", async () => {
    const seen: Array<{ url: string; ua: string }> = [];
    await expect(fetchCatalogCsv({ fetch: reply("User-agent: *\nDisallow: /\n", seen), ...clock() })).rejects.toThrow(/catalog_fetch_failed/);
    expect(seen.map((s) => s.url)).toEqual(["https://www.gutenberg.org/robots.txt"]);
  });
});
