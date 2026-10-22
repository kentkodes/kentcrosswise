// Preview garbage collection (DESIGN §5 step 6, P1-16): finds per-PR preview leftovers (state
// objects, Neon branches, SSM parameters, tagged resources) and decides which PRs to clean.
// The sources are an interface so the logic is tested with fakes; awsGcSources() is the real one.
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { paginateGetParametersByPath, SSMClient } from "@aws-sdk/client-ssm";
import { paginateGetResources, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";

export type PrState = "open" | "closed" | "missing";

export interface GcSources {
  /** State objects under preview/ in the state bucket. */
  stateObjects(): Promise<{ key: string; lastModified?: Date }[]>;
  /** Branches of the Neon CI project. */
  neonBranches(): Promise<{ id: string; name: string; createdAt?: Date }[]>;
  /** SSM parameter names under /kcw/preview/. */
  parameterNames(): Promise<string[]>;
  /** kcw:pr tag values of resources tagged kcw:env=preview. */
  taggedPrs(): Promise<string[]>;
  /** State of the GitHub pull request (missing: no such PR, e.g. the manual pr-0). */
  prState(pr: number): Promise<PrState>;
}

export interface Candidate {
  pr: number;
  /** preview/pr-<n>.tfstate exists: terraform destroy is needed. */
  hasState: boolean;
  /** preview/pr-<n>.tfstate.tflock exists (a run died mid-operation). */
  hasLock: boolean;
  /** Neon branch preview/pr-<n> exists. */
  hasBranch: boolean;
  /** SSM parameters or tagged resources exist (terraform can remove them only if the state exists). */
  hasOther: boolean;
  prState: PrState;
  /** Newest timestamp seen (state object or branch); undefined if only untimed leftovers. */
  newest?: Date;
  eligible: boolean;
  reason: string;
}

export interface FindOptions {
  now: Date;
  /** Open (or missing) PRs are cleaned once their newest leftover is older than this. */
  maxAgeHours: number;
  /** Look at this PR only. */
  pr?: number;
  /** Treat every leftover as eligible (ci.yml pre-clean of its own PR). */
  force?: boolean;
}

const STATE_KEY = /^preview\/pr-(0|[1-9][0-9]*)\.tfstate(\.tflock)?$/;
const BRANCH = /^preview\/pr-(0|[1-9][0-9]*)$/;
const PARAM = /^\/kcw\/preview\/pr-(0|[1-9][0-9]*)\//;
const PR_TAG = /^(0|[1-9][0-9]*)$/;

function newer(a: Date | undefined, b: Date | undefined): Date | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

export async function findCandidates(src: GcSources, opts: FindOptions): Promise<Candidate[]> {
  const [objects, branches, params, tagged] = await Promise.all([
    src.stateObjects(),
    src.neonBranches(),
    src.parameterNames(),
    src.taggedPrs(),
  ]);
  const byPr = new Map<number, Omit<Candidate, "prState" | "eligible" | "reason">>();
  const entry = (pr: number) => {
    let c = byPr.get(pr);
    if (!c) {
      c = { pr, hasState: false, hasLock: false, hasBranch: false, hasOther: false };
      byPr.set(pr, c);
    }
    return c;
  };
  for (const o of objects) {
    const m = STATE_KEY.exec(o.key);
    if (!m) continue;
    const c = entry(Number(m[1]));
    if (m[2]) c.hasLock = true;
    else c.hasState = true;
    c.newest = newer(c.newest, o.lastModified);
  }
  for (const b of branches) {
    const m = BRANCH.exec(b.name);
    if (!m) continue;
    const c = entry(Number(m[1]));
    c.hasBranch = true;
    c.newest = newer(c.newest, b.createdAt);
  }
  for (const p of params) {
    const m = PARAM.exec(p);
    if (m) entry(Number(m[1])).hasOther = true;
  }
  for (const t of tagged) if (PR_TAG.test(t)) entry(Number(t)).hasOther = true;

  const prs = [...byPr.keys()].filter((n) => opts.pr === undefined || n === opts.pr).sort((a, b) => a - b);
  const out: Candidate[] = [];
  for (const pr of prs) {
    const c = byPr.get(pr)!;
    const prState = opts.force ? "open" : await src.prState(pr);
    let eligible: boolean;
    let reason: string;
    if (opts.force) {
      eligible = true;
      reason = "forced (own PR, before a new preview)";
    } else if (prState === "closed") {
      eligible = true;
      reason = "PR closed";
    } else if (c.newest === undefined) {
      // Only parameters or tagged resources: may be an apply in progress. Report, don't touch.
      eligible = false;
      reason = "untimed leftovers on an open PR; left alone";
    } else {
      const ageHours = (opts.now.getTime() - c.newest.getTime()) / 3_600_000;
      eligible = ageHours > opts.maxAgeHours;
      reason = `${prState === "missing" ? "no such PR" : "PR open"}, newest leftover ${ageHours.toFixed(1)} h old`;
    }
    out.push({ ...c, prState, eligible, reason });
  }
  return out;
}

/** GitHub step outputs for the workflow. */
export function gcOutputs(cands: readonly Candidate[]): Record<string, string> {
  const eligible = cands.filter((c) => c.eligible);
  return {
    prs: JSON.stringify(eligible.map((c) => c.pr)),
    destroy_prs: JSON.stringify(eligible.filter((c) => c.hasState).map((c) => c.pr)),
    // A lock on an eligible preview is stale (its run is gone); it would block terraform destroy.
    lock_prs: JSON.stringify(eligible.filter((c) => c.hasLock).map((c) => c.pr)),
    count: String(eligible.length),
    has_state: String(eligible.some((c) => c.hasState)),
    has_branch: String(eligible.some((c) => c.hasBranch)),
  };
}

export function gcReport(cands: readonly Candidate[]): string {
  if (cands.length === 0) return "No preview leftovers.\n";
  const rows = cands.map((c) => {
    const what = [c.hasState && "state", c.hasLock && "lock", c.hasBranch && "neon branch", c.hasOther && "params/resources"].filter(Boolean).join(", ");
    return `| pr-${c.pr} | ${what} | ${c.reason} | ${c.eligible ? "clean" : "keep"} |`;
  });
  return ["| Preview | Leftovers | Why | Action |", "|---|---|---|---|", ...rows].join("\n") + "\n";
}

// ---------- Neon ----------

export interface NeonOptions {
  projectId: string;
  apiKey: string;
  apiHost?: string;
  fetch?: typeof fetch;
}

const NEON_API = "https://console.neon.tech/api/v2";

export async function listNeonBranches(opts: NeonOptions): Promise<{ id: string; name: string; createdAt?: Date }[]> {
  const f = opts.fetch ?? fetch;
  const res = await f(`${opts.apiHost ?? NEON_API}/projects/${encodeURIComponent(opts.projectId)}/branches`, {
    headers: { Authorization: `Bearer ${opts.apiKey}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Neon API returned ${res.status} listing branches`);
  const body = (await res.json()) as { branches?: { id?: string; name?: string; created_at?: string }[] };
  return (body.branches ?? [])
    .filter((b): b is { id: string; name: string; created_at?: string } => !!b.id && !!b.name)
    .map((b) => ({ id: b.id, name: b.name, ...(b.created_at && { createdAt: new Date(b.created_at) }) }));
}

/** Deletes branch preview/pr-<n> if it exists. Returns whether something was deleted. */
export async function deleteNeonPreviewBranch(opts: NeonOptions, pr: number): Promise<boolean> {
  const f = opts.fetch ?? fetch;
  const name = `preview/pr-${pr}`;
  const branch = (await listNeonBranches(opts)).find((b) => b.name === name);
  if (!branch) return false;
  const res = await f(
    `${opts.apiHost ?? NEON_API}/projects/${encodeURIComponent(opts.projectId)}/branches/${encodeURIComponent(branch.id)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${opts.apiKey}`, Accept: "application/json" } },
  );
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Neon API returned ${res.status} deleting ${name}`);
  return true;
}

// ---------- GitHub ----------

export async function githubPrState(
  repo: string,
  pr: number,
  token: string | undefined,
  f: typeof fetch = fetch,
): Promise<PrState> {
  const res = await f(`https://api.github.com/repos/${repo}/pulls/${pr}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  });
  if (res.status === 404) return "missing";
  if (!res.ok) throw new Error(`GitHub API returned ${res.status} for PR #${pr}`);
  const body = (await res.json()) as { state?: string };
  return body.state === "closed" ? "closed" : "open";
}

// ---------- AWS ----------

export interface AwsGcOptions {
  region: string;
  stateBucket: string;
  neon: NeonOptions;
  repo: string;
  githubToken?: string;
}

export function awsGcSources(opts: AwsGcOptions): GcSources {
  const s3 = new S3Client({ region: opts.region });
  const ssm = new SSMClient({ region: opts.region });
  const tagging = new ResourceGroupsTaggingAPIClient({ region: opts.region });
  return {
    async stateObjects() {
      const out: { key: string; lastModified?: Date }[] = [];
      let token: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket: opts.stateBucket, Prefix: "preview/", ContinuationToken: token }));
        for (const o of page.Contents ?? []) if (o.Key) out.push({ key: o.Key, ...(o.LastModified && { lastModified: o.LastModified }) });
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    neonBranches: () => listNeonBranches(opts.neon),
    async parameterNames() {
      const names: string[] = [];
      // WithDecryption false: names only, never values.
      for await (const page of paginateGetParametersByPath({ client: ssm }, { Path: "/kcw/preview/", Recursive: true, WithDecryption: false })) {
        for (const p of page.Parameters ?? []) if (p.Name) names.push(p.Name);
      }
      return names;
    },
    async taggedPrs() {
      const prs: string[] = [];
      for await (const page of paginateGetResources({ client: tagging }, { TagFilters: [{ Key: "kcw:env", Values: ["preview"] }] })) {
        for (const r of page.ResourceTagMappingList ?? []) {
          const v = r.Tags?.find((t) => t.Key === "kcw:pr")?.Value;
          if (v !== undefined) prs.push(v);
        }
      }
      return prs;
    },
    prState: (pr) => githubPrState(opts.repo, pr, opts.githubToken),
  };
}
