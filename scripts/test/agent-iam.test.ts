// Source contracts only: no credentials, AWS requests, state or plan JSON are needed.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (name: string) => readFileSync(path.join(root, "infra/bootstrap", name), "utf8");
const iam = read("iam.tf");
const outputs = read("outputs.tf");
const agents = ["developer", "qa", "scraper", "docs"];

// This source contract deliberately pins the complete publisher permission template.
// Ignoring formatting/comments permits terraform fmt without weakening the contract.
const compact = (source: string) => source.replace(/^\s*#.*$/gm, "").replace(/\s+/g, "");
const publisherPolicy = iam.slice(iam.indexOf('data "aws_iam_policy_document" "agent"'));

describe("isolated publisher IAM source contracts", () => {
  it("preserves immutable repository identity, account and region inputs", () => {
    expect(read("main.tf")).toContain('github_sub  = "repo:${var.github_owner}@${var.github_owner_id}/${var.github_repo}@${var.github_repo_id}"');
    expect(read("main.tf")).toContain("account_id  = var.aws_account_id");
    expect(read("main.tf")).toContain("region      = var.aws_region");
    expect(read("variables.tf")).toMatch(/variable "github_owner_id"[\s\S]*?default\s*=\s*"107236483"/);
    expect(read("variables.tf")).toMatch(/variable "github_repo_id"[\s\S]*?default\s*=\s*"1430035147"/);
  });

  it("trusts only each publisher's exact environment and never the work job main ref", () => {
    const entries = [...iam.matchAll(/"(kcw-gh-[^"]+)"\s*=\s*\[([^\]]*)\]/g)]
      .map((match) => [match[1], [...match[2]!.matchAll(/"([^"]+)"/g)].map((value) => value[1])]);
    expect(Object.fromEntries(entries)).toEqual({
      "kcw-gh-ci": ["${local.github_sub}:pull_request", "${local.github_sub}:environment:preview-gc"],
      "kcw-gh-plan": ["${local.github_sub}:pull_request"],
      "kcw-gh-deploy": ["${local.github_sub}:environment:prod"],
      ...Object.fromEntries(agents.map((agent) => [`kcw-gh-agent-${agent}`, [`\${local.github_sub}:environment:agent-publish-${agent}`]])),
    });
    expect(iam).not.toContain(":ref:refs/heads/main");
    expect(iam).not.toMatch(/"kcw-gh-agent"/);
  });

  it("pins exact AWS audience and subject using StringEquals with the federated provider", () => {
    const trust = iam.slice(iam.indexOf('data "aws_iam_policy_document" "trust"'), iam.indexOf("# ---------- preview permissions boundary"));
    expect(compact(trust)).toBe(compact(`
      data "aws_iam_policy_document" "trust" {
        for_each = local.role_subs
        statement {
          actions = ["sts:AssumeRoleWithWebIdentity"]
          principals { type = "Federated" identifiers = [aws_iam_openid_connect_provider.github.arn] }
          condition { test = "StringEquals" variable = "\${local.oidc_host}:aud" values = ["sts.amazonaws.com"] }
          condition { test = "StringEquals" variable = "\${local.oidc_host}:sub" values = each.value }
        }
      }
      resource "aws_iam_role" "github" {
        for_each = local.role_subs
        name = each.key
        assume_role_policy = data.aws_iam_policy_document.trust[each.key].json
        max_session_duration = 3600
      }
    `));
  });

  it("grants exactly own App key GetSecretValue and existing queue SendMessage, with no role chaining", () => {
    expect(iam).toMatch(/github_apps\s*=\s*\["developer", "qa", "scraper", "docs"\]/);
    expect(compact(publisherPolicy)).toBe(compact(`
      data "aws_iam_policy_document" "agent" {
        for_each = toset(local.github_apps)
        statement {
          sid = "OwnAppKey"
          actions = ["secretsmanager:GetSecretValue"]
          resources = ["\${local.secret_arn}:kcw/github/\${each.key}-app-??????"]
        }
        statement {
          sid = "ReportToOrchestrator"
          actions = ["sqs:SendMessage"]
          resources = ["\${local.sqs_arn}:\${var.orchestrator_queue_name}"]
        }
      }
      resource "aws_iam_role_policy" "agent" {
        for_each = toset(local.github_apps)
        name = "kcw-gh-agent-\${each.key}"
        role = aws_iam_role.github["kcw-gh-agent-\${each.key}"].id
        policy = data.aws_iam_policy_document.agent[each.key].json
      }
    `));
  });

  it.each(agents)("exports only the dedicated %s role variable without a legacy fallback", (agent) => {
    expect(outputs).toMatch(new RegExp(`AWS_ROLE_AGENT_${agent.toUpperCase()}_ARN\\s*=\\s*aws_iam_role\\.github\\["kcw-gh-agent-${agent}"\\]\\.arn`));
    expect(outputs).not.toMatch(/\bAWS_ROLE_AGENT_ARN\b/);
  });
});
