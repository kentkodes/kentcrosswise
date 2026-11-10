// Text-level invariants of the essay-ingest workflow and its bootstrap role (no AWS, GitHub or Terraform calls).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (name: string) => readFileSync(path.join(root, name), "utf8").replace(/\r/g, "");
const code = (name: string) => read(name).replace(/^\s*#.*$/gm, "");
const yml = read(".github/workflows/essay-ingest.yml");
const iam = code("infra/bootstrap/iam.tf");
const outputs = code("infra/bootstrap/outputs.tf");

/** The step text starting at the line that contains `marker`, up to the next step. */
function step(marker: string): string {
  const start = yml.indexOf(marker);
  if (start < 0) throw new Error(`no step ${marker}`);
  const lineStart = yml.lastIndexOf("\n      - ", start);
  const next = yml.indexOf("\n      - ", start);
  return yml.slice(lineStart, next < 0 ? undefined : next);
}

describe("essay-ingest workflow", () => {
  it("is manual only, main only, and gated by its own environment", () => {
    expect(yml).toMatch(/^on:\n {2}workflow_dispatch:\n/m);
    expect(yml).not.toMatch(/^ {2}(schedule|pull_request\w*|push|workflow_run):/m);
    expect(yml).toMatch(/^permissions: \{\}$/m);
    expect(yml).toMatch(/^ {4}if: github\.ref == 'refs\/heads\/main'$/m);
    expect(yml).toMatch(/^ {4}environment: essay-ingest$/m);
    expect(yml).toMatch(/^ {4}timeout-minutes: 30$/m);
    expect(yml).toMatch(/group: essay-ingest\n {2}cancel-in-progress: false/);
    expect(yml.match(/^ {2}[a-z-]+:\n {4}if:/gm)).toHaveLength(1);
    expect(yml).toMatch(/ {4}permissions:\n {6}contents: read\n {6}id-token: write\n/);
  });

  it("validates the ids from env before anything uses them, never inline in a run", () => {
    expect(yml).toContain("BOOK_IDS: ${{ inputs.book_ids }}");
    expect(yml).toContain("'^[1-9][0-9]{0,6}$'");
    const runs = [...yml.matchAll(/run: [|>]?-?\n?(.*(?:\n {10}.*)*)/g)].map((m) => m[1]).join("\n");
    expect(runs).not.toContain("${{");
    expect(yml.indexOf("Validate book ids")).toBeLessThan(yml.indexOf("actions/checkout"));
    expect(yml.indexOf("Validate book ids")).toBeLessThan(yml.indexOf("--phase fetch"));
  });

  it("fetches before any AWS credential exists, with no AWS or secret values in that step", () => {
    const aws = yml.indexOf("aws-actions/configure-aws-credentials@");
    expect(aws).toBeGreaterThan(yml.indexOf("--phase fetch"));
    expect(yml.split("aws-actions/")).toHaveLength(2);
    const fetch = step("--phase fetch");
    expect(fetch).not.toMatch(/AWS|secret|--bucket|--confirm|vars\./i);
    expect(fetch).toContain('--dir "$RUNNER_TEMP/gutenberg"');
  });

  it("assumes only the essay-ingest role and gates the store steps on its variable", () => {
    expect(yml).toContain("role-to-assume: ${{ vars.AWS_ROLE_ESSAY_INGEST_ARN }}");
    const gate = "if: vars.AWS_ROLE_ESSAY_INGEST_ARN != ''";
    expect(step("aws-actions/configure-aws-credentials@")).toContain(gate);
    const store = step("--phase store");
    expect(store).toContain(gate);
    expect(store).toContain("--secret kcw/prod/pipeline");
    expect(yml.indexOf("--phase store")).toBeGreaterThan(aws());
    expect(yml.split("--phase store")).toHaveLength(2);
  });

  it("pins actions and installs without lifecycle scripts like the other workflows", () => {
    expect(yml).toContain("pnpm install --frozen-lockfile --ignore-scripts");
    expect(yml).toContain("persist-credentials: false");
    expect(yml).not.toMatch(/uses: actions\/cache|cache: true/);
    for (const m of yml.matchAll(/uses: (\S+)@(\S+)/g)) expect(m[2]).toMatch(/^v\d/);
  });
});

function aws(): number {
  return yml.indexOf("aws-actions/configure-aws-credentials@");
}

describe("kcw-gh-essay-ingest role", () => {
  const start = iam.indexOf('data "aws_iam_policy_document" "essay_ingest"');
  const policy = iam.slice(start, iam.indexOf("resource \"aws_iam_role_policy\" \"essay_ingest\"", start) + 200);

  it("trusts exactly the essay-ingest environment", () => {
    expect([...iam.matchAll(/"kcw-gh-essay-ingest"\s*=\s*\[([^\]]*)\]/g)]).toHaveLength(1);
    expect(iam).toContain('"kcw-gh-essay-ingest" = ["${local.github_sub}:environment:essay-ingest"]');
    expect(/"kcw-gh-essay-ingest"\s*=\s*\[([^\]]*)\]/.exec(iam)![1]).not.toContain("*");
    expect(policy).not.toMatch(/principals|identifiers/);
  });

  it("can read only the pipeline secret and put only under essays/text/", () => {
    const actions = [...policy.matchAll(/actions\s*=\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1]!.matchAll(/"([^"]+)"/g)].map((a) => a[1]));
    expect(actions).toEqual(["secretsmanager:GetSecretValue", "s3:PutObject"]);
    const resources = [...policy.matchAll(/resources\s*=\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1]!.matchAll(/"([^"]+)"/g)].map((a) => a[1]));
    expect(resources).toEqual(["${local.secret_arn}:kcw/prod/pipeline-??????", "${aws_s3_bucket.pipelines.arn}/essays/text/*"]);
    expect(policy).not.toMatch(/sqs|s3:(Get|List|Delete)|effect\s*=\s*"Allow"\s*\n\s*actions\s*=\s*\["\*"\]/);
    expect(policy).toContain('role   = aws_iam_role.github["kcw-gh-essay-ingest"].id');
  });

  it("exposes the role ARN as a repo variable output", () => {
    expect(outputs).toMatch(/AWS_ROLE_ESSAY_INGEST_ARN\s*=\s*aws_iam_role\.github\["kcw-gh-essay-ingest"\]\.arn/);
  });
});
