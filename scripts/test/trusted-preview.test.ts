import { describe, expect, it } from "vitest";
import { checkHead, resolveCandidate, selectArtifact, selectPullRequest, type GitHubRest } from "../lib/trusted-preview";

const SHA = "a".repeat(40);
const BASE = "c".repeat(40);

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

describe("selectPullRequest", () => {
  const pr = (number: number, over: object = {}) => ({ number, state: "open", head: { sha: SHA, repo: { id: 7 } }, base: { sha: BASE }, ...over });
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
  it("selects by kind: candidate-prod is not candidate-preview", () => {
    const both = [art(1), art(2, { name: "candidate-prod" })];
    expect(selectArtifact(both, 99, SHA, "prod").id).toBe(2);
    expect(selectArtifact(both, 99, SHA, "preview").id).toBe(1);
    expect(() => selectArtifact([art(1)], 99, SHA, "prod")).toThrow(/candidate-prod/);
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
  it("resolves the PR, its base and both artifact ids through the API", async () => {
    const artifact = (id: number, name: string) => ({ id, name, expired: false, workflow_run: { id: 99, head_sha: SHA } });
    const api = fake({
      "/repos/o/r/commits/": [{ number: 42, state: "open", head: { sha: SHA, repo: { id: 7 } }, base: { sha: BASE } }],
      "/repos/o/r/actions/runs/99/artifacts?name=candidate-preview": { artifacts: [artifact(555, "candidate-preview")] },
      "/repos/o/r/actions/runs/99/artifacts?name=candidate-prod": { artifacts: [artifact(556, "candidate-prod")] },
    });
    expect(await resolveCandidate(api, { repo: "o/r", repositoryId: 7, runId: 99, headSha: SHA })).toEqual({ prNumber: 42, baseSha: BASE, artifactId: 555, prodArtifactId: 556 });
  });

  it("reports current, superseded and closed heads", async () => {
    const open = (sha: string) => fake({ "/repos/o/r/pulls/42": { state: "open", head: { sha } } });
    expect(await checkHead(open(SHA), "o/r", 42, SHA)).toBe("current");
    expect(await checkHead(open("b".repeat(40)), "o/r", 42, SHA)).toBe("superseded");
    expect(await checkHead(fake({ "/repos/o/r/pulls/42": { state: "closed", head: { sha: SHA } } }), "o/r", 42, SHA)).toBe("closed");
    expect(await checkHead(fake({}), "o/r", 42, SHA)).toBe("closed");
  });
});
