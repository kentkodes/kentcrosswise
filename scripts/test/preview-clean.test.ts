import { ListScheduleGroupsCommand, ListSchedulesCommand } from "@aws-sdk/client-scheduler";
import { describe, expect, it } from "vitest";
import {
  awsPreviewProbe,
  findPreviewLeftovers,
  findPreviewLeftoversWithRetries,
  listSchedulerNames,
  previewNames,
  sdkSchedulerLister,
  type PreviewProbe,
  type SchedulerListClient,
} from "../lib/preview-clean";
import type { TaggedStatus } from "../lib/tagged-resource";

function fakeProbe(state: {
  tagged?: Record<number, string[]>;
  /** Per-ARN existence check result; default "exists". */
  status?: Record<string, TaggedStatus>;
  names?: string[];
  params?: Record<string, string[]>;
  objects?: string[];
  branches?: string[];
  /** Scheduler names per prefix (default: none), or the error the listing throws. */
  scheduler?: Record<string, string[]> | Error;
}): PreviewProbe & { neonCalls: number } {
  const probe = {
    neonCalls: 0,
    taggedArns: async (pr: number) => state.tagged?.[pr] ?? [],
    taggedStatus: async (arn: string): Promise<TaggedStatus> => state.status?.[arn] ?? { state: "exists" },
    untaggedNames: async () => state.names ?? [],
    parameterNames: async (path: string) => state.params?.[path] ?? [],
    objectExists: async (bucket: string, key: string) => (state.objects ?? []).includes(`${bucket}/${key}`),
    neonBranchNames: async () => {
      probe.neonCalls += 1;
      return state.branches ?? [];
    },
    schedulerNames: async (prefix: string) => {
      if (state.scheduler instanceof Error) throw state.scheduler;
      return state.scheduler?.[prefix] ?? [];
    },
  };
  return probe;
}

const BUCKET = "kentcrosswise-tfstate-000000000000";

describe("previewNames", () => {
  it("derives every per-PR name from the number", () => {
    expect(previewNames(0)).toEqual({
      prefix: "kcw-pr-0-",
      parameterPath: "/kcw/preview/pr-0/",
      stateKey: "preview/pr-0.tfstate",
      lockKey: "preview/pr-0.tfstate.tflock",
      branch: "preview/pr-0",
    });
  });
});

