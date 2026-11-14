// The artifact that feeds merge-rules (P2-13, DESIGN §4.2 step 7; trusted since AR1 slice 3). The `prod-plan`
// job of preview-trusted.yml (defined by main, plans main's infra with the PR's build as data) uploads it;
// the orchestrator's GitHub client (getArtifact) reads it only from the trusted run of the PR head and
// passes `planSummary`, `lockDiff` and `uncoveredPaths` to merge-rules `evaluate()`.
// Shared here so the producer (scripts/merge-input.ts) and the consumer use the same name and shape.

/** Artifact name in `actions/upload-artifact` (preview-trusted.yml) and in the REST "list workflow run artifacts" response. */
export const MERGE_INPUT_ARTIFACT = "merge-rules-input";

/** The one file in the artifact's zip. */
export const MERGE_INPUT_FILE = "merge-rules-input.json";

export type ChangeKind = "create" | "update" | "delete" | "replace";

/** Same shape as `PlanSummary` in scripts/lib/plan-summary.ts and agents/merge-rules (format 1). */
export interface MergeInputPlanSummary {
  format: 1;
  infra: { address: string; kind: ChangeKind; changed: string[] }[];
  artifact: { count: number; kinds: Record<ChangeKind, number> };
}

/** Same shape as `LockDiff` in agents/merge-rules: direct dependencies added per workspace importer, plus the base's direct dependencies. */
export interface MergeInputLockDiff {
  added: { importer: string; name: string }[];
  existing: string[];
}

/** Content of `merge-rules-input.json`. `uncoveredPaths`: sorted PR paths under `infra/` or `.github/` (renames count both paths), which the trusted plan (main's infra) does not cover. */
export interface MergeInputFile {
  format: 2;
  pr: number;
  headSha: string;
  planSummary: MergeInputPlanSummary;
  lockDiff: MergeInputLockDiff;
  uncoveredPaths: string[];
}

export interface MergeInput {
  pr: number;
  headSha: string;
  planSummary: MergeInputPlanSummary;
  lockDiff: MergeInputLockDiff;
  uncoveredPaths: string[];
}

export class MergeInputFormatError extends Error {
  override name = "MergeInputFormatError";
}

const KINDS: readonly ChangeKind[] = ["create", "update", "delete", "replace"];

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function fail(msg: string): never {
  throw new MergeInputFormatError(`${MERGE_INPUT_FILE}: ${msg}`);
}

function parsePlanSummary(v: unknown): MergeInputPlanSummary {
  if (!isObject(v) || v.format !== 1) fail("planSummary must be an object with format 1");
  if (!Array.isArray(v.infra)) fail("planSummary.infra must be an array");
  const infra = v.infra.map((c: unknown, i) => {
    if (!isObject(c) || typeof c.address !== "string" || !KINDS.includes(c.kind as ChangeKind) || !isStringArray(c.changed)) {
      fail(`planSummary.infra[${i}] needs address, kind and changed`);
    }
    return { address: c.address, kind: c.kind as ChangeKind, changed: [...c.changed] };
  });
  const a = v.artifact;
  if (!isObject(a) || !isCount(a.count) || !isObject(a.kinds)) fail("planSummary.artifact needs count and kinds");
  const kinds = {} as Record<ChangeKind, number>;
  for (const k of KINDS) {
    const n = a.kinds[k];
    if (!isCount(n)) fail(`planSummary.artifact.kinds.${k} must be a non-negative integer`);
    kinds[k] = n;
  }
  return { format: 1, infra, artifact: { count: a.count, kinds } };
}

function parseLockDiff(v: unknown): MergeInputLockDiff {
  if (!isObject(v) || !Array.isArray(v.added) || !isStringArray(v.existing)) {
    fail("lockDiff needs added and existing arrays");
  }
  const added = v.added.map((d: unknown, i) => {
    if (!isObject(d) || typeof d.importer !== "string" || typeof d.name !== "string" || d.name === "") {
      fail(`lockDiff.added[${i}] needs importer and name`);
    }
    return { importer: d.importer, name: d.name };
  });
  return { added, existing: [...v.existing] };
}

/** Parses and validates `merge-rules-input.json`. Throws MergeInputFormatError on any deviation (callers fail closed). */
export function parseMergeInput(text: string): MergeInput {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail("not valid JSON");
  }
  if (!isObject(raw) || raw.format !== 2) fail("format must be 2");
  if (typeof raw.pr !== "number" || !Number.isSafeInteger(raw.pr) || raw.pr <= 0) fail("pr must be a positive integer");
  if (typeof raw.headSha !== "string" || !/^[0-9a-f]{40}$/.test(raw.headSha)) fail("headSha must be a 40-character lowercase hex SHA");
  if (!isStringArray(raw.uncoveredPaths)) fail("uncoveredPaths must be an array of strings");
  return {
    pr: raw.pr,
    headSha: raw.headSha,
    planSummary: parsePlanSummary(raw.planSummary),
    lockDiff: parseLockDiff(raw.lockDiff),
    uncoveredPaths: [...raw.uncoveredPaths],
  };
}

/** The file content CI uploads (stable key order, trailing newline). */
export function serializeMergeInput(input: MergeInput): string {
  const file: MergeInputFile = {
    format: 2,
    pr: input.pr,
    headSha: input.headSha,
    planSummary: input.planSummary,
    lockDiff: input.lockDiff,
    uncoveredPaths: input.uncoveredPaths,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}
