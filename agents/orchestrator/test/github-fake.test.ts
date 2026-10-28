import type { MergeInput } from "@kcw/core/merge-input";
import { beforeEach, describe, expect, it } from "vitest";
import { FAKE_FIRST_RUN_ID, FakeGitHubClient, GitHubApiError, type GitHubClient } from "../src/github";

const input: MergeInput = {
  planSummary: { format: 1, infra: [], artifact: { count: 0, kinds: { create: 0, update: 0, delete: 0, replace: 0 } } },
  lockDiff: { added: [], existing: [] },
};

let gh: FakeGitHubClient;
beforeEach(() => {
  gh = new FakeGitHubClient();
  gh.prs.set(4, { headSha: "h4", author: "dev[bot]", files: [{ path: "a.ts", status: "added" }], patches: { "a.ts": "+x" } });
});

describe("FakeGitHubClient", () => {
  it("implements GitHubClient", () => {
    const client: GitHubClient = gh;
    expect(typeof client.getArtifact).toBe("function");
  });

  it("creates issues and records dispatches (ref defaults to main)", async () => {
    await expect(gh.createIssue({ title: "T", body: "B" })).resolves.toEqual({ number: 1, url: "https://github.invalid/issues/1" });
    await gh.dispatchWorkflow({ workflow: "agent-developer.yml", inputs: { task_id: "1" } });
    expect(gh.issues).toMatchObject([{ number: 1, title: "T" }]);
    expect(gh.dispatches).toMatchObject([{ workflow: "agent-developer.yml", ref: "main", inputs: { task_id: "1" } }]);
    expect(gh.calls.map((c) => c.method)).toEqual(["createIssue", "dispatchWorkflow"]);
  });

  it("returns deterministic run ids per dispatch, or null in the null mode", async () => {
    const a = new FakeGitHubClient({ firstRunId: 40526955264 });
    await expect(a.dispatchWorkflow({ workflow: "agent-developer.yml", inputs: {} })).resolves.toEqual({ runId: 40526955264 });
    await expect(a.dispatchWorkflow({ workflow: "agent-qa.yml", inputs: {} })).resolves.toEqual({ runId: 40526955265 });
    expect(a.dispatches.map((d) => d.runId)).toEqual([40526955264, 40526955265]);
    a.runIdMode = "null";
    await expect(a.dispatchWorkflow({ workflow: "agent-docs.yml", inputs: {} })).resolves.toEqual({ runId: null });
    expect(a.dispatches.at(-1)!.runId).toBeNull();
  });

  it("gives every fake its own block of run ids by default (fakes can share one database)", async () => {
    const b = new FakeGitHubClient();
    const c = new FakeGitHubClient();
    const fromB = (await b.dispatchWorkflow({ workflow: "agent-developer.yml", inputs: {} })).runId!;
    const fromC = (await c.dispatchWorkflow({ workflow: "agent-developer.yml", inputs: {} })).runId!;
    expect(Number.isSafeInteger(fromB) && fromB >= FAKE_FIRST_RUN_ID).toBe(true);
    expect(fromC - fromB).toBe(1_000_000);
  });

  it("merges once at the current head; a moved head or second merge is refused", async () => {
    await expect(gh.merge({ pr: 4, headSha: "old" })).resolves.toEqual({ merged: false, reason: "head_changed" });
    await expect(gh.merge({ pr: 4, headSha: "h4" })).resolves.toMatchObject({ merged: true });
    await expect(gh.merge({ pr: 4, headSha: "h4" })).resolves.toEqual({ merged: false, reason: "not_mergeable" });
    expect(gh.merges).toHaveLength(1);
    await expect(gh.merge({ pr: 99, headSha: "x" })).rejects.toMatchObject({ status: 404 });
  });

  it("keeps checks; latestCheck is what the ruleset sees", async () => {
    await gh.postCheck({ headSha: "h4", state: "pending", title: "Waiting", summary: "" });
    await gh.postCheck({ headSha: "h4", state: "success", title: "OK", summary: "" });
    expect(gh.latestCheck("h4")).toMatchObject({ name: "kcw/merge-rules", state: "success" });
    expect(gh.latestCheck("other")).toBeUndefined();
  });

  it("cancels only running runs", async () => {
    gh.runningRuns.add(5);
    await expect(gh.cancelRun(5)).resolves.toBe("cancelled");
    await expect(gh.cancelRun(5)).resolves.toBe("not_running");
    expect(gh.cancelled).toEqual([5]);
  });

  it("returns diffs and artifacts as copies", async () => {
    const diff = await gh.getDiff(4);
    expect(diff).toEqual({ headSha: "h4", author: "dev[bot]", files: [{ path: "a.ts", status: "added" }], patches: { "a.ts": "+x" }, complete: true });
    diff.files.push({ path: "b", status: "added" });
    expect(gh.prs.get(4)!.files).toHaveLength(1);

    await expect(gh.getArtifact({ pr: 4, headSha: "h4" })).resolves.toEqual({ found: false, reason: "no_artifact" });
    gh.artifacts.set("h4", input);
    const got = await gh.getArtifact({ pr: 4, headSha: "h4" });
    expect(got).toMatchObject({ found: true, input });
    if (got.found) expect(got.input).not.toBe(input);
  });

  it("failNext throws once for that method", async () => {
    gh.failNext("createIssue", 502);
    await expect(gh.createIssue({ title: "T", body: "B" })).rejects.toBeInstanceOf(GitHubApiError);
    await expect(gh.createIssue({ title: "T", body: "B" })).resolves.toMatchObject({ number: 1 });
    expect(gh.issues).toHaveLength(1);
  });
});
