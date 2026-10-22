// Merge-rules (P2-04, D8): a deterministic, pure critical-change detector.
// The orchestrator runs it on the latest head SHA of an approved PR (§4.2 step 7); a critical
// result keeps `kcw/merge-rules` pending and creates an `approvals(kind=critical_pr, reasons)` row.
//
// Rules (hub SPEC "Critical changes", AGENTS.md rule 10, DESIGN §8 P2-04, §11 C3/C4/Q6):
// - SQL that drops or renames (added lines of *.sql files);
// - authentication, secrets or permissions (paths; IAM in Terraform); `.github/**`; `.claude/**`;
// - production Terraform: `infra/prod`, `infra/modules/**`, `infra/bootstrap`, and a non-empty
//   `infra` list in the prod plan summary (Q6; build `artifact` changes are never critical);
// - any `docs/**/SPEC.md` change (C3);
// - a new direct dependency not on approved-deps.json, or any edit of that file (C4);
// - a new service (new Terraform provider, or a new AWS SDK client in the workspace);
// - cost: any create in the prod plan summary.
// Missing inputs fail closed: if a rule cannot be checked, the PR is critical.
import defaultApprovedDeps from "../approved-deps.json" with { type: "json" };

/** Package name, used by the workspace smoke test. */
export const PACKAGE_NAME = "@kcw/merge-rules";

export type FileStatus = "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";

/** One changed file of the PR (GitHub's "list pull request files" shape, renamed to camelCase). */
export interface ChangedFile {
  path: string;
  status: FileStatus;
  /** Old path of a renamed file. */
  previousPath?: string;
}

/** Copy of `scripts/lib/plan-summary.ts` PlanSummary (CI artifact `prod-plan-summary`), format 1. */
export interface PlanSummary {
  format: 1;
  infra: { address: string; kind: "create" | "update" | "delete" | "replace"; changed: string[] }[];
  artifact: { count: number; kinds: Record<"create" | "update" | "delete" | "replace", number> };
}

/** Direct dependencies added by the PR, from the `importers` section of pnpm-lock.yaml (base vs head). */
export interface LockDiff {
  /** Each direct dependency added to a workspace importer (e.g. `agents/report`). */
  added: { importer: string; name: string }[];
  /** Every direct dependency name of the base branch's workspace. Without it, any added AWS SDK client counts as a new service. */
  existing?: string[];
}

export interface MergeRulesInput {
  files: ChangedFile[];
  /** Unified diff per file path (GitHub omits it for binary or very large files). */
  patches: Readonly<Record<string, string | undefined>>;
  /** The prod plan summary of the PR's head; `null` if CI produced none (fails closed). */
  planSummary: PlanSummary | null;
  /** `null` if CI produced none: then any package.json or lockfile change is critical. */
  lockDiff: LockDiff | null;
  /** PR author login. Recorded for the caller; no v1 rule depends on it. */
  author: string;
  /** Defaults to agents/merge-rules/approved-deps.json as checked out (the orchestrator runs main's copy). */
  approvedDeps?: readonly string[];
}

export interface MergeRulesResult {
  critical: boolean;
  /** Human-readable, one per finding, sorted and de-duplicated. Paths and package names only. */
  reasons: string[];
}

export const APPROVED_DEPS_PATH = "agents/merge-rules/approved-deps.json";

/** Owner-only areas by path. Order does not matter; the label goes into the reason. */
const CRITICAL_PATHS: { label: string; test: (p: string) => boolean }[] = [
  { label: "GitHub workflows/settings (.github/**)", test: (p) => p.startsWith(".github/") },
  { label: "agent configuration (.claude/**)", test: (p) => p.startsWith(".claude/") },
  { label: "production Terraform (infra/prod)", test: (p) => p.startsWith("infra/prod/") },
  { label: "production Terraform (infra/modules/**)", test: (p) => p.startsWith("infra/modules/") },
  { label: "production Terraform (infra/bootstrap)", test: (p) => p.startsWith("infra/bootstrap/") },
  { label: "product spec (docs/**/SPEC.md)", test: (p) => /^docs\/(.+\/)?SPEC\.md$/.test(p) },
  { label: "dependency allowlist edit", test: (p) => p === APPROVED_DEPS_PATH },
  {
    label: "authentication",
    test: (p) =>
      /(^|[/._-])(auth|oauth|oidc|nextauth|login)([/._\]-]|$)/i.test(p) ||
      p === "apps/web/src/server/origin-wrapper.ts" || // D25 origin guard
      p === "apps/web/open-next.config.ts" || // registers the origin guard wrapper
      /^apps\/web\/src\/(middleware|proxy)\.[cm]?[jt]sx?$/.test(p) ||
      /^apps\/web\/src\/app\/\(owner\)\/layout\.[jt]sx?$/.test(p), // owner-only redirect
  },
  { label: "secrets", test: (p) => /(^|[/._-])(secrets?|credentials?)([/._-]|$)/i.test(p) || /(^|\/)\.env/.test(p) },
  {
    label: "permissions",
    test: (p) =>
      /(^|[/._-])(iam|permissions?|policy|policies)([/._-]|$)/i.test(p) ||
      p.startsWith("scripts/repo-settings/") ||
      /^scripts\/(lib\/)?[\w-]*repo-settings\.ts$/.test(p),
  },
];

