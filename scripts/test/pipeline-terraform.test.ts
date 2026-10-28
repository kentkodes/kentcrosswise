// Text-level invariants of the E5 pipeline Terraform (no init, plan, credentials or AWS calls).
// They pin the inert-by-default gates and the IAM/queue/bucket hardening a review relied on.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (name: string) => readFileSync(path.join(root, name), "utf8");
/** Terraform source without comment lines, so a comment can neither satisfy nor break a check. */
const code = (name: string) => read(name).replace(/^\s*#.*$/gm, "");
const moduleMain = code("infra/modules/pipelines/main.tf");
const moduleVars = code("infra/modules/pipelines/variables.tf");
const prod = code("infra/prod/pipelines.tf");
const preview = code("infra/preview/pipelines.tf");
const bootstrapPipelines = code("infra/bootstrap/pipelines.tf");
const iam = code("infra/bootstrap/iam.tf");

/** The `{ ... }` body of the first block whose header matches, by brace counting. */
function block(source: string, header: RegExp): string {
  const match = header.exec(source);
  if (!match) throw new Error(`no block ${header}`);
  const start = source.indexOf("{", match.index + match[0].length - 1);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(start + 1, i);
  }
  throw new Error(`unbalanced block ${header}`);
}
const resource = (source: string, type: string, name: string) => block(source, new RegExp(`resource "${type}" "${name}" \\{`));
const data = (source: string, type: string, name: string) => block(source, new RegExp(`data "${type}" "${name}" \\{`));
const variable = (source: string, name: string) => block(source, new RegExp(`variable "${name}" \\{`));
const attr = (body: string, name: string) => new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, "m").exec(body)?.[1]?.trim();

