// After a preview teardown: is anything of pr-<n> left? (DESIGN P1-13, preview-gc.)
// The probe is an interface so the logic is tested with a fake; awsPreviewProbe() is the real one.
import { CloudFrontClient, ListCachePoliciesCommand, ListFunctionsCommand, ListOriginAccessControlsCommand } from "@aws-sdk/client-cloudfront";
import { IAMClient, paginateListRoles } from "@aws-sdk/client-iam";
import {
  paginateGetResources,
  ResourceGroupsTaggingAPIClient,
} from "@aws-sdk/client-resource-groups-tagging-api";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { paginateGetParametersByPath, SSMClient } from "@aws-sdk/client-ssm";

export interface PreviewProbe {
  /** ARNs of resources tagged kcw:pr=<pr>. */
  taggedArns(pr: number): Promise<string[]>;
  /** Names of IAM roles, CloudFront functions, cache policies and OACs (these are not all taggable). */
  untaggedNames(): Promise<string[]>;
  /** Names of SSM parameters under a path. */
  parameterNames(path: string): Promise<string[]>;
  /** True if the object exists. */
  objectExists(bucket: string, key: string): Promise<boolean>;
  /** Names of the Neon branches in the CI project. */
  neonBranchNames(): Promise<string[]>;
}

export interface CleanCheckOptions {
  pr: number;
  stateBucket: string;
  /** Skip the Neon check (no project/key given). */
  skipNeon?: boolean;
}

export function previewNames(pr: number) {
  return {
    prefix: `kcw-pr-${pr}-`,
    parameterPath: `/kcw/preview/pr-${pr}/`,
    stateKey: `preview/pr-${pr}.tfstate`,
    lockKey: `preview/pr-${pr}.tfstate.tflock`,
    branch: `preview/pr-${pr}`,
  };
}

/** Returns human-readable leftovers (resource names/ARNs only, never values). Empty = clean. */
export async function findPreviewLeftovers(probe: PreviewProbe, opts: CleanCheckOptions): Promise<string[]> {
  const n = previewNames(opts.pr);
  const leftovers: string[] = [];
  const [tagged, names, params, state, lock, branches] = await Promise.all([
    probe.taggedArns(opts.pr),
    probe.untaggedNames(),
    probe.parameterNames(n.parameterPath),
    probe.objectExists(opts.stateBucket, n.stateKey),
    probe.objectExists(opts.stateBucket, n.lockKey),
    opts.skipNeon ? Promise.resolve<string[]>([]) : probe.neonBranchNames(),
  ]);
  for (const arn of tagged) leftovers.push(`tagged resource ${arn}`);
  for (const name of names) if (name.startsWith(n.prefix)) leftovers.push(`resource named ${name}`);
  for (const p of params) leftovers.push(`SSM parameter ${p}`);
  if (state) leftovers.push(`state object s3://${opts.stateBucket}/${n.stateKey}`);
  if (lock) leftovers.push(`lock object s3://${opts.stateBucket}/${n.lockKey}`);
  for (const b of branches) if (b === n.branch) leftovers.push(`Neon branch ${b}`);
  return leftovers;
}

export interface RetryOptions {
  /** Total attempts (1 = no retry). */
  attempts: number;
  delayMs: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * The tagging API keeps listing deleted resources for a minute or so after a destroy (seen in the
 * pr-0 live run), so CI re-checks a few times before calling it a leak. Returns the last result.
 */
export async function findPreviewLeftoversWithRetries(
  probe: PreviewProbe,
  opts: CleanCheckOptions,
  retry: RetryOptions,
): Promise<string[]> {
  const sleep = retry.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let leftovers: string[] = [];
  for (let attempt = 1; attempt <= Math.max(1, retry.attempts); attempt++) {
    leftovers = await findPreviewLeftovers(probe, opts);
    if (leftovers.length === 0 || attempt >= retry.attempts) return leftovers;
    retry.log?.(`check-preview-clean: ${leftovers.length} leftover(s) on attempt ${attempt}/${retry.attempts}; re-checking in ${Math.round(retry.delayMs / 1000)} s`);
    await sleep(retry.delayMs);
  }
  return leftovers;
}

function errorName(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "name" in err ? String(err.name) : undefined;
}

export interface AwsProbeOptions {
  region: string;
  neon?: { projectId: string; apiKey: string; apiHost?: string; fetch?: typeof fetch };
}

export function awsPreviewProbe(opts: AwsProbeOptions): PreviewProbe {
  const tagging = new ResourceGroupsTaggingAPIClient({ region: opts.region });
  const iam = new IAMClient({ region: opts.region });
  const cloudfront = new CloudFrontClient({ region: "us-east-1" });
  const ssm = new SSMClient({ region: opts.region });
  const s3 = new S3Client({ region: opts.region });

  return {
    async taggedArns(pr) {
      const arns: string[] = [];
      for await (const page of paginateGetResources({ client: tagging }, { TagFilters: [{ Key: "kcw:pr", Values: [String(pr)] }] })) {
        for (const r of page.ResourceTagMappingList ?? []) if (r.ResourceARN) arns.push(r.ResourceARN);
      }
      return arns;
    },

    async untaggedNames() {
      const names: string[] = [];
      for await (const page of paginateListRoles({ client: iam }, {})) {
        for (const r of page.Roles ?? []) if (r.RoleName) names.push(r.RoleName);
      }
      // These lists are short (a few per preview); one page of 100 is enough at our scale.
      const fns = await cloudfront.send(new ListFunctionsCommand({ MaxItems: 100 }));
      for (const f of fns.FunctionList?.Items ?? []) if (f.Name) names.push(f.Name);
      const policies = await cloudfront.send(new ListCachePoliciesCommand({ Type: "custom", MaxItems: 100 }));
      for (const p of policies.CachePolicyList?.Items ?? []) {
        const name = p.CachePolicy?.CachePolicyConfig?.Name;
        if (name) names.push(name);
      }
      const oacs = await cloudfront.send(new ListOriginAccessControlsCommand({ MaxItems: 100 }));
      for (const o of oacs.OriginAccessControlList?.Items ?? []) if (o.Name) names.push(o.Name);
      return names;
    },

    async parameterNames(path) {
      const names: string[] = [];
      // WithDecryption false: only names are read, never values.
      for await (const page of paginateGetParametersByPath({ client: ssm }, { Path: path, Recursive: true, WithDecryption: false })) {
        for (const p of page.Parameters ?? []) if (p.Name) names.push(p.Name);
      }
      return names;
    },

    async objectExists(bucket, key) {
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (err) {
        if (errorName(err) === "NotFound" || errorName(err) === "NoSuchKey") return false;
        throw new Error(`could not check s3://${bucket}/${key} (${errorName(err) ?? "error"})`);
      }
    },

    async neonBranchNames() {
      if (!opts.neon) throw new Error("Neon project id and API key are required (or pass --skip-neon)");
      const { projectId, apiKey, apiHost = "https://console.neon.tech/api/v2", fetch: f = fetch } = opts.neon;
      const res = await f(`${apiHost}/projects/${encodeURIComponent(projectId)}/branches`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`Neon API returned ${res.status} listing branches`);
      const body = (await res.json()) as { branches?: { name?: string }[] };
      return (body.branches ?? []).map((b) => b.name ?? "").filter((n) => n !== "");
    },
  };
}