/** SQL keywords that drop or rename (DESIGN D2: grep SQL for DROP/RENAME). */
const SQL_DESTRUCTIVE = /\b(DROP|RENAME)\b/i;
/** IAM in Terraform outside the already-critical prod paths (e.g. infra/preview). */
const TF_IAM = /\b(aws_iam_\w+|iam_policy\w*|assume_role_policy|aws_lambda_permission)\b/;
/** A provider block added to a Terraform lock file. */
const TF_NEW_PROVIDER = /^provider\s+"([^"]+)"/;
/** SDKs whose addition means calling a (possibly paid) service we did not call before. */
const SERVICE_SDK = /^@aws-sdk\/client-/;

function allowed(name: string, list: readonly string[]): boolean {
  return list.some((entry) => (entry.endsWith("/*") ? name.startsWith(entry.slice(0, -1)) : entry === name));
}

/** Added lines of a unified diff (without the leading "+"), skipping file headers. */
export function addedLines(patch: string): string[] {
  return patch
    .split(/\r?\n/)
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1));
}

/** Added and removed lines (both change the resource set in Terraform). */
function changedLines(patch: string): string[] {
  return patch
    .split(/\r?\n/)
    .filter((l) => (l.startsWith("+") && !l.startsWith("+++")) || (l.startsWith("-") && !l.startsWith("---")))
    .map((l) => l.slice(1));
}

export function evaluate(input: MergeRulesInput): MergeRulesResult {
  const reasons = new Set<string>();
  const add = (r: string) => reasons.add(r);
  const approvedDeps = input.approvedDeps ?? (defaultApprovedDeps as string[]);

  for (const f of input.files) {
    const paths = [f.path, ...(f.previousPath && f.previousPath !== f.path ? [f.previousPath] : [])];
    for (const p of paths) {
      for (const rule of CRITICAL_PATHS) if (rule.test(p)) add(`${rule.label}: ${p}`);
    }

    const patch = input.patches[f.path];
    if (f.path.toLowerCase().endsWith(".sql") && f.status !== "removed") {
      if (patch === undefined) {
        add(`SQL diff unavailable, cannot check for DROP/RENAME: ${f.path}`);
      } else {
        const hit = addedLines(patch).some((l) => SQL_DESTRUCTIVE.test(l.replace(/--.*$/, "")));
        if (hit) add(`SQL drops or renames: ${f.path}`);
      }
    }

    if (f.path.endsWith(".tf")) {
      if (patch === undefined) add(`Terraform diff unavailable, cannot check for IAM: ${f.path}`);
      else if (changedLines(patch).some((l) => TF_IAM.test(l))) add(`permissions (IAM in Terraform): ${f.path}`);
    }

    if (f.path.endsWith(".terraform.lock.hcl")) {
      if (patch === undefined) {
        add(`Terraform lock diff unavailable, cannot check for new providers: ${f.path}`);
      } else {
        for (const l of addedLines(patch)) {
          const m = TF_NEW_PROVIDER.exec(l.trim());
          if (m) add(`new service (Terraform provider ${m[1]}): ${f.path}`);
        }
      }
    }
  }

  // Prod plan (Q6): only the infra list counts; artifact changes never do.
  if (input.planSummary === null) {
    add("prod plan summary missing: cannot check production infrastructure or cost");
  } else {
    for (const c of input.planSummary.infra) {
      add(`production infrastructure change (${c.kind}): ${c.address}`);
      if (c.kind === "create") add(`cost (prod plan creates a resource): ${c.address}`);
    }
  }

  // Dependencies (C4).
  const depFiles = input.files.filter((f) => /(^|\/)package\.json$/.test(f.path) || f.path === "pnpm-lock.yaml");
  if (input.lockDiff === null) {
    if (depFiles.length > 0) add("lockfile diff missing: cannot check new dependencies");
  } else {
    const existing = new Set(input.lockDiff.existing ?? []);
    for (const d of input.lockDiff.added) {
      if (!allowed(d.name, approvedDeps)) add(`new dependency not on the allowlist: ${d.name} (${d.importer})`);
      if (SERVICE_SDK.test(d.name) && !existing.has(d.name)) add(`new service (${d.name}): ${d.importer}`);
    }
  }

  const list = [...reasons].sort();
  return { critical: list.length > 0, reasons: list };
}
