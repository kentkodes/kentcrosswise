// Shape of the AR1 slice 2 and 3 workflows: what each job may hold. Text-level checks, like authority-split.test.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MERGE_INPUT_ARTIFACT } from "@kcw/core/merge-input";
import { REQUIRED_JOBS } from "@kcw/core/trusted-run";
import { PROD_ROOTS } from "../lib/candidate-artifact";

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
    expect(required).toContain("needs: [checks, candidate-build, candidate-prod-build, prod-plan]");
    expect(required).toContain('test "$CANDIDATE" = success');
  });
});

describe("ci.yml candidate-prod-build and the advisory prod-plan (AR1 slice 3)", () => {
  const ci = read(".github/workflows/ci.yml");
  const j = jobs(ci);
  const job = j["candidate-prod-build"]!;

  it("candidate-prod-build holds no credentials and uploads one candidate-prod artifact", () => {
    expect(job).toBeDefined();
    expect(job).toMatch(/permissions:\n {6}contents: read\n/);
    expect(job).not.toContain("id-token");
    expect(job).not.toContain("secrets.");
    expect(job).not.toMatch(/environment:|configure-aws-credentials|secretsmanager|vars\.AWS|vars\.NEON/);
    expect(job).toContain("if: github.event.pull_request.head.repo.full_name == github.repository");
    expect(job.match(/upload-artifact@/g)).toHaveLength(1);
    expect(job).toMatch(/name: candidate-prod\n/);
    expect(job).toContain("retention-days: 3");
    expect(job).toMatch(/run: pnpm build-web\n/);
    expect(job).not.toContain("KCW_ENV");
    expect(job).toContain("pnpm build-lambdas");
    expect(job).toContain("pnpm candidate-manifest --kind prod");
    expect(job).toContain("pnpm verify-candidate verify --kind prod");
  });

  it("archives exactly the PROD_ROOTS", () => {
    const tarLine = /-cf "\$OUT_DIR\/prod-build\.tar" (.+)\n/.exec(job)?.[1];
    expect(tarLine?.split(" ")).toEqual([...PROD_ROOTS]);
  });

  it("is required for same-repo PRs", () => {
    expect(j.required).toContain('test "$CANDIDATE_PROD" = success');
  });

  it("carries no merge-rules input or plan summary artifact: the advisory plan feeds nothing", () => {
    expect(ci).not.toContain("merge-rules-input");
    expect(ci).not.toMatch(/name: prod-plan-summary/);
    expect(ci).not.toContain("pnpm merge-input");
    expect(j["prod-plan"]).not.toContain("upload-artifact");
    expect(j["prod-plan"]).toContain("terraform -chdir=infra/prod plan");
    expect(j["prod-plan"]).toContain('--markdown "$GITHUB_STEP_SUMMARY"');
  });
});

