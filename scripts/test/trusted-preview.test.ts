import { describe, expect, it } from "vitest";
import { checkHead, resolveCandidate, selectArtifact, selectPullRequest, shadowPreviewId, SHADOW_PR_OFFSET, type GitHubRest } from "../lib/trusted-preview";
import { provisionJobName, runTitle, TRUSTED_WORKFLOW_PATH, verifyTrustedPreview } from "../lib/trusted-run";

const SHA = "a".repeat(40);

/** Fake API keyed by path prefix; records requested paths. */
function fake(routes: Record<string, unknown>): GitHubRest & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get<T>(path: string) {
      calls.push(path);
      const key = Object.keys(routes).find((k) => path.startsWith(k));
      return key === undefined ? undefined : (routes[key] as T);
    },
  };
}

describe("shadow preview id", () => {
  it("offsets the PR number and rejects out-of-range numbers", () => {
    expect(shadowPreviewId(42)).toBe(100_042);
    expect(SHADOW_PR_OFFSET).toBe(100_000);
    expect(() => shadowPreviewId(0)).toThrow();
    expect(() => shadowPreviewId(100_000)).toThrow();
  });

  it("keeps every preview name pattern valid", () => {
    const n = shadowPreviewId(99_999);
    expect(`kcw-pr-${n}`).toMatch(/^kcw-pr-[1-9][0-9]*$/);
    expect(`preview/pr-${n}.tfstate`).toMatch(/^preview\/pr-(0|[1-9][0-9]*)\.tfstate$/);
    expect(`/kcw/preview/pr-${n}/database-url`).toMatch(/^\/kcw\/preview\/pr-(0|[1-9][0-9]*)\//);
    // The old preview job's prefix kcw-pr-42- cannot match kcw-pr-100042-...
    expect(`kcw-pr-${shadowPreviewId(42)}-assets`.startsWith("kcw-pr-42-")).toBe(false);
  });
});

describe("selectPullRequest", () => {
  const pr = (number: number, over: object = {}) => ({ number, state: "open", head: { sha: SHA, repo: { id: 7 } }, ...over });
  it("picks the single open same-repo PR at that head", () => {
    expect(selectPullRequest([pr(5)], SHA, 7).number).toBe(5);
  });
  it("ignores closed, other-head and fork PRs and requires exactly one", () => {
    expect(selectPullRequest([pr(1, { state: "closed" }), pr(2, { head: { sha: "b".repeat(40), repo: { id: 7 } } }), pr(3, { head: { sha: SHA, repo: { id: 8 } } }), pr(4)], SHA, 7).number).toBe(4);
    expect(() => selectPullRequest([], SHA, 7)).toThrow(/found 0/);
    expect(() => selectPullRequest([pr(1), pr(2)], SHA, 7)).toThrow(/found 2/);
    expect(() => selectPullRequest([pr(1, { head: { sha: SHA, repo: null } })], SHA, 7)).toThrow();
  });
});

describe("selectArtifact", () => {
  const art = (id: number, over: object = {}) => ({ id, name: "candidate-preview", expired: false, workflow_run: { id: 99, head_sha: SHA }, ...over });
  it("selects the one live artifact of the run", () => {
    expect(selectArtifact([art(1)], 99, SHA).id).toBe(1);
  });
  it("rejects zero, many, expired, other-run, other-name and other-head", () => {
    expect(() => selectArtifact([], 99, SHA)).toThrow();
    expect(() => selectArtifact([art(1), art(2)], 99, SHA)).toThrow();
    expect(() => selectArtifact([art(1, { expired: true })], 99, SHA)).toThrow();
    expect(() => selectArtifact([art(1, { workflow_run: { id: 5 } })], 99, SHA)).toThrow();
    expect(() => selectArtifact([art(1, { name: "other" })], 99, SHA)).toThrow();
    expect(() => selectArtifact([art(1, { workflow_run: { id: 99, head_sha: "c".repeat(40) } })], 99, SHA)).toThrow(/different head/);
  });
});

describe("resolveCandidate and checkHead", () => {
  it("resolves the PR, shadow id and artifact id through the API", async () => {
    const api = fake({
      "/repos/o/r/commits/": [{ number: 42, state: "open", head: { sha: SHA, repo: { id: 7 } } }],
      "/repos/o/r/actions/runs/99/artifacts": { artifacts: [{ id: 555, name: "candidate-preview", expired: false, workflow_run: { id: 99, head_sha: SHA } }] },
    });
    expect(await resolveCandidate(api, { repo: "o/r", repositoryId: 7, runId: 99, headSha: SHA })).toEqual({ prNumber: 42, previewId: 100_042, artifactId: 555 });
  });

  it("reports current, superseded and closed heads", async () => {
    const open = (sha: string) => fake({ "/repos/o/r/pulls/42": { state: "open", head: { sha } } });
    expect(await checkHead(open(SHA), "o/r", 42, SHA)).toBe("current");
    expect(await checkHead(open("b".repeat(40)), "o/r", 42, SHA)).toBe("superseded");
    expect(await checkHead(fake({ "/repos/o/r/pulls/42": { state: "closed", head: { sha: SHA } } }), "o/r", 42, SHA)).toBe("closed");
    expect(await checkHead(fake({}), "o/r", 42, SHA)).toBe("closed");
  });
});

describe("verifyTrustedPreview", () => {
  const run = (over: object = {}) => ({
    id: 11,
    run_number: 3,
    event: "workflow_run",
    status: "completed",
    conclusion: "success",
    path: TRUSTED_WORKFLOW_PATH,
    display_title: runTitle(SHA),
    ...over,
  });
  const okJobs = ["verify", provisionJobName(42, SHA), "e2e", "teardown", "result"].map((name) => ({ name, conclusion: "success" }));
  const api = (runs: object[], jobs: object[] = okJobs, repo: object | undefined = { default_branch: "main" }) =>
    fake({
      "/repos/o/r/actions/workflows/preview-trusted.yml/runs": { workflow_runs: runs },
      "/repos/o/r/actions/runs/": { jobs },
      "/repos/o/r": repo,
    });
  const input = { repo: "o/r", pr: 42, sha: SHA };

  it("accepts a successful default-branch run that provisioned the PR at the head", async () => {
    expect(await verifyTrustedPreview(api([run()]), input)).toEqual({ ok: true, runId: 11 });
    expect(await verifyTrustedPreview(api([run({ path: `${TRUSTED_WORKFLOW_PATH}@refs/heads/main` })]), input)).toEqual({ ok: true, runId: 11 });
  });

  it("uses the latest run for the head, so a later failure wins", async () => {
    const r = await verifyTrustedPreview(api([run(), run({ id: 12, run_number: 4, conclusion: "failure" })]), input);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("12") });
  });

  it("rejects a wrong path, title, event, in-progress run and missing or failed jobs", async () => {
    for (const bad of [
      [run({ path: ".github/workflows/ci.yml" })],
      [run({ path: `${TRUSTED_WORKFLOW_PATH}@refs/heads/feature` })],
      [run({ display_title: runTitle("b".repeat(40)) })],
      [run({ event: "push" })],
      [run({ status: "in_progress", conclusion: null })],
      [],
    ]) {
      expect((await verifyTrustedPreview(api(bad), input)).ok).toBe(false);
    }
    expect((await verifyTrustedPreview(api([run()], okJobs.filter((j) => j.name !== "e2e")), input)).ok).toBe(false);
    expect((await verifyTrustedPreview(api([run()], okJobs.map((j) => (j.name === "teardown" ? { ...j, conclusion: "failure" } : j))), input)).ok).toBe(false);
  });

  it("rejects a run that provisioned another PR or head", async () => {
    const jobs = okJobs.map((j) => (j.name.startsWith("provision") ? { ...j, name: provisionJobName(43, SHA) } : j));
    expect(await verifyTrustedPreview(api([run()], jobs), input)).toMatchObject({ ok: false, reason: expect.stringContaining("did not provision") });
  });

  it("fails when the repository or workflow is not found", async () => {
    expect((await verifyTrustedPreview(fake({}), input)).ok).toBe(false);
  });
});
