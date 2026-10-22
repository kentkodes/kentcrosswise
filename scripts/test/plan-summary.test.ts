import { describe, expect, it } from "vitest";
import { changeKind, changedPaths, summarizePlan, summaryMarkdown, type TerraformPlanJson } from "../lib/plan-summary";

const SECRET = "fake-origin-value-not-real-0000";

function rc(address: string, type: string, actions: string[], before: unknown = null, after: unknown = null, afterUnknown: unknown = {}) {
  const name = address.split(".").slice(-1)[0]!.replace(/\[.*$/, "");
  return { address, mode: "managed" as const, type, name, change: { actions, before, after, after_unknown: afterUnknown } };
}

const lambdaBefore = {
  function_name: "kcw-prod-server",
  memory_size: 1024,
  source_code_hash: "aaa",
  last_modified: "2026-10-22T10:00:00Z",
  environment: [{ variables: { OPEN_NEXT_BUILD_ID: "b1", KCW_WEB_SECRET: "kcw/prod/web" } }],
};

describe("changeKind", () => {
  it("maps Terraform action lists", () => {
    expect(changeKind(["create"])).toBe("create");
    expect(changeKind(["update"])).toBe("update");
    expect(changeKind(["delete"])).toBe("delete");
    expect(changeKind(["delete", "create"])).toBe("replace");
    expect(changeKind(["create", "delete"])).toBe("replace");
    expect(changeKind(["no-op"])).toBeUndefined();
    expect(changeKind(["read"])).toBeUndefined();
  });
});

describe("changedPaths", () => {
  it("finds differing leaves and unknown-after-apply paths", () => {
    const after = { ...lambdaBefore, source_code_hash: "bbb", last_modified: null, environment: [{ variables: { OPEN_NEXT_BUILD_ID: "b2", KCW_WEB_SECRET: "kcw/prod/web" } }] };
    expect(changedPaths(lambdaBefore, after, { last_modified: true })).toEqual([
      "environment.0.variables.OPEN_NEXT_BUILD_ID",
      "last_modified",
      "source_code_hash",
    ]);
  });

  it("treats added and removed keys as changes", () => {
    expect(changedPaths({ a: 1 }, { b: 2 }, {})).toEqual(["a", "b"]);
    expect(changedPaths({ list: [1, 2] }, { list: [1] }, {})).toEqual(["list.1"]);
  });
});

describe("summarizePlan", () => {
  it("is empty when nothing changes", () => {
    const plan: TerraformPlanJson = {
      resource_changes: [rc("module.web.aws_s3_bucket.assets", "aws_s3_bucket", ["no-op"]), { ...rc("data.x.y", "x", ["read"]), mode: "data" }],
    };
    expect(summarizePlan(plan)).toEqual({ format: 1, infra: [], artifact: { count: 0, kinds: { create: 0, update: 0, delete: 0, replace: 0 } } });
  });

  it("counts a new build (code, build id, assets, cache) as artifact only", () => {
    const after = { ...lambdaBefore, source_code_hash: "bbb", environment: [{ variables: { OPEN_NEXT_BUILD_ID: "b2", KCW_WEB_SECRET: "kcw/prod/web" } }] };
    const plan: TerraformPlanJson = {
      resource_changes: [
        rc("module.web.aws_lambda_function.server", "aws_lambda_function", ["update"], lambdaBefore, after, { last_modified: true }),
        rc('module.web.aws_s3_object.assets["_next/static/abc.js"]', "aws_s3_object", ["create"]),
        rc('module.web.aws_s3_object.assets["_next/static/old.js"]', "aws_s3_object", ["delete"]),
        rc('module.web.aws_s3_object.cache["b2/index.cache"]', "aws_s3_object", ["create"]),
        rc('module.web.aws_s3_object.assets["BUILD_ID"]', "aws_s3_object", ["update"], { etag: "1" }, { etag: "2" }),
      ],
    };
    const s = summarizePlan(plan);
    expect(s.infra).toEqual([]);
    expect(s.artifact).toEqual({ count: 5, kinds: { create: 2, update: 2, delete: 1, replace: 0 } });
  });

  it("reports infrastructure changes with their changed paths", () => {
    const after = { ...lambdaBefore, memory_size: 2048, source_code_hash: "bbb" };
    const plan: TerraformPlanJson = {
      resource_changes: [
        rc("module.web.aws_lambda_function.server", "aws_lambda_function", ["update"], lambdaBefore, after),
        rc("module.web.aws_cloudfront_distribution.this", "aws_cloudfront_distribution", ["update"], { price_class: "A" }, { price_class: "B" }),
        rc("module.orchestrator.aws_sqs_queue.in", "aws_sqs_queue", ["create"]),
        rc("module.web.aws_lambda_function.image", "aws_lambda_function", ["delete", "create"]),
        rc("aws_s3_object.config", "aws_s3_object", ["create"]),
      ],
    };
    const s = summarizePlan(plan);
    expect(s.infra).toEqual([
      { address: "aws_s3_object.config", kind: "create", changed: [] },
      { address: "module.orchestrator.aws_sqs_queue.in", kind: "create", changed: [] },
      { address: "module.web.aws_cloudfront_distribution.this", kind: "update", changed: ["price_class"] },
      { address: "module.web.aws_lambda_function.image", kind: "replace", changed: [] },
      { address: "module.web.aws_lambda_function.server", kind: "update", changed: ["memory_size", "source_code_hash"] },
    ]);
    expect(s.artifact.count).toBe(0);
  });

  it("never copies values into the summary or the markdown", () => {
    const before = { custom_header: [{ name: "x-kcw-origin", value: "old-" + SECRET }] };
    const after = { custom_header: [{ name: "x-kcw-origin", value: SECRET }] };
    const plan: TerraformPlanJson = {
      resource_changes: [rc("module.web.aws_cloudfront_distribution.this", "aws_cloudfront_distribution", ["update"], before, after)],
    };
    const s = summarizePlan(plan);
    const text = JSON.stringify(s) + summaryMarkdown(s);
    expect(text).not.toContain(SECRET);
    expect(s.infra[0]?.changed).toEqual(["custom_header.0.value"]);
  });
});

describe("summaryMarkdown", () => {
  it("says when there is nothing to review", () => {
    const md = summaryMarkdown(summarizePlan({ resource_changes: [] }));
    expect(md).toContain("No infrastructure changes.");
    expect(md).toContain("Build artifact changes: 0");
  });
});