describe("pipeline stacks stay inert by default", () => {
  it.each([["prod", prod, "pipelines_deployed"], ["preview", preview, "pipelines_preview"]])(
    "%s: opt-in defaults false and runtime/schedules are hard-coded false",
    (_stack, source, gate) => {
      expect(attr(variable(source, gate), "default")).toBe("false");
      const mod = block(source, /module "pipelines" \{/);
      expect(attr(mod, "count")).toBe(`var.${gate} ? 1 : 0`);
      expect(attr(mod, "runtime_enabled")).toBe("false");
      expect(attr(mod, "schedules_enabled")).toBe("false");
      expect(source).not.toMatch(/runtime_policy_json/);
    },
  );

  it("module gates default false and drive the Lambda env and schedule state", () => {
    expect(attr(variable(moduleVars, "runtime_enabled"), "default")).toBe("false");
    expect(attr(variable(moduleVars, "schedules_enabled"), "default")).toBe("false");
    const fn = resource(moduleMain, "aws_lambda_function", "watcher");
    expect(attr(fn, "KCW_PIPELINES_ENABLED")).toBe("tostring(var.runtime_enabled)");
    const schedule = resource(moduleMain, "aws_scheduler_schedule", "sources");
    expect(attr(schedule, "state")).toBe('var.schedules_enabled ? "ENABLED" : "DISABLED"');
  });

  it("does not schedule Wikisource by default but still allows it", () => {
    const schedules = variable(moduleVars, "schedule_expressions");
    expect(block(schedules, /default = \{/)).not.toMatch(/wikisource/);
    expect(block(schedules, /validation \{/)).toMatch(/"wikisource-en"/);
  });

  it("reserves no concurrency by default", () => {
    expect(attr(variable(moduleVars, "reserved_concurrency"), "default")).toBe("null");
    expect(attr(resource(moduleMain, "aws_lambda_function", "watcher"), "reserved_concurrent_executions")).toBe("var.reserved_concurrency");
  });

  it("never lets Lambda retry a failed run", () => {
    expect(attr(resource(moduleMain, "aws_lambda_function_event_invoke_config", "watcher"), "maximum_retry_attempts")).toBe("0");
  });
});

describe("pipeline module IAM", () => {
  const policies = [...moduleMain.matchAll(/data "aws_iam_policy_document" "(\w+)" \{/g)].map((m) => data(moduleMain, "aws_iam_policy_document", m[1]!));

  it("has no wildcard action or resource and no NotAction/NotResource", () => {
    expect(policies.length).toBeGreaterThanOrEqual(4);
    for (const p of policies) {
      for (const list of p.matchAll(/(actions|resources|identifiers)\s*=\s*\[([^\]]*)\]/g)) {
        for (const value of list[2]!.matchAll(/"([^"]*)"/g)) {
          expect(value[1]).not.toBe("*");
          if (list[1] === "actions") expect(value[1]).not.toMatch(/\*/);
        }
      }
      expect(p).not.toMatch(/not_actions|not_resources/);
    }
  });

  it("builds the runtime policy in the module from exact ARNs, never from an input", () => {
    expect(moduleVars).not.toMatch(/policy_json/);
    expect(attr(resource(moduleMain, "aws_iam_role_policy", "watcher"), "policy")).toBe("data.aws_iam_policy_document.watcher.json");
    const runtime = data(moduleMain, "aws_iam_policy_document", "watcher");
    const actions = [...runtime.matchAll(/actions\s*=\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1]!.matchAll(/"([^"]+)"/g)].map((v) => v[1]));
    expect(actions.sort()).toEqual([
      "logs:CreateLogStream", "logs:PutLogEvents", "s3:GetObject", "s3:ListBucket", "s3:PutObject",
      "secretsmanager:GetSecretValue", "sqs:SendMessage", "ssm:GetParameter",
    ]);
    expect(runtime).toContain('resources = ["${local.bucket_arn}/${local.metadata_prefix}/*"]');
    expect(runtime).toMatch(/variable = "s3:prefix"\s*values\s*= \["\$\{local\.metadata_prefix\}\/\*"\]/);
    expect(runtime).toContain("resources = [aws_sqs_queue.essay_urls.arn]");
    expect(runtime).toContain('resources = ["${aws_cloudwatch_log_group.watcher.arn}:*"]');
    expect(moduleMain).toContain('metadata_prefix = "pipelines/meta"');
    expect(moduleMain).toContain(":secret:${var.credential_name}-??????");
  });

  it("puts the boundary on both roles", () => {
    for (const role of ["watcher", "scheduler"]) {
      expect(attr(resource(moduleMain, "aws_iam_role", role), "permissions_boundary")).toBe("var.permissions_boundary_arn");
    }
    expect(attr(block(preview, /module "pipelines" \{/), "permissions_boundary_arn")).toBe("local.boundary");
  });
});

describe("pipeline queues", () => {
  it("encrypts both queues and dead-letters after 5 receives", () => {
    for (const q of ["essay_urls", "dead_letters"]) {
      expect(attr(resource(moduleMain, "aws_sqs_queue", q), "sqs_managed_sse_enabled")).toBe("true");
    }
    const urls = resource(moduleMain, "aws_sqs_queue", "essay_urls");
    expect(attr(urls, "maxReceiveCount")).toBe("5");
    expect(attr(urls, "deadLetterTargetArn")).toBe("aws_sqs_queue.dead_letters.arn");
    expect(attr(urls, "visibility_timeout_seconds")).toBe("var.queue_visibility_timeout_s");
  });
});

describe("pipeline metadata bucket", () => {
  it("expires noncurrent metadata versions after 30 days and aborts stale uploads after 7", () => {
    const lifecycle = resource(bootstrapPipelines, "aws_s3_bucket_lifecycle_configuration", "pipelines");
    expect(attr(lifecycle, "bucket")).toBe("aws_s3_bucket.pipelines.id");
    expect(lifecycle).toMatch(/prefix = "pipelines\/meta\/"[\s\S]*?noncurrent_days = 30/);
    expect(lifecycle).toMatch(/days_after_initiation = 7/);
    expect(attr(block(resource(bootstrapPipelines, "aws_s3_bucket_versioning", "pipelines"), /versioning_configuration \{/), "status")).toBe('"Enabled"');
  });
});

describe("bootstrap preview permissions for pipelines", () => {
  it("lets previews manage only kcw-pr-* schedules and pass only their scheduler role to Scheduler", () => {
    const ci = data(iam, "aws_iam_policy_document", "ci");
    expect(ci).toContain('resources = ["${local.scheduler_arn}:schedule-group/${local.preview_names}"]');
    expect(ci).toContain('resources = ["${local.scheduler_arn}:schedule/${local.preview_names}/*"]');
    const passRole = /sid\s*=\s*"PassPreviewSchedulerRoles"([\s\S]*?)\n {2}\}/.exec(ci)?.[1] ?? "";
    expect(passRole).toContain('resources = ["${local.iam_arn}:role/${local.preview_names}-essay-scheduler"]');
    expect(passRole).toMatch(/variable = "iam:PassedToService"\s*values\s*= \["scheduler\.amazonaws\.com"\]/);
  });

  it("boundary allows invoking preview functions only", () => {
    const boundary = data(iam, "aws_iam_policy_document", "preview_boundary");
    expect(boundary).toMatch(/actions\s*= \["lambda:InvokeFunction"\]\s*resources = \["\$\{local\.lambda_arn\}:function:\$\{local\.preview_names\}"\]/);
  });
});
