// Shape of .github/workflows/deploy.yml (AR8a): builds run before the production migration, so a failed
// build leaves the production schema untouched; the rest of the deploy keeps its guards. AR8b: the last two
// steps publish a failure alert, and no Terraform file may hold the alert email subscription.
import { readdirSync, readFileSync, statSync } from "node:fs";
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

describe("deploy failure alert (AR8b)", () => {
  const last = steps.slice(-2);

  it("ends with a credentials step and a publish step, both only on failure", () => {
    expect(last[0]!.body).toContain("uses: aws-actions/configure-aws-credentials@");
    expect(last[0]!.body).toContain("role-to-assume: ${{ vars.AWS_ROLE_DEPLOY_ARN }}");
    expect(last[1]!.body).toContain("aws sns publish");
    for (const s of last) expect(s.body).toMatch(/^ {8}if: failure\(\)$/m);
    expect(steps.filter((s) => /if: failure\(\)/.test(s.body))).toHaveLength(2);
  });

  it("passes values to the publish step only through env, with no expression in run", () => {
    const body = last[1]!.body;
    const run = /^ {8}run: \|\n([\s\S]+)$/m.exec(body)?.[1] ?? "";
    expect(run).toContain("aws sns publish");
    expect(run).not.toContain("${{");
    expect(run).toContain('--topic-arn "arn:aws:sns:us-east-1:${AWS_ACCOUNT_ID}:kcw-prod-alerts"');
    expect(body).toContain("AWS_ACCOUNT_ID: ${{ vars.AWS_ACCOUNT_ID }}");
    expect(body).toContain("RUN_ID: ${{ github.run_id }}");
    expect(body).toContain("SHA: ${{ github.sha }}");
  });

  it("keeps the alert email out of Terraform and the metric filter on the wrapper's fixed log line", () => {
    const tf: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === ".terraform" || name === "node_modules") continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith(".tf")) tf.push(readFileSync(full, "utf8"));
      }
    };
    walk(path.join(root, "infra"));
    expect(tf.length).toBeGreaterThan(0);
    for (const src of tf) expect(src).not.toContain("aws_sns_topic_subscription");
    expect(readFileSync(path.join(root, "apps/web/src/server/origin-wrapper.ts"), "utf8")).toContain("[job] ${job} failed ");
    expect(readFileSync(path.join(root, "infra/modules/alerts/main.tf"), "utf8")).toContain('pattern        = "\\"[job]\\" \\"failed\\""');
  });
});
