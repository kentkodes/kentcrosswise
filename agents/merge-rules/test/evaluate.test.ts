import { describe, expect, it } from "vitest";
import { summarizePlan, type TerraformPlanJson } from "../../../scripts/lib/plan-summary";
import approvedDeps from "../approved-deps.json" with { type: "json" };
import {
  PACKAGE_NAME,
  addedLines,
  evaluate,
  type ChangedFile,
  type LockDiff,
  type MergeRulesInput,
  type PlanSummary,
} from "../src/index";

const EMPTY_PLAN: PlanSummary = {
  format: 1,
  infra: [],
  artifact: { count: 3, kinds: { create: 1, update: 2, delete: 0, replace: 0 } },
};
const NO_DEPS: LockDiff = { added: [], existing: [] };

/** A non-critical baseline: an ordinary code change, a build-only prod plan, no new deps. */
function input(over: Partial<MergeRulesInput> = {}): MergeRulesInput {
  return {
    files: [{ path: "packages/essays/src/index.ts", status: "modified" }],
    patches: { "packages/essays/src/index.ts": "@@ -1 +1 @@\n-a\n+b\n" },
    planSummary: EMPTY_PLAN,
    lockDiff: NO_DEPS,
    author: "kcw-developer[bot]",
    ...over,
  };
}

function withFile(path: string, patch?: string, status: ChangedFile["status"] = "modified"): MergeRulesInput {
  return input({ files: [{ path, status }], patches: patch === undefined ? {} : { [path]: patch } });
}

