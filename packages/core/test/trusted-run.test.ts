import { describe, expect, it } from "vitest";
import { provisionJobName, runTitle, TRUSTED_WORKFLOW_PATH, verifyTrustedPreview, type GitHubRead } from "../src/trusted-run/index";

const SHA = "a".repeat(40);

/** Fake API keyed by path prefix. */
function fake(routes: Record<string, unknown>): GitHubRead {
  return {
    async get<T>(path: string) {
      const key = Object.keys(routes).find((k) => path.startsWith(k));
      return key === undefined ? undefined : (routes[key] as T);
    },
  };
}

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
  const okJobs = ["verify", "prod-plan", provisionJobName(42, SHA), "e2e", "teardown", "result"].map((name) => ({ name, conclusion: "success" }));
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

  it("requires the prod-plan job", async () => {
    expect(await verifyTrustedPreview(api([run()], okJobs.filter((j) => j.name !== "prod-plan")), input)).toMatchObject({ ok: false, reason: expect.stringContaining("prod-plan") });
    const failedPlan = okJobs.map((j) => (j.name === "prod-plan" ? { ...j, conclusion: "failure" } : j));
    expect((await verifyTrustedPreview(api([run()], failedPlan), input)).ok).toBe(false);
  });

  it("tells a pending run (none yet, in progress) from a failed one", async () => {
    expect(await verifyTrustedPreview(api([]), input)).toMatchObject({ ok: false, state: "pending" });
    expect(await verifyTrustedPreview(api([run({ status: "in_progress", conclusion: null })]), input)).toMatchObject({ ok: false, state: "pending" });
    expect(await verifyTrustedPreview(api([run({ conclusion: "failure" })]), input)).toMatchObject({ ok: false, state: "failed" });
    expect(await verifyTrustedPreview(api([run({ path: ".github/workflows/ci.yml" })]), input)).toMatchObject({ ok: false, state: "failed" });
  });

  it("rejects a run that provisioned another PR or head", async () => {
    const jobs = okJobs.map((j) => (j.name.startsWith("provision") ? { ...j, name: provisionJobName(43, SHA) } : j));
    expect(await verifyTrustedPreview(api([run()], jobs), input)).toMatchObject({ ok: false, reason: expect.stringContaining("did not provision") });
  });

  it("fails when the repository or workflow is not found", async () => {
    expect((await verifyTrustedPreview(fake({}), input)).ok).toBe(false);
  });
});
