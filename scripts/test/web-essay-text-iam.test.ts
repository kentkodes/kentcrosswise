// Text-level guard for the web server's essay-text read grant (no AWS or Terraform calls).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (name: string) => readFileSync(path.join(root, name), "utf8").replace(/\r/g, "");
const code = (name: string) => read(name).replace(/^\s*#.*$/gm, "");
const webLambda = code("infra/modules/web/lambda.tf");
const prod = code("infra/prod/main.tf");
const preview = code("infra/preview/main.tf");

const quoted = (text: string) => [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

describe("web server essay-text read grant", () => {
  const start = webLambda.indexOf('sid       = "ReadEssayText"');
  const statement = start < 0 ? "" : webLambda.slice(start, webLambda.indexOf("\n    }\n  }", start));

  it("is one dynamic statement gated on the bucket ARN", () => {
    expect(start).toBeGreaterThan(0);
    expect(webLambda).toContain("for_each = var.essay_text_bucket_arn != null ? [1] : []");
  });

  it("grants s3:GetObject and nothing else", () => {
    const actions = /actions\s*=\s*\[([^\]]*)\]/.exec(statement)![1]!;
    expect(quoted(actions)).toEqual(["s3:GetObject"]);
    expect(statement).not.toMatch(/ListBucket|PutObject|DeleteObject|s3:\*/);
  });

  it("reads only the essays/text/ prefix of the bucket ARN", () => {
    const resources = /resources\s*=\s*\[([^\]]*)\]/.exec(statement)![1]!;
    expect(quoted(resources)).toEqual(["${var.essay_text_bucket_arn}/essays/text/*"]);
  });

  it("prod passes the bucket ARN and name; preview passes neither", () => {
    expect(prod).toMatch(/essay_text_bucket\s*=\s*"kentcrosswise-pipelines-\$\{data\.aws_caller_identity\.current\.account_id\}"/);
    expect(prod).toMatch(/essay_text_bucket_arn\s*=\s*"arn:aws:s3:::\$\{local\.essay_text_bucket\}"/);
    expect(prod).toMatch(/ESSAY_TEXT_BUCKET\s*=\s*local\.essay_text_bucket/);
    expect(preview).not.toContain("essay_text_bucket");
    expect(preview).not.toContain("ESSAY_TEXT_BUCKET");
  });
});