describe("findPreviewLeftovers", () => {
  it("is empty for a clean account, ignoring other PRs and prod", async () => {
    const probe = fakeProbe({
      tagged: { 1: ["arn:aws:lambda:us-east-1:000000000000:function:kcw-pr-1-server"] },
      names: ["kcw-pr-1-server", "kcw-pr-10-server", "kcw-prod-server", "kcw-gh-ci"],
      params: { "/kcw/preview/pr-1/": ["/kcw/preview/pr-1/database-url"] },
      objects: [`${BUCKET}/preview/pr-1.tfstate`, `${BUCKET}/prod.tfstate`],
      branches: ["base", "preview/pr-1", "preview/pr-10"],
    });
    expect(await findPreviewLeftovers(probe, { pr: 0, stateBucket: BUCKET })).toEqual([]);
  });

  it("lists every kind of leftover", async () => {
    const probe = fakeProbe({
      tagged: { 3: ["arn:aws:cloudfront::000000000000:distribution/E123"] },
      names: ["kcw-pr-3-server", "kcw-pr-3-forward-host", "kcw-pr-30-image"],
      params: { "/kcw/preview/pr-3/": ["/kcw/preview/pr-3/database-url"] },
      objects: [`${BUCKET}/preview/pr-3.tfstate`, `${BUCKET}/preview/pr-3.tfstate.tflock`],
      branches: ["base", "preview/pr-3"],
    });
    expect(await findPreviewLeftovers(probe, { pr: 3, stateBucket: BUCKET })).toEqual([
      "tagged resource arn:aws:cloudfront::000000000000:distribution/E123",
      "resource named kcw-pr-3-server",
      "resource named kcw-pr-3-forward-host",
      "SSM parameter /kcw/preview/pr-3/database-url",
      `state object s3://${BUCKET}/preview/pr-3.tfstate`,
      `lock object s3://${BUCKET}/preview/pr-3.tfstate.tflock`,
      "Neon branch preview/pr-3",
    ]);
  });

  it("drops tagged ARNs confirmed deleted and keeps unconfirmed ones with the reason", async () => {
    const esm = "arn:aws:lambda:us-east-1:000000000000:event-source-mapping:5d886b80";
    const fn = "arn:aws:lambda:us-east-1:000000000000:function:kcw-pr-5-server";
    const denied = "arn:aws:sqs:us-east-1:000000000000:kcw-pr-5-revalidation.fifo";
    const odd = "arn:aws:dynamodb:us-east-1:000000000000:table/kcw-pr-5-x";
    const probe = fakeProbe({
      tagged: { 5: [esm, fn, denied, odd] },
      status: {
        [esm]: { state: "gone" },
        [denied]: { state: "unconfirmed", reason: "sqs:GetQueueUrl failed: AccessDenied" },
        [odd]: { state: "unconfirmed", reason: "no existence check for dynamodb resource type" },
      },
    });
    const logs: string[] = [];
    expect(await findPreviewLeftovers(probe, { pr: 5, stateBucket: BUCKET, skipNeon: true, log: (l) => logs.push(l) })).toEqual([
      `tagged resource ${fn}`,
      `tagged resource ${denied} (not confirmed deleted: sqs:GetQueueUrl failed: AccessDenied)`,
      `tagged resource ${odd} (not confirmed deleted: no existence check for dynamodb resource type)`,
    ]);
    expect(logs).toEqual([`check-preview-clean: ${esm} is still in the tagging index but confirmed deleted; ignored`]);
  });

  it("counts a tagged ARN whose check throws as a leftover", async () => {
    const arn = "arn:aws:lambda:us-east-1:000000000000:function:kcw-pr-6-server";
    const probe = fakeProbe({ tagged: { 6: [arn] } });
    probe.taggedStatus = async () => {
      throw Object.assign(new Error("boom"), { name: "ThrottlingException" });
    };
    expect(await findPreviewLeftovers(probe, { pr: 6, stateBucket: BUCKET, skipNeon: true })).toEqual([
      `tagged resource ${arn} (not confirmed deleted: ThrottlingException)`,
    ]);
  });

  it("skips Neon when asked", async () => {
    const probe = fakeProbe({ branches: ["preview/pr-0"] });
    expect(await findPreviewLeftovers(probe, { pr: 0, stateBucket: BUCKET, skipNeon: true })).toEqual([]);
    expect(probe.neonCalls).toBe(0);
  });

  it("counts untaggable Scheduler leftovers found under the PR's own prefix", async () => {
    const probe = fakeProbe({
      scheduler: {
        "kcw-pr-7-": ["schedule group kcw-pr-7-pipelines", "schedule kcw-pr-7-pipelines/gutenberg"],
        "kcw-pr-70-": ["schedule group kcw-pr-70-pipelines"],
      },
    });
    expect(await findPreviewLeftovers(probe, { pr: 7, stateBucket: BUCKET, skipNeon: true })).toEqual([
      "Scheduler schedule group kcw-pr-7-pipelines",
      "Scheduler schedule kcw-pr-7-pipelines/gutenberg",
    ]);
  });

  it("fails the check when Scheduler cannot be listed (never reports clean)", async () => {
    const probe = fakeProbe({ scheduler: Object.assign(new Error("not authorized"), { name: "AccessDeniedException" }) });
    await expect(findPreviewLeftovers(probe, { pr: 7, stateBucket: BUCKET, skipNeon: true })).rejects.toThrow("not authorized");
  });
});