const sqlPatch = (...lines: string[]) => `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;

describe("@kcw/merge-rules", () => {
  it("is importable", () => {
    expect(PACKAGE_NAME).toBe("@kcw/merge-rules");
  });

  it("the baseline is not critical", () => {
    expect(evaluate(input())).toEqual({ critical: false, reasons: [] });
  });
});

describe("drop/rename in SQL", () => {
  const MIG = "packages/db/migrations/0003_x.sql";

  it("DROP is critical", () => {
    const r = evaluate(withFile(MIG, sqlPatch("ALTER TABLE todos DROP COLUMN done;"), "added"));
    expect(r).toEqual({ critical: true, reasons: [`SQL drops or renames: ${MIG}`] });
  });

  it("RENAME is critical", () => {
    const r = evaluate(withFile(MIG, sqlPatch("ALTER TABLE ideas", "  rename COLUMN body TO text;"), "added"));
    expect(r.critical).toBe(true);
    expect(r.reasons).toEqual([`SQL drops or renames: ${MIG}`]);
  });

  it("additive SQL, and DROP only in a comment or a removed line, is not critical", () => {
    const patch = `@@ -1,1 +1,2 @@\n-DROP TABLE old_thing;\n+CREATE TABLE dropbox_links (id int); -- never DROP this\n+CREATE INDEX renamed_at_idx ON todos (created_at);\n`;
    expect(evaluate(withFile(MIG, patch, "added")).critical).toBe(false);
  });

  it("an SQL file without a diff is critical (fails closed)", () => {
    expect(evaluate(withFile(MIG, undefined, "added")).reasons).toEqual([
      `SQL diff unavailable, cannot check for DROP/RENAME: ${MIG}`,
    ]);
  });
});

describe("auth / secrets / IAM / .github/** / .claude/** paths", () => {
  it.each([
    ["apps/web/src/auth/config.ts", "authentication"],
    ["apps/web/src/app/api/auth/[...nextauth]/route.ts", "authentication"],
    ["apps/web/src/auth/preview-login.ts", "authentication"],
    ["apps/web/src/server/origin-wrapper.ts", "authentication"],
    ["apps/web/open-next.config.ts", "authentication"],
    ["apps/web/src/app/(owner)/layout.tsx", "authentication"],
    ["packages/secrets/src/store.ts", "secrets"],
    ["apps/web/.env.local", "secrets"],
    ["scripts/repo-settings/main-protection.json", "permissions"],
    ["scripts/lib/repo-settings.ts", "permissions"],
    ["docs/runbooks/iam-notes.md", "permissions"],
    [".github/workflows/ci.yml", "GitHub workflows/settings (.github/**)"],
    [".github/actions/setup/action.yml", "GitHub workflows/settings (.github/**)"],
    [".claude/settings.json", "agent configuration (.claude/**)"],
    [".claude/skills/qa/SKILL.md", "agent configuration (.claude/**)"],
  ])("%s is critical (%s)", (path, label) => {
    const r = evaluate(withFile(path, "@@\n+x\n"));
    expect(r.critical).toBe(true);
    expect(r.reasons).toContain(`${label}: ${path}`);
  });

  it("IAM in non-prod Terraform is critical", () => {
    const path = "infra/preview/main.tf";
    const r = evaluate(withFile(path, `@@ -1 +1,3 @@\n+resource "aws_iam_role_policy" "extra" {\n+}\n`));
    expect(r.reasons).toEqual([`permissions (IAM in Terraform): ${path}`]);
  });

  it("non-IAM preview Terraform is not critical", () => {
    expect(evaluate(withFile("infra/preview/main.tf", `@@\n+  memory_size = 1024\n`)).critical).toBe(false);
  });

  it("renaming a file out of a critical path is still critical", () => {
    const r = evaluate(
      input({ files: [{ path: "apps/web/src/lib/session.ts", previousPath: "apps/web/src/auth/settings.ts", status: "renamed" }] }),
    );
    expect(r.reasons).toEqual(["authentication: apps/web/src/auth/settings.ts"]);
  });

  it("words that only contain 'auth' are not auth", () => {
    expect(evaluate(withFile("packages/essays/src/author.ts", "@@\n+x\n")).critical).toBe(false);
  });
});

describe("production Terraform", () => {
  it.each(["infra/prod/main.tf", "infra/modules/web/main.tf", "infra/bootstrap/backend.tf"])("%s is critical", (path) => {
    expect(evaluate(withFile(path, "@@\n+# comment\n")).critical).toBe(true);
  });
});

describe("prod plan non-empty (Q6: the infra list)", () => {
  it("an infra update is critical", () => {
    const planSummary: PlanSummary = {
      ...EMPTY_PLAN,
      infra: [{ address: "module.web.aws_lambda_function.server", kind: "update", changed: ["memory_size"] }],
    };
    expect(evaluate(input({ planSummary }))).toEqual({
      critical: true,
      reasons: ["production infrastructure change (update): module.web.aws_lambda_function.server"],
    });
  });

  it("a summary with only artifact changes is not critical", () => {
    // Built with the real summarizer: new Lambda code, BUILD_ID env, uploaded assets and cache files.
    const plan: TerraformPlanJson = {
      resource_changes: [
        {
          address: "module.web.aws_lambda_function.server",
          type: "aws_lambda_function",
          name: "server",
          mode: "managed",
          change: {
            actions: ["update"],
            before: { source_code_hash: "a", environment: [{ variables: { OPEN_NEXT_BUILD_ID: "b1" } }] },
            after: { source_code_hash: "b", environment: [{ variables: { OPEN_NEXT_BUILD_ID: "b2" } }] },
            after_unknown: { last_modified: true },
          },
        },
        {
          address: 'module.web.aws_s3_object.assets["_next/static/x.js"]',
          type: "aws_s3_object",
          name: "assets",
          mode: "managed",
          change: { actions: ["create"] },
        },
        {
          address: 'module.web.aws_s3_object.cache["b1/index.html"]',
          type: "aws_s3_object",
          name: "cache",
          mode: "managed",
          change: { actions: ["delete"] },
        },
      ],
    };
    const planSummary = summarizePlan(plan);
    expect(planSummary.infra).toEqual([]);
    expect(planSummary.artifact.count).toBe(3);
    expect(evaluate(input({ planSummary }))).toEqual({ critical: false, reasons: [] });
  });

  it("a missing plan summary is critical (fails closed)", () => {
    expect(evaluate(input({ planSummary: null })).reasons).toEqual([
      "prod plan summary missing: cannot check production infrastructure or cost",
    ]);
  });
});

describe("docs/**/SPEC.md", () => {
  it.each([
    ["docs/hub/SPEC.md", "modified"],
    ["docs/essays/SPEC.md", "removed"],
    ["docs/SPEC.md", "added"],
  ] as const)("%s (%s) is critical", (path, status) => {
    expect(evaluate(withFile(path, "@@\n+x\n", status)).reasons).toEqual([`product spec (docs/**/SPEC.md): ${path}`]);
  });
});

describe("dependencies (C4)", () => {
  it("a new dependency not on approved-deps.json is critical", () => {
    const r = evaluate(
      input({
        files: [{ path: "agents/report/package.json", status: "modified" }, { path: "pnpm-lock.yaml", status: "modified" }],
        lockDiff: { added: [{ importer: "agents/report", name: "left-pad" }], existing: [] },
      }),
    );
    expect(r).toEqual({ critical: true, reasons: ["new dependency not on the allowlist: left-pad (agents/report)"] });
  });

  it("a new dependency on the list (exact or scope glob) is not critical", () => {
    const r = evaluate(
      input({
        lockDiff: {
          added: [
            { importer: "agents/orchestrator", name: "@langchain/langgraph" },
            { importer: "agents/orchestrator", name: "@aws-sdk/client-secrets-manager" },
          ],
          existing: ["@aws-sdk/client-secrets-manager"],
        },
      }),
    );
    expect(r).toEqual({ critical: false, reasons: [] });
  });

  it("any edit of approved-deps.json is critical", () => {
    const path = "agents/merge-rules/approved-deps.json";
    expect(evaluate(withFile(path, '@@\n+  "left-pad",\n')).reasons).toEqual([`dependency allowlist edit: ${path}`]);
  });

  it("a package.json change without a lockfile diff is critical (fails closed)", () => {
    const r = evaluate(input({ files: [{ path: "packages/core/package.json", status: "modified" }], lockDiff: null }));
    expect(r.reasons).toEqual(["lockfile diff missing: cannot check new dependencies"]);
  });

  it("uses the checked-in allowlist by default", () => {
    for (const name of ["zod", "@aws-sdk/client-s3", "@auth/core"]) {
      expect(evaluate(input({ lockDiff: { added: [{ importer: "x", name }], existing: [name] } })).critical).toBe(false);
    }
    expect(approvedDeps).toContain("zod");
  });
});

describe("new service", () => {
  it("a new Terraform provider is critical", () => {
    const path = "infra/preview/.terraform.lock.hcl";
    const patch = '@@\n+provider "registry.terraform.io/hashicorp/google" {\n+  version = "7.0.0"\n+}\n';
    expect(evaluate(withFile(path, patch)).reasons).toEqual([
      `new service (Terraform provider registry.terraform.io/hashicorp/google): ${path}`,
    ]);
  });

  it("an AWS SDK client the workspace did not use before is critical", () => {
    const lockDiff: LockDiff = {
      added: [{ importer: "agents/orchestrator", name: "@aws-sdk/client-dynamodb" }],
      existing: ["@aws-sdk/client-s3"],
    };
    expect(evaluate(input({ lockDiff })).reasons).toEqual(["new service (@aws-sdk/client-dynamodb): agents/orchestrator"]);
  });

  it("an AWS SDK client already used elsewhere is not a new service", () => {
    const lockDiff: LockDiff = {
      added: [{ importer: "agents/report", name: "@aws-sdk/client-sqs" }],
      existing: ["@aws-sdk/client-sqs"],
    };
    expect(evaluate(input({ lockDiff })).critical).toBe(false);
  });

  it("a provider version bump is not a new service", () => {
    const patch = '@@\n provider "registry.terraform.io/hashicorp/aws" {\n-  version = "6.1.0"\n+  version = "6.2.0"\n';
    expect(evaluate(withFile("infra/preview/.terraform.lock.hcl", patch)).critical).toBe(false);
  });
});

describe("cost (any prod plan create)", () => {
  it("an infra create is reported as cost too", () => {
    const planSummary: PlanSummary = {
      ...EMPTY_PLAN,
      infra: [{ address: "aws_sqs_queue.extra", kind: "create", changed: [] }],
    };
    expect(evaluate(input({ planSummary })).reasons).toEqual([
      "cost (prod plan creates a resource): aws_sqs_queue.extra",
      "production infrastructure change (create): aws_sqs_queue.extra",
    ]);
  });

  it("artifact creates (uploaded files) are not cost", () => {
    const planSummary: PlanSummary = { ...EMPTY_PLAN, artifact: { count: 50, kinds: { create: 50, update: 0, delete: 0, replace: 0 } } };
    expect(evaluate(input({ planSummary })).critical).toBe(false);
  });
});

describe("non-critical docs (C3)", () => {
  it.each(["docs/DESIGN.md", "AGENTS.md", "docs/agents/developer.md", "docs/agents/qa.md", "docs/research/infra.md"])(
    "%s is not critical",
    (path) => {
      expect(evaluate(withFile(path, "@@\n+x\n"))).toEqual({ critical: false, reasons: [] });
    },
  );

  it("several findings are sorted and de-duplicated", () => {
    const r = evaluate(
      input({
        files: [
          { path: ".github/workflows/ci.yml", status: "modified" },
          { path: ".claude/settings.json", status: "modified" },
          { path: "docs/DESIGN.md", status: "modified" },
        ],
        patches: {},
      }),
    );
    expect(r.reasons).toEqual([
      "GitHub workflows/settings (.github/**): .github/workflows/ci.yml",
      "agent configuration (.claude/**): .claude/settings.json",
    ]);
  });
});

describe("addedLines", () => {
  it("skips headers and context", () => {
    expect(addedLines("--- a/x\n+++ b/x\n@@ -1 +1 @@\n a\n-b\n+c\r\n")).toEqual(["c"]);
  });
});
