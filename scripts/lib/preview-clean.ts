// After a preview teardown: is anything of pr-<n> left? (DESIGN P1-13, preview-gc.)
// The probe is an interface so the logic is tested with a fake; awsPreviewProbe() is the real one.
import { CloudFrontClient, ListCachePoliciesCommand, ListFunctionsCommand, ListOriginAccessControlsCommand } from "@aws-sdk/client-cloudfront";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { IAMClient, paginateListRoles } from "@aws-sdk/client-iam";
import { LambdaClient } from "@aws-sdk/client-lambda";
import {
  paginateGetResources,
  ResourceGroupsTaggingAPIClient,
} from "@aws-sdk/client-resource-groups-tagging-api";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ListScheduleGroupsCommand, ListSchedulesCommand, SchedulerClient } from "@aws-sdk/client-scheduler";
import { SQSClient } from "@aws-sdk/client-sqs";
import { paginateGetParametersByPath, SSMClient } from "@aws-sdk/client-ssm";
import { checkTaggedResource, type TaggedStatus } from "./tagged-resource";

export interface PreviewProbe {
  /** ARNs of resources tagged kcw:pr=<pr>. */
  taggedArns(pr: number): Promise<string[]>;
  /**
   * Asks the owning service whether a tagged ARN still exists (the tagging index lags deletes).
   * Only "gone" (a confirmed not-found) drops it; "unconfirmed" still counts as a leftover.
   */
  taggedStatus(arn: string): Promise<TaggedStatus>;
  /** Names of IAM roles, CloudFront functions, cache policies and OACs (these are not all taggable). */
  untaggedNames(): Promise<string[]>;
  /** Names of SSM parameters under a path. */
  parameterNames(path: string): Promise<string[]>;
  /** True if the object exists. */
  objectExists(bucket: string, key: string): Promise<boolean>;
  /** Names of the Neon branches in the CI project. */
  neonBranchNames(): Promise<string[]>;
  /**
   * EventBridge Scheduler leftovers under a name prefix (`listSchedulerNames`). Schedules cannot be
   * tagged, so the tagging index never lists them. A list error fails the check.
   */
  schedulerNames(prefix: string): Promise<string[]>;
}

/** The two Scheduler list calls (shaped like @aws-sdk/client-scheduler's ListScheduleGroups/ListSchedules). */
export interface SchedulerListClient {
  listScheduleGroups(input: { NamePrefix: string; NextToken?: string }): Promise<{ ScheduleGroups?: { Name?: string }[]; NextToken?: string }>;
  listSchedules(input: { GroupName?: string; NamePrefix?: string; NextToken?: string }): Promise<{ Schedules?: { GroupName?: string; Name?: string }[]; NextToken?: string }>;
}

/**
 * Schedule groups named <prefix>* ("schedule group <name>"), every schedule inside them, and
 * schedules named <prefix>* in the default group ("schedule <group>/<name>"). infra/modules/pipelines
 * names its group kcw-pr-<n>-pipelines and the schedules after the source, so the group decides.
 */
/** The SDK client as a SchedulerListClient (only `send` is used, so tests pass a fake). */
export function sdkSchedulerLister(client: Pick<SchedulerClient, "send">): SchedulerListClient {
  return {
    listScheduleGroups: (input) => client.send(new ListScheduleGroupsCommand(input)),
    listSchedules: (input) => client.send(new ListSchedulesCommand(input)),
  };
}

export async function listSchedulerNames(client: SchedulerListClient, prefix: string): Promise<string[]> {
  const groups: string[] = [];
  let token: string | undefined;
  do {
    const page = await client.listScheduleGroups({ NamePrefix: prefix, NextToken: token });
    for (const g of page.ScheduleGroups ?? []) if (g.Name?.startsWith(prefix)) groups.push(g.Name);
    token = page.NextToken;
  } while (token);
  const found = groups.map((g) => `schedule group ${g}`);
  const listAll = async (input: { GroupName: string; NamePrefix?: string }) => {
    let next: string | undefined;
    do {
      const page = await client.listSchedules({ ...input, NextToken: next });
      for (const sc of page.Schedules ?? []) {
        if (sc.Name && (!input.NamePrefix || sc.Name.startsWith(input.NamePrefix))) found.push(`schedule ${sc.GroupName ?? input.GroupName}/${sc.Name}`);
      }
      next = page.NextToken;
    } while (next);
  };
  for (const g of groups) await listAll({ GroupName: g });
  await listAll({ GroupName: "default", NamePrefix: prefix });
  return found;
}

