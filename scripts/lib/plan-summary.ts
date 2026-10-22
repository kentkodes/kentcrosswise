// Summarizes `terraform show -json <planfile>` for the prod plan that ci.yml runs on every PR.
// The summary is what merge-rules (P2-04) reads; the plan file and its JSON are never uploaded,
// because `terraform show -json` prints sensitive values in plain text.
// The summary holds addresses, actions and changed attribute paths only, never values.

/** The parts of Terraform's JSON plan format we read. */
export interface TerraformPlanJson {
  format_version?: string;
  resource_changes?: ResourceChange[];
}

interface ResourceChange {
  address: string;
  mode?: "managed" | "data";
  type: string;
  name: string;
  change: {
    actions: string[];
    before?: unknown;
    after?: unknown;
    after_unknown?: unknown;
  };
}

export type ChangeKind = "create" | "update" | "delete" | "replace";

export interface ChangeEntry {
  address: string;
  kind: ChangeKind;
  /** Changed attribute paths (updates only), e.g. `environment.0.variables.OPEN_NEXT_BUILD_ID`. */
  changed: string[];
}

export interface PlanSummary {
  format: 1;
  /** Infrastructure changes: anything other than shipping a new build. merge-rules treats these as critical. */
  infra: ChangeEntry[];
  /** Changes that only ship the new web build (Lambda code, uploaded assets and ISR cache files). */
  artifact: { count: number; kinds: Record<ChangeKind, number> };
}

/** Lambda attributes that change whenever the code (a new build) changes. */
const LAMBDA_ARTIFACT_PATHS = new Set([
  "source_code_hash",
  "code_sha256",
  "source_code_size",
  "filename",
  "last_modified",
  "version",
  "qualified_arn",
  "qualified_invoke_arn",
  "environment.0.variables.OPEN_NEXT_BUILD_ID",
]);

/** Uploaded build files in the web module (infra/modules/web/storage.tf). */
const ARTIFACT_OBJECTS = /^(module\.[\w-]+\.)*aws_s3_object\.(assets|cache)(\[.*\])?$/;

export function changeKind(actions: readonly string[]): ChangeKind | undefined {
  const a = [...actions].sort().join(",");
  switch (a) {
    case "create":
      return "create";
    case "update":
      return "update";
    case "delete":
      return "delete";
    case "create,delete":
      return "replace";
    default:
      return undefined; // no-op, read, forget
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Leaf paths that differ between before and after, plus paths marked unknown after apply. */
export function changedPaths(before: unknown, after: unknown, afterUnknown: unknown, prefix = ""): string[] {
  const out = new Set<string>();
  const walk = (b: unknown, a: unknown, u: unknown, path: string): void => {
    if (u === true) {
      out.add(path);
      return;
    }
    const bothContainers = (isObject(b) || Array.isArray(b)) && (isObject(a) || Array.isArray(a));
    if (bothContainers && Array.isArray(b) === Array.isArray(a)) {
      const keys = new Set<string>([
        ...Object.keys(b as object),
        ...Object.keys(a as object),
        ...(isObject(u) || Array.isArray(u) ? Object.keys(u) : []),
      ]);
      for (const k of keys) {
        const sub = (x: unknown) => (x !== null && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined);
        walk(sub(b), sub(a), sub(u), path === "" ? k : `${path}.${k}`);
      }
      return;
    }
    if (JSON.stringify(b) !== JSON.stringify(a)) out.add(path);
  };
  walk(before, after, afterUnknown, prefix);
  return [...out].sort();
}

function isArtifactChange(rc: ResourceChange, kind: ChangeKind, changed: readonly string[]): boolean {
  if (rc.type === "aws_s3_object" && ARTIFACT_OBJECTS.test(rc.address)) return true;
  if (rc.type === "aws_lambda_function" && kind === "update") {
    return changed.length > 0 && changed.every((p) => LAMBDA_ARTIFACT_PATHS.has(p));
  }
  return false;
}

export function summarizePlan(plan: TerraformPlanJson): PlanSummary {
  const infra: ChangeEntry[] = [];
  const kinds: Record<ChangeKind, number> = { create: 0, update: 0, delete: 0, replace: 0 };
  let count = 0;
  for (const rc of plan.resource_changes ?? []) {
    if (rc.mode === "data") continue;
    const kind = changeKind(rc.change.actions);
    if (kind === undefined) continue;
    const changed = kind === "update" ? changedPaths(rc.change.before, rc.change.after, rc.change.after_unknown) : [];
    if (isArtifactChange(rc, kind, changed)) {
      count += 1;
      kinds[kind] += 1;
    } else {
      infra.push({ address: rc.address, kind, changed });
    }
  }
  infra.sort((x, y) => x.address.localeCompare(y.address));
  return { format: 1, infra, artifact: { count, kinds } };
}

/** Markdown for the job summary. Addresses and attribute paths only. */
export function summaryMarkdown(s: PlanSummary): string {
  const lines = ["### Prod plan (read-only)", ""];
  if (s.infra.length === 0) {
    lines.push("No infrastructure changes.");
  } else {
    lines.push(`**${s.infra.length} infrastructure change(s)** (critical for merge-rules):`, "");
    for (const c of s.infra) {
      lines.push(`- \`${c.kind}\` \`${c.address}\`${c.changed.length ? ` (${c.changed.map((p) => `\`${p}\``).join(", ")})` : ""}`);
    }
  }
  const k = s.artifact.kinds;
  lines.push(
    "",
    `Build artifact changes: ${s.artifact.count} (create ${k.create}, update ${k.update}, delete ${k.delete}, replace ${k.replace}).`,
  );
  return `${lines.join("\n")}\n`;
}
