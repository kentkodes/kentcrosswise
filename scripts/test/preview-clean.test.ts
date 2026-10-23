import { describe, expect, it } from "vitest";
import {
  awsPreviewProbe,
  findPreviewLeftovers,
  findPreviewLeftoversWithRetries,
  previewNames,
  type PreviewProbe,
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
