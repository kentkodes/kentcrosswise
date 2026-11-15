// Shape of .github/workflows/deploy.yml (AR8a): builds run before the production migration, so a failed
// build leaves the production schema untouched; the rest of the deploy keeps its guards.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const yml = readFileSync(path.join(root, ".github/workflows/deploy.yml"), "utf8").replace(/\r/g, "").replace(/^ *#.*\n/gm, "");

/** Step bodies in file order, keyed by the step name. */
const steps: { name: string; body: string }[] = [];
for (const part of yml.split(/^ {6}- /m).slice(1)) {
  const name = /name: (.+)/.exec(part)?.[1] ?? /uses: (\S+)/.exec(part)?.[1] ?? "?";
  steps.push({ name, body: part });
}
const index = (needle: string): number => {
  const i = steps.findIndex((s) => s.body.includes(needle));
  expect(i, `step with ${needle}`).toBeGreaterThanOrEqual(0);
  return i;
};

describe("deploy.yml order", () => {
  it("builds the web app and the Lambda bundles before the production migration", () => {
    const web = index("pnpm build-web");
    const lambdas = index("pnpm build-lambdas");
    const migrate = index("pnpm migrate --secret kcw/prod/migrator");
    expect(web).toBeLessThan(migrate);
    expect(lambdas).toBeLessThan(migrate);
  });

  it("migrates before terraform apply, and applies before the cache clear and the smoke check", () => {
    const order = [
      "pnpm migrate --secret kcw/prod/migrator",
      "terraform -chdir=infra/prod init",
      "terraform -chdir=infra/prod apply",
      "aws cloudfront create-invalidation",
      "pnpm smoke-check",
    ].map(index);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("nothing credentialed runs before both builds finish", () => {
    const builds = Math.max(index("pnpm build-web"), index("pnpm build-lambdas"));
    expect(index("aws-actions/configure-aws-credentials")).toBeGreaterThan(builds);
  });

  it("keeps the environment, the role, the concurrency group, the main-only guard and the build-id smoke check", () => {
    expect(yml).toMatch(/^ {4}environment: prod$/m);
    expect(yml).toContain("role-to-assume: ${{ vars.AWS_ROLE_DEPLOY_ARN }}");
    expect(yml).toMatch(/concurrency:\n {2}group: deploy-prod\n {2}cancel-in-progress: false/);
    expect(yml).toContain("if: github.ref == 'refs/heads/main'");
    expect(yml).toContain("--build-file apps/web/.open-next/kcw-build.json");
    expect(yml).toMatch(/^permissions: \{\}$/m);
  });
});