export interface CleanCheckOptions {
  pr: number;
  stateBucket: string;
  /** Skip the Neon check (no project/key given). */
  skipNeon?: boolean;
  /** Notes about tagged ARNs that were confirmed deleted (ignored). */
  log?: (line: string) => void;
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
  const [tagged, names, params, state, lock, branches, scheduler] = await Promise.all([
    probe.taggedArns(opts.pr),
    probe.untaggedNames(),
    probe.parameterNames(n.parameterPath),
    probe.objectExists(opts.stateBucket, n.stateKey),
    probe.objectExists(opts.stateBucket, n.lockKey),
    opts.skipNeon ? Promise.resolve<string[]>([]) : probe.neonBranchNames(),
    probe.schedulerNames(n.prefix),
  ]);
  const statuses = await Promise.all(
    tagged.map((arn) =>
      probe.taggedStatus(arn).catch((err: unknown): TaggedStatus => ({ state: "unconfirmed", reason: errorName(err) ?? "error" })),
    ),
  );
  tagged.forEach((arn, i) => {
    const s = statuses[i]!;
    if (s.state === "exists") leftovers.push(`tagged resource ${arn}`);
    else if (s.state === "unconfirmed") leftovers.push(`tagged resource ${arn} (not confirmed deleted: ${s.reason})`);
    else opts.log?.(`check-preview-clean: ${arn} is still in the tagging index but confirmed deleted; ignored`);
  });
  for (const name of names) if (name.startsWith(n.prefix)) leftovers.push(`resource named ${name}`);
  for (const p of params) leftovers.push(`SSM parameter ${p}`);
  if (state) leftovers.push(`state object s3://${opts.stateBucket}/${n.stateKey}`);
  if (lock) leftovers.push(`lock object s3://${opts.stateBucket}/${n.lockKey}`);
  for (const b of branches) if (b === n.branch) leftovers.push(`Neon branch ${b}`);
  for (const name of scheduler) leftovers.push(`Scheduler ${name}`);
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
  /** Lists Scheduler groups/schedules; default: the SDK SchedulerClient in `region` (tests inject a fake). */
  scheduler?: SchedulerListClient;
  neon?: { projectId: string; apiKey: string; apiHost?: string; fetch?: typeof fetch };
}

export function awsPreviewProbe(opts: AwsProbeOptions): PreviewProbe {
  const tagging = new ResourceGroupsTaggingAPIClient({ region: opts.region });
  const iam = new IAMClient({ region: opts.region });
  const cloudfront = new CloudFrontClient({ region: "us-east-1" });
  const ssm = new SSMClient({ region: opts.region });
  const s3 = new S3Client({ region: opts.region });
  const scheduler = opts.scheduler ?? sdkSchedulerLister(new SchedulerClient({ region: opts.region }));
  const checkClients = {
    region: opts.region,
    lambda: new LambdaClient({ region: opts.region }),
    logs: new CloudWatchLogsClient({ region: opts.region }),
    sqs: new SQSClient({ region: opts.region }),
    cloudfront,
    s3,
    iam,
    ssm,
  };

  return {
    async taggedArns(pr) {
      const arns: string[] = [];
      for await (const page of paginateGetResources({ client: tagging }, { TagFilters: [{ Key: "kcw:pr", Values: [String(pr)] }] })) {
        for (const r of page.ResourceTagMappingList ?? []) if (r.ResourceARN) arns.push(r.ResourceARN);
      }
      return arns;
    },

    taggedStatus: (arn) => checkTaggedResource(arn, checkClients),

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

    schedulerNames: (prefix) => listSchedulerNames(scheduler, prefix),

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
