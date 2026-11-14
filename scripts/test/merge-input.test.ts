import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, expectTypeOf, it } from "vitest";
import {
  MERGE_INPUT_ARTIFACT,
  MERGE_INPUT_FILE,
  parseMergeInput,
  type MergeInputLockDiff,
  type MergeInputPlanSummary,
} from "@kcw/core/merge-input";
import type { MergeRulesInput } from "@kcw/merge-rules";
import { buildMergeInput } from "../lib/merge-input";
import type { PlanSummary } from "../lib/plan-summary";
import type { GitHubRest } from "../lib/trusted-preview";
import { listUncoveredPaths } from "../lib/uncovered-paths";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const scriptsDir = path.join(repoRoot, "scripts");
const tmp = mkdtempSync(path.join(tmpdir(), "kcw-merge-input-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const SHA = "a".repeat(40);

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", path.join(scriptsDir, "merge-input.ts"), ...args],
      { cwd: scriptsDir, env: { ...process.env, INIT_CWD: tmp, GITHUB_TOKEN: "unused", GITHUB_REPOSITORY: "o/r" } },
      (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

const BASE_LOCK = `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      vitest:
        specifier: ^5.0.5
        version: 5.0.5
`;
const HEAD_LOCK = `${BASE_LOCK}
  agents/new:
    dependencies:
      left-pad:
        specifier: ^1.3.0
        version: 1.3.0
`;
const PLAN = { format: 1, infra: [], artifact: { count: 2, kinds: { create: 0, update: 2, delete: 0, replace: 0 } } };

/** PR #7 at SHA with the given file list; pages of 100 like the API. */
function fakeApi(files: object[], over: { changed_files?: number; sha?: string } = {}): GitHubRest {
  return {
    async get<T>(p: string) {
      if (p === "/repos/o/r/pulls/7") return { changed_files: over.changed_files ?? files.length, head: { sha: over.sha ?? SHA } } as T;
      const m = /^\/repos\/o\/r\/pulls\/7\/files\?per_page=100&page=(\d+)$/.exec(p);
      if (m) return files.slice((Number(m[1]) - 1) * 100, Number(m[1]) * 100) as T;
      return undefined;
    },
  };
}
const src = { repo: "o/r", pr: 7, headSha: SHA };

describe("listUncoveredPaths", () => {
  it("returns sorted infra/ and .github/ paths, both sides of a rename", async () => {
    const api = fakeApi([
      { filename: "apps/web/src/a.ts" },
      { filename: "infra/preview/main.tf" },
      { filename: ".github/workflows/ci.yml" },
      { filename: "infra/modules/web/new.tf", previous_filename: "infra/modules/web/old.tf" },
      { filename: "docs/infra/readme.md", previous_filename: "infra/readme.md" },
      { filename: "infrastructure/x.tf" },
    ]);
    expect(await listUncoveredPaths(api, src)).toEqual([
      ".github/workflows/ci.yml",
      "infra/modules/web/new.tf",
      "infra/modules/web/old.tf",
      "infra/preview/main.tf",
      "infra/readme.md",
    ]);
  });

  it("paginates", async () => {
    const files = Array.from({ length: 250 }, (_, i) => ({ filename: i === 249 ? "infra/last.tf" : `src/f${i}.ts` }));
    expect(await listUncoveredPaths(fakeApi(files), src)).toEqual(["infra/last.tf"]);
  });

  it("fails when fewer files are listed than changed_files, on a moved head, or on a missing PR", async () => {
    await expect(listUncoveredPaths(fakeApi([{ filename: "a" }], { changed_files: 3001 }), src)).rejects.toThrow(/listed 1 of 3001/);
    await expect(listUncoveredPaths(fakeApi([], { sha: "b".repeat(40) }), src)).rejects.toThrow(/head is/);
    await expect(listUncoveredPaths({ get: async () => undefined }, src)).rejects.toThrow(/not found/);
  });
});

describe("buildMergeInput", () => {
  it("writes the format 2 file the orchestrator parses", async () => {
    const { text, input } = await buildMergeInput(fakeApi([{ filename: "infra/prod/main.tf" }]), {
      ...src,
      planSummary: JSON.stringify(PLAN),
      baseLock: BASE_LOCK,
      headLock: HEAD_LOCK,
    });
    expect(parseMergeInput(text)).toEqual(input);
    expect(input).toEqual({
      pr: 7,
      headSha: SHA,
      planSummary: PLAN,
      lockDiff: { added: [{ importer: "agents/new", name: "left-pad" }], existing: ["vitest"] },
      uncoveredPaths: ["infra/prod/main.tf"],
    });
  });

  it("fails on a bad plan summary", async () => {
    await expect(
      buildMergeInput(fakeApi([]), { ...src, planSummary: JSON.stringify({ format: 1, infra: [] }), baseLock: BASE_LOCK, headLock: HEAD_LOCK }),
    ).rejects.toThrow(/planSummary\.artifact/);
  });
});

describe("merge-input CLI", () => {
  it("fails on missing input before any network call", async () => {
    const base = ["--pr", "7", "--head-sha", SHA, "--base-lock", "base.yaml", "--head-lock", "head.yaml", "--out", "x.json"];
    writeFileSync(path.join(tmp, "base.yaml"), BASE_LOCK);
    const missing = await run([...base, "--plan-summary", "nope.json"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("could not read --plan-summary");
    const badSha = await run(["--pr", "7", "--head-sha", "abc", "--out", "x.json"]);
    expect(badSha.code).toBe(1);
    expect(badSha.stderr).toContain("--head-sha");
    const usage = await run([]);
    expect(usage.stderr).toContain("Usage: pnpm merge-input");
  }, 30_000);
});

describe("contract with preview-trusted.yml and merge-rules", () => {
  it("the shapes match plan-summary's output and merge-rules' input", () => {
    expect(MERGE_INPUT_FILE).toBe(`${MERGE_INPUT_ARTIFACT}.json`);
    expectTypeOf<PlanSummary>().toEqualTypeOf<MergeInputPlanSummary>();
    expectTypeOf<MergeInputPlanSummary>().toExtend<NonNullable<MergeRulesInput["planSummary"]>>();
    expectTypeOf<MergeInputLockDiff>().toExtend<NonNullable<MergeRulesInput["lockDiff"]>>();
  });
});