describe("listSchedulerNames", () => {
  function fakeScheduler(groups: string[], schedules: { GroupName: string; Name: string }[]) {
    const calls: unknown[] = [];
    const client: SchedulerListClient = {
      // Two pages each, to prove pagination; the API's NamePrefix filter is applied as well.
      async listScheduleGroups(input) {
        calls.push(["groups", input]);
        const matching = groups.filter((g) => g.startsWith(input.NamePrefix));
        const page = input.NextToken ? matching.slice(1) : matching.slice(0, 1);
        return { ScheduleGroups: page.map((Name) => ({ Name })), NextToken: input.NextToken || matching.length <= 1 ? undefined : "g2" };
      },
      async listSchedules(input) {
        calls.push(["schedules", input]);
        const matching = schedules.filter((s) => s.GroupName === input.GroupName && (!input.NamePrefix || s.Name.startsWith(input.NamePrefix)));
        const page = input.NextToken ? matching.slice(1) : matching.slice(0, 1);
        return { Schedules: page, NextToken: input.NextToken || matching.length <= 1 ? undefined : "s2" };
      },
    };
    return { client, calls };
  }

  it("lists the PR's groups, every schedule in them and prefixed schedules in the default group", async () => {
    const { client } = fakeScheduler(
      ["kcw-pr-4-pipelines", "kcw-pr-4-other", "kcw-pr-40-pipelines", "kcw-prod-pipelines"],
      [
        { GroupName: "kcw-pr-4-pipelines", Name: "gutenberg" },
        { GroupName: "kcw-pr-4-pipelines", Name: "wikisource-en" },
        { GroupName: "kcw-pr-40-pipelines", Name: "gutenberg" },
        { GroupName: "kcw-prod-pipelines", Name: "gutenberg" },
        { GroupName: "default", Name: "kcw-pr-4-stray" },
        { GroupName: "default", Name: "kcw-pr-40-stray" },
        { GroupName: "default", Name: "unrelated" },
      ],
    );
    expect(await listSchedulerNames(client, "kcw-pr-4-")).toEqual([
      "schedule group kcw-pr-4-pipelines",
      "schedule group kcw-pr-4-other",
      "schedule kcw-pr-4-pipelines/gutenberg",
      "schedule kcw-pr-4-pipelines/wikisource-en",
      "schedule default/kcw-pr-4-stray",
    ]);
  });

  it("is empty for a clean account and only filters by the PR prefix", async () => {
    const { client, calls } = fakeScheduler(["kcw-prod-pipelines"], [{ GroupName: "kcw-prod-pipelines", Name: "gutenberg" }]);
    expect(await listSchedulerNames(client, "kcw-pr-4-")).toEqual([]);
    expect(calls).toEqual([
      ["groups", { NamePrefix: "kcw-pr-4-", NextToken: undefined }],
      ["schedules", { GroupName: "default", NamePrefix: "kcw-pr-4-", NextToken: undefined }],
    ]);
  });

  it("propagates list errors (fails the check rather than reporting clean)", async () => {
    const client: SchedulerListClient = {
      listScheduleGroups: async () => { throw Object.assign(new Error("denied"), { name: "AccessDeniedException" }); },
      listSchedules: async () => ({}),
    };
    await expect(listSchedulerNames(client, "kcw-pr-4-")).rejects.toThrow("denied");
  });
});

