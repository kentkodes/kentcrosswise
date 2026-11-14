// Shape of the AR1 slice 2 workflows (PR A, shadow): what each job may hold. Text-level checks, like authority-split.test.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8").replace(/\r/g, "").replace(/^ *#.*\n/gm, ""); // comments dropped: they name what a job must not hold

/** Splits the `jobs:` section into job id -> body. */
function jobs(yml: string): Record<string, string> {
  const section = yml.slice(yml.indexOf("\njobs:\n") + 7);
  const out: Record<string, string> = {};
  const parts = section.split(/^ {2}([a-z0-9-]+):\n/gm);
  for (let i = 1; i < parts.length; i += 2) out[parts[i]!] = parts[i + 1]!;
  return out;
}

describe("ci.yml candidate-build", () => {
  const ci = read(".github/workflows/ci.yml");
  const job = jobs(ci)["candidate-build"]!;

  it("holds no credentials", () => {
    expect(job).toBeDefined();
    expect(job).toMatch(/permissions:\n {6}contents: read\n/);
    expect(job).not.toContain("id-token");
    expect(job).not.toContain("secrets.");
    expect(job).not.toMatch(/configure-aws-credentials|secretsmanager|vars\.AWS|vars\.NEON/);
  });

  it("uploads one candidate-preview artifact with a 3 day retention and is part of ci/required", () => {
    expect(job.match(/upload-artifact@/g)).toHaveLength(1);
    expect(job).toMatch(/name: candidate-preview\n/);
    expect(job).toContain("retention-days: 3");
    expect(job).toContain("if: github.event.pull_request.head.repo.full_name == github.repository");
    const required = jobs(ci).required!;
    expect(required).toContain("needs: [checks, preview, candidate-build, prod-plan]");
    expect(required).toContain('test "$CANDIDATE" = success');
  });
});

describe("preview-trusted.yml", () => {
  const yml = read(".github/workflows/preview-trusted.yml");
  const j = jobs(yml) as Record<"verify" | "provision" | "e2e" | "teardown" | "result", string>;

  it("is a workflow_run workflow on ci with empty top-level permissions", () => {
    expect(yml).toMatch(/^on:\n {2}workflow_run:\n {4}workflows: \[ci\]\n {4}types: \[completed\]\n/m);
    expect(yml).toMatch(/^permissions: \{\}$/m);
    expect(yml).toContain("cancel-in-progress: true");
    expect(Object.keys(j)).toEqual(["verify", "provision", "e2e", "teardown", "result"]);
  });

  it("verify checks the triggering run and has no environment or cloud credentials", () => {
    for (const cond of [
      "workflow_run.event == 'pull_request'",
      "workflow_run.conclusion == 'success'",
      "workflow_run.path == '.github/workflows/ci.yml'",
      "workflow_run.head_repository.id == github.repository_id",
    ]) {
      expect(j.verify).toContain(cond);
    }
    expect(j.verify).not.toMatch(/environment:|id-token|configure-aws-credentials/);
    expect(j.verify).toMatch(/permissions:\n {6}actions: read\n {6}pull-requests: read\n {6}contents: read/);
  });

  it("only e2e runs candidate code, from the verified head, with only the e2e login", () => {
    for (const name of ["verify", "provision", "teardown", "result"] as const) {
      expect(j[name]).not.toMatch(/ref: \$\{\{ needs\.verify\.outputs\.head_sha/);
    }
    expect(j.e2e).toContain("ref: ${{ needs.verify.outputs.head_sha }}");
    expect(j.e2e).toContain("environment: preview-e2e");
    expect(j.e2e).toContain("KCW_E2E_LOGIN: ${{ secrets.E2E_LOGIN }}");
    expect(j.e2e).toMatch(/permissions:\n {6}contents: read\n/);
    expect(j.e2e).not.toMatch(/id-token|configure-aws-credentials|secretsmanager|vars\.AWS/);
    expect(j.e2e).toContain("persist-credentials: false");
  });

  it("provision and teardown use main only: preview-gc environment, kcw/ci only, no candidate scripts", () => {
    for (const name of ["provision", "teardown"] as const) {
      expect(j[name]).toContain("environment: preview-gc");
      expect(j[name]).toMatch(/secret-ids: \|\n\s+KCW_CI, kcw\/ci\n/);
      expect(j[name]).not.toContain("e2e-login");
      expect(j[name]).not.toMatch(/ref: /);
      expect(j[name]).not.toMatch(/E2E_LOGIN/);
    }
    // The candidate build is extracted by trusted code, never by tar, and never executed.
    expect(j.provision).toContain("pnpm verify-candidate extract");
    expect(j.provision).not.toMatch(/\btar\b/);
    expect(j.provision).not.toMatch(/pnpm (migrate|seed|build-web|--filter web)/);
    expect(j.provision).toContain("pnpm restore-preview-db");
    expect(j.provision).not.toMatch(/\bpsql\b/);
  });

  it("uses the shadow preview id for every resource name and checks the head before apply", () => {
    expect(j.provision).toContain("PR_NUMBER: ${{ needs.verify.outputs.preview_id }}");
    expect(j.provision).toContain("pr_number: ${{ needs.verify.outputs.preview_id }}");
    expect(j.provision).toContain('-backend-config="key=preview/pr-$PR_NUMBER.tfstate"');
    expect(j.provision.indexOf("verify-candidate head")).toBeGreaterThan(-1);
    expect(j.provision.indexOf("verify-candidate head")).toBeLessThan(j.provision.indexOf("terraform -chdir=infra/preview apply"));
    expect(j.provision).toContain("--require");
    expect(j.teardown).toContain("PR_NUMBER: ${{ needs.verify.outputs.preview_id }}");
  });

  it("teardown runs after provision started and skips only when a newer head owns the preview", () => {
    expect(j.teardown).toContain("if: always() && needs.provision.result != 'skipped'");
    expect(j.teardown).toContain("steps.owner.outputs.state != 'superseded'");
    expect(j.teardown).toContain("pnpm check-preview-clean");
  });

  it("result posts kcw/trusted-preview with statuses: write only", () => {
    expect(j.result).toMatch(/permissions:\n {6}statuses: write\n/);
    expect(j.result).toContain('context="kcw/trusted-preview"');
    expect(j.result).toContain("target_url");
  });

  it("no job writes outside its grants", () => {
    expect(j.provision).toMatch(/permissions:\n {6}id-token: write\n {6}contents: read\n {6}pull-requests: read\n/);
    expect(j.teardown).toMatch(/permissions:\n {6}id-token: write\n {6}contents: read\n {6}pull-requests: read\n/);
    expect(yml.match(/id-token: write/g)).toHaveLength(2);
  });
});
