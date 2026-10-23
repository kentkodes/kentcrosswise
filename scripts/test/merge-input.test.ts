import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import type { PlanSummary } from "../lib/plan-summary";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const scriptsDir = path.join(repoRoot, "scripts");
const tmp = mkdtempSync(path.join(tmpdir(), "kcw-merge-input-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", path.join(scriptsDir, "merge-input.ts"), ...args],
      { cwd: scriptsDir, env: { ...process.env, INIT_CWD: tmp } },
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

describe("merge-input CLI", () => {
  it("writes the artifact file the orchestrator parses", async () => {
    writeFileSync(path.join(tmp, "plan.json"), JSON.stringify(PLAN));
    writeFileSync(path.join(tmp, "base.yaml"), BASE_LOCK);
    writeFileSync(path.join(tmp, "head.yaml"), HEAD_LOCK);
    const r = await run([
      "--plan-summary", "plan.json", "--base-lock", "base.yaml", "--head-lock", "head.yaml",
      "--out", MERGE_INPUT_FILE, "--markdown", "summary.md",
    ]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("merge-input: 0 infrastructure change(s), 1 direct dependency addition(s)");
    const parsed = parseMergeInput(readFileSync(path.join(tmp, MERGE_INPUT_FILE), "utf8"));
    expect(parsed).toEqual({
      planSummary: PLAN,
      lockDiff: { added: [{ importer: "agents/new", name: "left-pad" }], existing: ["vitest"] },
    });
    expect(readFileSync(path.join(tmp, "summary.md"), "utf8")).toContain("`left-pad` in `agents/new`");
  });

  it("fails on a bad plan summary or missing input", async () => {
    writeFileSync(path.join(tmp, "bad-plan.json"), JSON.stringify({ format: 1, infra: [] }));
    const bad = await run(["--plan-summary", "bad-plan.json", "--base-lock", "base.yaml", "--head-lock", "head.yaml", "--out", "x.json"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("planSummary.artifact");
    const missing = await run(["--plan-summary", "nope.json", "--base-lock", "base.yaml", "--head-lock", "head.yaml", "--out", "x.json"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("could not read --plan-summary");
    const usage = await run([]);
    expect(usage.stderr).toContain("Usage: pnpm merge-input");
  }, 30_000);
});

describe("contract with ci.yml and merge-rules", () => {
  it("ci.yml uploads the file under the shared artifact name", () => {
    const ci = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const upload = /- name: Upload merge-rules input\n\s+uses: actions\/upload-artifact@\S+\n\s+with:\n\s+name: (\S+)\n\s+path: (.+)\n/.exec(ci.replace(/\r\n/g, "\n"));
    expect(upload).not.toBeNull();
    expect(upload![1]).toBe(MERGE_INPUT_ARTIFACT);
    expect(path.posix.basename(upload![2]!)).toBe(MERGE_INPUT_FILE);
    expect(ci).toContain(`--out "$RUNNER_TEMP/${MERGE_INPUT_FILE}"`);
  });

  it("the shapes match plan-summary's output and merge-rules' input", () => {
    expectTypeOf<PlanSummary>().toEqualTypeOf<MergeInputPlanSummary>();
    expectTypeOf<MergeInputPlanSummary>().toExtend<NonNullable<MergeRulesInput["planSummary"]>>();
    expectTypeOf<MergeInputLockDiff>().toExtend<NonNullable<MergeRulesInput["lockDiff"]>>();
  });
});