describe("awsPreviewProbe Scheduler listing", () => {
  /** A fake SchedulerClient: answers the two list commands in pages of one, records every input. */
  function fakeSdk(groups: string[], schedules: { GroupName: string; Name: string }[], fail?: Error) {
    const inputs: { command: string; input: Record<string, unknown> }[] = [];
    const page = <T>(items: T[], token: unknown) => {
      const i = token ? Number(token) : 0;
      return { items: items.slice(i, i + 1), NextToken: i + 1 < items.length ? String(i + 1) : undefined };
    };
    const send = async (command: unknown): Promise<never> => {
      if (fail) throw fail;
      if (command instanceof ListScheduleGroupsCommand) {
        inputs.push({ command: "ListScheduleGroups", input: { ...command.input } });
        const p = page(groups.filter((g) => g.startsWith(command.input.NamePrefix ?? "")), command.input.NextToken);
        return { ScheduleGroups: p.items.map((Name) => ({ Name })), NextToken: p.NextToken } as never;
      }
      if (command instanceof ListSchedulesCommand) {
        inputs.push({ command: "ListSchedules", input: { ...command.input } });
        const p = page(
          schedules.filter((x) => x.GroupName === command.input.GroupName && x.Name.startsWith(command.input.NamePrefix ?? "")),
          command.input.NextToken,
        );
        return { Schedules: p.items, NextToken: p.NextToken } as never;
      }
      throw new Error("unexpected command");
    };
    return { client: { send } as unknown as Parameters<typeof sdkSchedulerLister>[0], inputs };
  }

  it("builds a real SchedulerClient by default without calling AWS", () => {
    expect(typeof awsPreviewProbe({ region: "us-east-1" }).schedulerNames).toBe("function");
  });

  it("lists through the SDK commands with NamePrefix filters and NextToken pagination", async () => {
    const sdk = fakeSdk(
      ["kcw-pr-1-pipelines", "kcw-pr-1-extra", "kcw-pr-10-pipelines"],
      [
        { GroupName: "kcw-pr-1-pipelines", Name: "gutenberg" },
        { GroupName: "kcw-pr-1-pipelines", Name: "wikisource-en" },
        { GroupName: "default", Name: "kcw-pr-1-stray" },
        { GroupName: "default", Name: "kcw-pr-10-stray" },
      ],
    );
    const probe = awsPreviewProbe({ region: "us-east-1", scheduler: sdkSchedulerLister(sdk.client) });
    expect(await probe.schedulerNames("kcw-pr-1-")).toEqual([
      "schedule group kcw-pr-1-pipelines",
      "schedule group kcw-pr-1-extra",
      "schedule kcw-pr-1-pipelines/gutenberg",
      "schedule kcw-pr-1-pipelines/wikisource-en",
      "schedule default/kcw-pr-1-stray",
    ]);
    expect(sdk.inputs).toEqual([
      { command: "ListScheduleGroups", input: { NamePrefix: "kcw-pr-1-", NextToken: undefined } },
      { command: "ListScheduleGroups", input: { NamePrefix: "kcw-pr-1-", NextToken: "1" } },
      { command: "ListSchedules", input: { GroupName: "kcw-pr-1-pipelines", NextToken: undefined } },
      { command: "ListSchedules", input: { GroupName: "kcw-pr-1-pipelines", NextToken: "1" } },
      { command: "ListSchedules", input: { GroupName: "kcw-pr-1-extra", NextToken: undefined } },
      { command: "ListSchedules", input: { GroupName: "default", NamePrefix: "kcw-pr-1-", NextToken: undefined } },
    ]);
  });

  it("reports leftovers through findPreviewLeftovers and fails closed on SDK errors", async () => {
    const leftover = fakeSdk(["kcw-pr-2-pipelines"], [{ GroupName: "kcw-pr-2-pipelines", Name: "gutenberg" }]);
    const probe = fakeProbe({});
    probe.schedulerNames = awsPreviewProbe({ region: "us-east-1", scheduler: sdkSchedulerLister(leftover.client) }).schedulerNames;
    expect(await findPreviewLeftovers(probe, { pr: 2, stateBucket: BUCKET, skipNeon: true })).toEqual([
      "Scheduler schedule group kcw-pr-2-pipelines",
      "Scheduler schedule kcw-pr-2-pipelines/gutenberg",
    ]);
    const denied = fakeSdk([], [], Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
    probe.schedulerNames = awsPreviewProbe({ region: "us-east-1", scheduler: sdkSchedulerLister(denied.client) }).schedulerNames;
    await expect(findPreviewLeftovers(probe, { pr: 2, stateBucket: BUCKET, skipNeon: true })).rejects.toThrow("denied");
  });
});

describe("findPreviewLeftoversWithRetries", () => {
  it("re-checks while the tagging index still lists deleted resources", async () => {
    const probe = fakeProbe({});
    let calls = 0;
    probe.taggedArns = async () => (++calls < 3 ? ["arn:aws:lambda:us-east-1:000000000000:event-source-mapping:x"] : []);
    const sleeps: number[] = [];
    const left = await findPreviewLeftoversWithRetries(
      probe,
      { pr: 4, stateBucket: BUCKET, skipNeon: true },
      { attempts: 5, delayMs: 30_000, sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(left).toEqual([]);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([30_000, 30_000]);
  });

  it("returns the leftovers after the last attempt", async () => {
    const probe = fakeProbe({ objects: [`${BUCKET}/preview/pr-4.tfstate`] });
    const left = await findPreviewLeftoversWithRetries(
      probe,
      { pr: 4, stateBucket: BUCKET, skipNeon: true },
      { attempts: 2, delayMs: 1, sleep: async () => {} },
    );
    expect(left).toEqual([`state object s3://${BUCKET}/preview/pr-4.tfstate`]);
  });
});

describe("awsPreviewProbe Neon listing", () => {
  it("lists branch names with a bearer key and fails on HTTP errors", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ branches: [{ name: "base" }, { name: "preview/pr-2" }, {}] }), { status: 200 });
    }) as typeof fetch;
    const probe = awsPreviewProbe({
      region: "us-east-1",
      neon: { projectId: "proj-1", apiKey: "synthetic-key", fetch: fakeFetch },
    });
    expect(await probe.neonBranchNames()).toEqual(["base", "preview/pr-2"]);
    expect(seen).toEqual([{ url: "https://console.neon.tech/api/v2/projects/proj-1/branches", auth: "Bearer synthetic-key" }]);

    const failing = awsPreviewProbe({
      region: "us-east-1",
      neon: { projectId: "p", apiKey: "k", fetch: (async () => new Response("no", { status: 401 })) as typeof fetch },
    });
    await expect(failing.neonBranchNames()).rejects.toThrow(/401/);
    await expect(awsPreviewProbe({ region: "us-east-1" }).neonBranchNames()).rejects.toThrow(/--skip-neon/);
  });
});