describe("preview-trusted.yml", () => {
  const yml = read(".github/workflows/preview-trusted.yml");
  const j = jobs(yml) as Record<"verify" | "prod-plan" | "provision" | "e2e" | "teardown" | "result", string>;

  it("is a workflow_run workflow on ci with empty top-level permissions", () => {
    expect(yml).toMatch(/^on:\n {2}workflow_run:\n {4}workflows: \[ci\]\n {4}types: \[completed\]\n/m);
    expect(yml).toMatch(/^permissions: \{\}$/m);
    expect(yml).toContain("cancel-in-progress: true");
    expect(Object.keys(j)).toEqual(["verify", "prod-plan", "provision", "e2e", "teardown", "result"]);
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
    for (const name of ["verify", "prod-plan", "provision", "teardown", "result"] as const) {
      expect(j[name]).not.toMatch(/ref: \$\{\{ needs\.verify\.outputs\.head_sha[^\n]*\n(?! {10}path: lock-head)/);
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

  it("names every resource by the PR number and checks the head before apply", () => {
    expect(j.provision).toContain("PR_NUMBER: ${{ needs.verify.outputs.pr_number }}");
    expect(j.provision).toContain("pr_number: ${{ needs.verify.outputs.pr_number }}");
    expect(j.provision).toContain('-backend-config="key=preview/pr-$PR_NUMBER.tfstate"');
    expect(j.provision.indexOf("verify-candidate head")).toBeGreaterThan(-1);
    expect(j.provision.indexOf("verify-candidate head")).toBeLessThan(j.provision.indexOf("terraform -chdir=infra/preview apply"));
    expect(j.provision).toContain("--require");
    expect(j.teardown).toContain("PR_NUMBER: ${{ needs.verify.outputs.pr_number }}");
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
    expect(yml.match(/id-token: write/g)).toHaveLength(3);
  });
});

describe("preview-trusted.yml prod-plan (AR1 slice 3)", () => {
  const yml = read(".github/workflows/preview-trusted.yml");
  const j = jobs(yml) as Record<"verify" | "prod-plan" | "result", string>;
  const plan = j["prod-plan"];

  it("is named prod-plan (the shared trusted-run check requires that job name), in the main-only prod-plan environment", () => {
    expect(plan).toContain("name: prod-plan\n");
    expect(plan).toContain("environment: prod-plan\n");
    expect(plan).toContain("needs: verify\n");
    expect(plan).toMatch(/permissions:\n {6}id-token: write\n {6}contents: read\n {6}pull-requests: read\n/);
    expect(plan).toContain("role-to-assume: ${{ vars.AWS_ROLE_PLAN_ARN }}");
    expect(plan).not.toMatch(/AWS_ROLE_CI_ARN|AWS_ROLE_DEPLOY_ARN|secretsmanager|secrets\./);
  });

  it("extracts the verified tar with our own code and plans main's infra", () => {
    expect(plan).toContain('pnpm verify-candidate extract --kind prod --dir "$RUNNER_TEMP/candidate-prod-in" --dest "$GITHUB_WORKSPACE"');
    expect(plan).not.toMatch(/\btar\b/);
    expect(plan).toContain("terraform -chdir=infra/prod plan -lock=false");
    expect(plan.indexOf("verify-candidate extract")).toBeLessThan(plan.indexOf("terraform -chdir=infra/prod init"));
    // The plan JSON is deleted after it is summarized.
    expect(plan).toContain('rm -f "$RUNNER_TEMP/prod-plan.json"');
  });

  it("checks out main, and the candidate only as the two sparse pnpm-lock.yaml data checkouts", () => {
    const checkouts = plan.split(/\n(?= {6}- )/).filter((step) => step.includes("actions/checkout@"));
    expect(checkouts).toHaveLength(3);
    const [main, head, base] = checkouts as [string, string, string];
    expect(main).not.toContain("ref:");
    for (const [step, ref, dir] of [[head, "head_sha", "lock-head"], [base, "base_sha", "lock-base"]] as const) {
      expect(step).toContain(`ref: \${{ needs.verify.outputs.${ref} }}`);
      expect(step).toContain(`path: ${dir}`);
      expect(step).toContain("sparse-checkout: pnpm-lock.yaml");
      expect(step).toContain("persist-credentials: false");
    }
    // The lockfiles are only arguments of merge-input; nothing is installed or run from them.
    expect(plan).toContain("--base-lock lock-base/pnpm-lock.yaml --head-lock lock-head/pnpm-lock.yaml");
    expect(plan).not.toMatch(/(cd|working-directory:|--dir|-C) *lock-(head|base)/);
    expect(plan.match(/pnpm install|pnpm (build|test|--filter)/g)).toBeNull();
  });

  it("restores no cache and uses only the default setup action", () => {
    expect(plan).not.toMatch(/cache: "?true"?|actions\/cache/);
  });

  it("verify resolves and re-verifies candidate-prod and outputs the base sha", () => {
    expect(j.verify).toContain("base_sha: ${{ steps.resolve.outputs.base_sha }}");
    expect(j.verify).toContain("artifact-ids: ${{ steps.resolve.outputs.prod_artifact_id }}");
    expect(j.verify).toContain('pnpm verify-candidate verify --kind prod --dir "$RUNNER_TEMP/candidate-prod-in"');
    expect(plan).toContain("name: verified-candidate-prod-${{ github.run_attempt }}");
  });

  it("uploads the merge-rules input as format 2 from trusted code, 30 days", () => {
    expect(plan).toContain('pnpm merge-input --pr "$PR_NUMBER" --head-sha "$HEAD_SHA"');
    expect(plan).toMatch(/name: merge-rules-input\n\s+path: \$\{\{ runner\.temp \}\}\/merge-rules-input\.json\n(?:.*\n)*?\s+retention-days: 30\n/);
    expect(plan.match(/upload-artifact@/g)).toHaveLength(1);
    expect(yml.match(/name: merge-rules-input\n/g)).toHaveLength(1);
  });

  it("result and the shared trusted-run check both require prod-plan", () => {
    expect(yml).toContain("needs: [verify, provision, prod-plan, e2e, teardown]");
    expect(j.result).toContain("PLAN: ${{ needs.prod-plan.result }}");
    expect(j.result).toContain('[ "$PLAN" = success ]');
    expect(REQUIRED_JOBS).toContain("prod-plan");
    expect(MERGE_INPUT_ARTIFACT).toBe("merge-rules-input");
  });
});
