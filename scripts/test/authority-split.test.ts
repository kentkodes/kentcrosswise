// AR1 slice 1 source contracts (authority and secret split): no credentials, AWS requests or state.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (name: string) => readFileSync(path.join(root, name), "utf8");
const code = (name: string) => read(name).replace(/^\s*#.*$/gm, "");
const iam = code("infra/bootstrap/iam.tf");

/** The body of the aws_iam_policy_document `name`, up to its closing brace. */
function policyDoc(name: string): string {
  const start = iam.indexOf(`data "aws_iam_policy_document" "${name}" {`);
  expect(start).toBeGreaterThan(-1);
  return iam.slice(start, iam.indexOf("\n}\n", start) + 3);
}

/** One `statement { ... }` by sid (statements close with two-space indentation). */
function statement(doc: string, sid: string): string {
  const match = new RegExp(`sid\\s*=\\s*"${sid}"([\\s\\S]*?)\\n {2}\\}\\n`).exec(doc);
  expect(match, `statement ${sid}`).not.toBeNull();
  return match![1]!;
}

const boundary = policyDoc("preview_boundary");
const ci = policyDoc("ci");
const tag = "kcw-pr-&{aws:PrincipalTag/kcw:pr}";

describe("preview runtime boundary", () => {
  it("reads only the e2e login secret, never kcw/ci (the Neon key)", () => {
    expect(statement(boundary, "CiSecret")).toContain("kcw/ci/e2e-login-??????");
    expect(boundary).not.toContain("kcw/ci-??????");
  });

  it("scopes every PR resource to the role's own kcw:pr tag, exactly or with a dash suffix", () => {
    expect(boundary).not.toContain("local.preview_names");
    expect(boundary).not.toContain("kcw-pr-*");
    for (const sid of ["Logs", "PreviewBuckets", "PreviewQueues", "InvokePreviewFunctions"]) {
      const body = statement(boundary, sid);
      expect(body, sid).toContain(tag);
      expect(body, sid).toContain(`${tag}-*`);
      // pr-1 must not match pr-12: never "<tag>*" without the dash.
      expect(body, sid).not.toContain("kcw:pr}*");
    }
    const params = statement(boundary, "PreviewParameters");
    expect(params).toContain("parameter/kcw/preview/pr-&{aws:PrincipalTag/kcw:pr}/*");
    expect(params).not.toContain("parameter/kcw/preview/*");
  });
});

describe("kcw-gh-ci", () => {
  it("has no pull_request subject, and neither has kcw-gh-plan: it trusts only the prod-plan environment", () => {
    const subs = (role: string) => new RegExp(`"${role}"\\s*=\\s*\\[([^\\]]*)\\]`).exec(iam)?.[1];
    expect(subs("kcw-gh-ci")).toBe('"${local.github_sub}:environment:preview-gc"');
    const plan = [...(subs("kcw-gh-plan") ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(plan).toEqual(["${local.github_sub}:environment:prod-plan"]);
    expect(iam).not.toContain(":pull_request");
  });

  it("reads kcw/ci and kcw/ci/e2e-login", () => {
    const secret = statement(ci, "CiSecret");
    expect(secret).toContain("kcw/ci-??????");
    expect(secret).toContain("kcw/ci/e2e-login-??????");
  });

  it("cannot create or update OACs or cache policies, only delete legacy ones", () => {
    for (const action of ["CreateCachePolicy", "UpdateCachePolicy", "CreateOriginAccessControl", "UpdateOriginAccessControl"]) {
      expect(ci).not.toContain(`cloudfront:${action}`);
    }
    const del = statement(ci, "DeleteLegacyPreviewOacAndCachePolicies");
    expect(del).toContain("cloudfront:DeleteOriginAccessControl");
    expect(del).toContain("cloudfront:DeleteCachePolicy");
  });

  it("denies touching a distribution tagged with any kcw:env but preview", () => {
    const deny = statement(ci, "NoTouchingNonPreviewDistributions");
    expect(deny).toMatch(/effect\s*=\s*"Deny"/);
    for (const action of ["TagResource", "UntagResource", "UpdateDistribution", "DeleteDistribution"]) {
      expect(deny).toContain(`cloudfront:${action}`);
    }
    expect(deny).toMatch(/test\s*=\s*"Null"\s*variable\s*=\s*"aws:ResourceTag\/kcw:env"\s*values\s*=\s*\["false"\]/);
    expect(deny).toMatch(/test\s*=\s*"StringNotEquals"\s*variable\s*=\s*"aws:ResourceTag\/kcw:env"\s*values\s*=\s*\["preview"\]/);
  });

  it("has no kcw:pr retag deny, which would also block CreateRole with tags", () => {
    expect(ci).not.toContain("NoRetagPreviewRolePr");
    expect(ci).not.toContain("NoUntagPreviewRolePr");
  });
});

describe("shared preview CloudFront resources", () => {
  const shared = code("infra/bootstrap/cloudfront-preview.tf");
  const web = code("infra/modules/web/cloudfront.tf");

  it("bootstrap creates the named OACs and cache policies", () => {
    for (const name of ["kcw-preview-s3", "kcw-preview-lambda", "kcw-preview-server", "kcw-preview-image"]) {
      expect(shared).toContain(`"${name}"`);
    }
  });

  it("the web module creates its own only when shared_cloudfront is null, with moved blocks for prod", () => {
    expect(web).toMatch(/own_cloudfront\s*=\s*var\.shared_cloudfront == null/);
    for (const [type, name] of [
      ["origin_access_control", "s3"],
      ["origin_access_control", "lambda"],
      ["cache_policy", "server"],
      ["cache_policy", "image"],
    ]) {
      expect(web).toContain(`from = aws_cloudfront_${type}.${name}\n  to   = aws_cloudfront_${type}.${name}[0]`);
    }
    expect(code("infra/modules/web/variables.tf")).toMatch(/variable "shared_cloudfront" \{[\s\S]*?default\s*=\s*null/);
    expect(code("infra/prod/main.tf")).not.toContain("shared_cloudfront");
    expect(code("infra/preview/main.tf")).toContain("shared_cloudfront = {");
  });
});

describe("secret split", () => {
  const preview = code("infra/preview/main.tf");
  const prod = code("infra/prod/main.tf");
  const secrets = code("infra/bootstrap/secrets.tf");

  it("bootstrap declares the new containers and keeps kcw/ci to the Neon key", () => {
    expect(secrets).toMatch(/"kcw\/ci\/e2e-login"\s*=\s*"e2e_login/);
    expect(secrets).toMatch(/"kcw\/prod\/router"\s*=\s*"deepseek_api_key/);
    expect(secrets).toMatch(/"kcw\/ci"\s*=\s*"neon_api_key \(/);
    expect(secrets).not.toMatch(/"kcw\/ci"\s*=\s*"[^"]*e2e_login/);
  });

  it("the preview server reads only kcw/ci/e2e-login", () => {
    expect(preview).toMatch(/secret_names\s*=\s*\["kcw\/ci\/e2e-login"\]/);
    expect(preview).toMatch(/KCW_CI_SECRET\s*=\s*"kcw\/ci\/e2e-login"/);
    expect(preview).not.toContain('"kcw/ci"');
    expect(read("apps/web/src/auth/preview-login.ts")).toContain('DEFAULT_CI_SECRET = "kcw/ci/e2e-login"');
  });

  it("the prod web server reads kcw/prod/router, the orchestrator keeps kcw/prod/models", () => {
    // The web server's secrets, exactly: its own two, plus the Google refresh token it reads and
    // rewrites at consent. Never the orchestrator's secrets.
    const webSecrets = /module "web_secrets" \{[^}]*?names\s*=\s*\[([^\]]*)\]/.exec(prod)?.[1] ?? "";
    expect(webSecrets.match(/"[^"]+"/g)).toEqual(['"kcw/prod/web"', '"kcw/prod/router"', '"kcw/prod/google-owner-token"']);
    expect(prod).toContain('writable_secret_names = ["kcw/prod/google-owner-token", "kcw/prod/google-demo-token"]');
    expect(prod).toMatch(/KCW_GOOGLE_DEMO_TOKEN_SECRET\s*=\s*"kcw\/prod\/google-demo-token"/);
    expect(prod).toMatch(/KCW_WEB_SECRET\s*=\s*"kcw\/prod\/web"\s*KCW_MODELS_SECRET\s*=\s*"kcw\/prod\/router"/);
    expect(prod).toContain('names  = ["kcw/prod/orchestrator", "kcw/prod/models"]');
  });

  it("ci.yml reads no secrets; the trusted preview reads kcw/ci and takes the e2e login from an environment secret", () => {
    const ciYml = read(".github/workflows/ci.yml");
    expect(ciYml).not.toContain("kcw/ci");
    expect(ciYml).not.toContain("AWS_ROLE_CI_ARN");
    const trusted = read(".github/workflows/preview-trusted.yml");
    expect(trusted).toContain("KCW_CI, kcw/ci");
    expect(trusted).not.toContain("KCW_E2E, kcw/ci/e2e-login");
    expect(trusted).toContain("KCW_E2E_LOGIN: ${{ secrets.E2E_LOGIN }}");
  });
});
