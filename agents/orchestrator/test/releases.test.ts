// The `releases` sweeper part (AR8a): task_releases rows from `merged` events and the deploy runs that
// cover them, on PGlite as orch_rw with a fake GitHub. No network. Fixtures are synthetic.
import { generateKeyPairSync } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { fromPglite, migrate } from "@kcw/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAppOctokit, GitHubApiError } from "../src/github";
import {
  BUILD_ID_ANNOTATION_TITLE,
  DEPLOY_CLEAR_CACHE_STEP,
  MAX_RELEASE_COMPARES,
  OctokitSweeperGitHub,
  buildIdFromAnnotations,
  runReleases,
  runSweep,
  sqlSweeperStore,
  type DeployJob,
  type DeployRun,
  type SweeperGitHub,
} from "../src/sweeper";

const sha = (c: string) => c.repeat(40);
const MIN = 60_000;
const ago = (m: number) => new Date(Date.now() - m * MIN);

class FakeDeployGitHub {
  runs: DeployRun[] = [];
  jobs = new Map<number, DeployJob | null>();
  /** "base>head" pairs for which head is a descendant. */
  descends = new Set<string>();
  calls: string[] = [];
  fail: Error | null = null;
  async listDeployRuns(since: Date) {
    this.calls.push("listDeployRuns");
    if (this.fail) throw this.fail;
    return this.runs.filter((r) => r.createdAt >= since);
  }
  async getDeployJob(runId: number) {
    this.calls.push("getDeployJob");
    return this.jobs.get(runId) ?? null;
  }
  async isDescendant(b: string, h: string) {
    this.calls.push("isDescendant");
    return b === h || this.descends.has(`${b}>${h}`);
  }
  // The other parts of a full sweep.
  async listActiveAgentRuns() {
    return [];
  }
  async cancelRun() {
    return "cancelled" as const;
  }
  async dispatchWorkflow() {
    return { runId: null };
  }
  async countDispatchedRuns() {
    return 1;
  }
  async listDeliveries() {
    return [];
  }
  async redeliver() {}
}

/** A run created `createdMin` minutes ago. */
const run = (id: number, headSha: string, conclusion: string | null, createdMin: number, over: Partial<DeployRun> = {}): DeployRun => ({
  id,
  runAttempt: 1,
  headSha,
  status: conclusion === null ? "in_progress" : "completed",
  conclusion,
  createdAt: ago(createdMin),
  ...over,
});
const okJob = (doneMin: number, buildId: string | null = "build-1"): DeployJob => ({
  conclusion: "success",
  completedAt: ago(doneMin),
  clearCache: { conclusion: "success", completedAt: ago(doneMin + 2) },
  buildId,
});

describe("releases part (orch_rw on PGlite)", () => {
  let db: PGlite;
  let task = 0;
  let gh: FakeDeployGitHub;
  const store = () => sqlSweeperStore(fromPglite(db));
  const github = () => async () => gh as unknown as SweeperGitHub;

  beforeAll(async () => {
    db = await PGlite.create();
    await migrate(fromPglite(db));
    const { rows } = await db.query<{ id: number }>("INSERT INTO tasks (source, owner_text, status) VALUES ('console', 'synthetic', 'done') RETURNING id");
    task = Number(rows[0]!.id);
    await db.exec("SET SESSION AUTHORIZATION orch_rw");
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    gh = new FakeDeployGitHub();
    await admin("DELETE FROM task_releases; DELETE FROM agent_events");
  });

  async function admin(sql: string, params?: unknown[]) {
    await db.exec("SET SESSION AUTHORIZATION postgres");
    try {
      if (params === undefined) return await db.exec(sql);
      return await db.query(sql, params);
    } finally {
      await db.exec("SET SESSION AUTHORIZATION orch_rw");
    }
  }
  /** A merged event `minutesAgo` minutes ago. */
  async function mergedAgo(s: string, minutesAgo: number) {
    await admin("INSERT INTO agent_events (ts, task_id, agent, event_type, detail) VALUES ($1, $2, 'orchestrator', 'merged', $3)", [
      ago(minutesAgo).toISOString(),
      task,
      JSON.stringify({ pr: 7, sha: s }),
    ]);
  }
  const rowOf = async (s: string) =>
    (
      await db.query<Record<string, unknown>>(
        `SELECT deploy_run_id::int AS run, deploy_attempt AS attempt, deploy_sha, build_id, deployed_at IS NOT NULL AS deployed,
                verified_at IS NOT NULL AS verified, failed_at IS NOT NULL AS failed, checked_at IS NOT NULL AS checked,
                to_char(verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS verified_ts
           FROM task_releases WHERE merge_sha = $1`,
        [s],
      )
    ).rows[0];
  const count = async () => Number((await db.query<{ n: number }>("SELECT count(*) AS n FROM task_releases")).rows[0]!.n);

  it("(a) a green run for the exact sha verifies the release with run, build id and timestamps", async () => {
    await mergedAgo(sha("a"), 30);
    gh.runs = [run(100, sha("a"), "success", 20)];
    gh.jobs.set(100, { ...okJob(0), completedAt: new Date("2026-11-16T10:00:00.000Z") });
    const r = await runReleases(store(), github());
    expect(r).toEqual({ created: 1, polled: 1, verified: 1, failed: 0 });
    expect(await rowOf(sha("a"))).toMatchObject({ run: 100, attempt: 1, deploy_sha: sha("a"), build_id: "build-1", deployed: true, verified: true, failed: false, checked: true, verified_ts: "2026-11-16T10:00:00.000Z" });
  });

  it("(b) a job that failed at the smoke check after the cache clear: deployed and failed, never verified", async () => {
    await mergedAgo(sha("b"), 30);
    gh.runs = [run(101, sha("b"), "failure", 20)];
    gh.jobs.set(101, { conclusion: "failure", completedAt: ago(5), clearCache: { conclusion: "success", completedAt: ago(8) }, buildId: "build-2" });
    await runReleases(store(), github());
    expect(await rowOf(sha("b"))).toMatchObject({ run: 101, deployed: true, failed: true, verified: false, build_id: "build-2" });
  });

  it("(c) a job that failed at the build: only failed is set", async () => {
    await mergedAgo(sha("c"), 30);
    gh.runs = [run(102, sha("c"), "failure", 20)];
    gh.jobs.set(102, { conclusion: "failure", completedAt: ago(15), clearCache: { conclusion: "skipped", completedAt: null }, buildId: null });
    await runReleases(store(), github());
    expect(await rowOf(sha("c"))).toMatchObject({ run: 102, deployed: false, failed: true, verified: false, build_id: null });
  });

  it("(d) a cancelled exact-sha run is ignored; a newer green run on a descendant verifies the old commit", async () => {
    await mergedAgo(sha("d"), 30);
    gh.runs = [run(103, sha("d"), "cancelled", 20), run(104, sha("e"), "success", 10)];
    gh.descends.add(`${sha("d")}>${sha("e")}`);
    gh.jobs.set(104, okJob(0));
    gh.jobs.get(104)!.completedAt = ago(4);
    await runReleases(store(), github());
    expect(await rowOf(sha("d"))).toMatchObject({ run: 104, deploy_sha: sha("e"), verified: true, deployed: true, failed: false });
  });

  it("(e) a later green run clears failed_at", async () => {
    await mergedAgo(sha("f"), 30);
    gh.runs = [run(105, sha("f"), "failure", 20)];
    gh.jobs.set(105, { conclusion: "failure", completedAt: ago(15), clearCache: null, buildId: null });
    await runReleases(store(), github());
    expect(await rowOf(sha("f"))).toMatchObject({ failed: true, verified: false });
    gh.runs.push(run(106, sha("1"), "success", 5));
    gh.descends.add(`${sha("f")}>${sha("1")}`);
    gh.jobs.set(106, okJob(0));
    gh.jobs.get(106)!.completedAt = ago(1);
    await runReleases(store(), github());
    expect(await rowOf(sha("f"))).toMatchObject({ run: 106, failed: false, verified: true });
  });

  it("(f) in-progress and cancelled-only runs write nothing but checked_at", async () => {
    await mergedAgo(sha("2"), 30);
    gh.runs = [run(107, sha("2"), null, 20), run(108, sha("2"), "cancelled", 18)];
    await runReleases(store(), github());
    expect(await rowOf(sha("2"))).toMatchObject({ run: null, deployed: false, verified: false, failed: false, checked: true });
    expect(gh.calls).not.toContain("getDeployJob");
  });

  it("(g) a rerun (same run id, attempt 2) is picked up after a failed attempt", async () => {
    await mergedAgo(sha("3"), 30);
    gh.runs = [run(109, sha("3"), "failure", 20)];
    gh.jobs.set(109, { conclusion: "failure", completedAt: ago(15), clearCache: null, buildId: null });
    await runReleases(store(), github());
    expect(await rowOf(sha("3"))).toMatchObject({ run: 109, attempt: 1, failed: true });
    gh.runs = [run(109, sha("3"), "success", 20, { runAttempt: 2 })];
    gh.jobs.set(109, { ...okJob(0), completedAt: ago(3) });
    await runReleases(store(), github());
    expect(await rowOf(sha("3"))).toMatchObject({ run: 109, attempt: 2, failed: false, verified: true });
  });

  it("(h) repeating a sweep writes the same values and no duplicate row", async () => {
    await mergedAgo(sha("4"), 30);
    gh.runs = [run(110, sha("4"), "failure", 20)];
    gh.jobs.set(110, { conclusion: "failure", completedAt: ago(15), clearCache: { conclusion: "success", completedAt: ago(16) }, buildId: "b" });
    await runReleases(store(), github());
    const first = await rowOf(sha("4"));
    const r = await runReleases(store(), github());
    expect(r.created).toBe(0);
    expect(await rowOf(sha("4"))).toEqual(first);
    expect(await count()).toBe(1);
  });

  it("(i) detail.sha unknown or not 40 lowercase hex creates no row; a merge older than 24 hours creates none either", async () => {
    for (const bad of ["unknown", "A".repeat(40), "a".repeat(39), "g".repeat(40)]) await mergedAgo(bad, 5);
    await admin("INSERT INTO agent_events (task_id, agent, event_type, detail) VALUES ($1, 'orchestrator', 'merged', '{\"pr\":3,\"by\":\"external\"}')", [task]);
    await mergedAgo(sha("5"), 25 * 60);
    const r = await runReleases(store(), github());
    expect(r.created).toBe(0);
    expect(await count()).toBe(0);
    expect(gh.calls).toEqual([]);
  });

  it("makes no GitHub call when no row needs polling (not even creating the client)", async () => {
    let built = 0;
    await runReleases(store(), async () => {
      built += 1;
      return gh as unknown as SweeperGitHub;
    });
    expect(built).toBe(0);
    expect(gh.calls).toEqual([]);
    // A verified row needs no poll either.
    await mergedAgo(sha("6"), 30);
    await admin("INSERT INTO task_releases (merge_sha, task_id, merged_at, verified_at) VALUES ($1, $2, now(), now()) ON CONFLICT DO NOTHING", [sha("6"), task]);
    await runReleases(store(), github());
    expect(gh.calls).toEqual([]);
  });

  it("(j) a GitHub error fails only the releases part, by class; the other parts still run", async () => {
    await mergedAgo(sha("7"), 30);
    gh.fail = new GitHubApiError("listDeployRuns", 502);
    const sent: string[] = [];
    const logs: string[] = [];
    const report = await runSweep({
      store: store(),
      queue: { send: async (m) => void sent.push(m.body) },
      github: async () => gh as unknown as SweeperGitHub,
      scheduledTime: new Date("2026-10-23T12:00:00Z"),
      now: new Date("2026-10-23T12:00:00Z"),
      log: (l) => logs.push(l),
    });
    expect(report.failed).toEqual({ releases: "GitHubApiError" });
    expect(report.spend).not.toBeNull();
    expect(report.paused).toBe(false);
    expect(report.releases).toBeNull();
    expect(await count()).toBe(1); // the row was created before the GitHub read failed
  });

  it("(k) caps: 25 unverified rows poll 20, never-checked rows first", async () => {
    for (let i = 0; i < 25; i++) await mergedAgo(sha((i % 10).toString()).slice(0, 38) + String(10 + i), 30 + i);
    gh.runs = [];
    const r = await runReleases(store(), github());
    expect(r.created).toBe(25);
    expect(r.polled).toBe(20);
    expect(Number((await db.query<{ n: number }>("SELECT count(*) AS n FROM task_releases WHERE checked_at IS NOT NULL")).rows[0]!.n)).toBe(20);
    // The five unchecked rows go first next time.
    const next = await store().listReleasesToPoll(5);
    expect(await Promise.all(next.map(async (n) => (await rowOf(n.mergeSha))!.checked))).toEqual([false, false, false, false, false]);

  });

  it("(k2) at most 20 compare calls per sweep", async () => {
    for (let i = 0; i < 20; i++) await mergedAgo("1".repeat(38) + String(10 + i), 30);
    gh.runs = Array.from({ length: 5 }, (_, i) => run(300 + i, "2".repeat(38) + "0" + i, "success", 10 + i));
    await runReleases(store(), github());
    expect(gh.calls.filter((c) => c === "isDescendant")).toHaveLength(MAX_RELEASE_COMPARES);
  });

  it("(l) a build id annotation with a non-matching message leaves build_id null; verification stands", async () => {
    expect(buildIdFromAnnotations([{ title: BUILD_ID_ANNOTATION_TITLE, message: "bad id!" }])).toBeNull();
    expect(buildIdFromAnnotations([{ title: "other", message: "ok-1" }, { title: BUILD_ID_ANNOTATION_TITLE, message: "ok-1" }])).toBe("ok-1");
    expect(buildIdFromAnnotations([{ title: BUILD_ID_ANNOTATION_TITLE, message: "x".repeat(65) }])).toBeNull();
    await mergedAgo(sha("8"), 30);
    gh.runs = [run(111, sha("8"), "success", 20)];
    gh.jobs.set(111, { ...okJob(0, null), completedAt: ago(10) });
    await runReleases(store(), github());
    expect(await rowOf(sha("8"))).toMatchObject({ verified: true, build_id: null });
  });

  it("does not verify a green run whose job did not conclude success", async () => {
    await mergedAgo(sha("9"), 30);
    gh.runs = [run(112, sha("9"), "success", 20)];
    gh.jobs.set(112, { conclusion: "failure", completedAt: ago(10), clearCache: null, buildId: null });
    await runReleases(store(), github());
    expect(await rowOf(sha("9"))).toMatchObject({ verified: false, failed: false, run: null });
  });

  it("ignores runs created more than 10 minutes before the merge", async () => {
    await mergedAgo(sha("0"), 30);
    gh.runs = [run(113, sha("0"), "success", 45)];
    gh.jobs.set(113, okJob(0));
    await runReleases(store(), github());
    expect(await rowOf(sha("0"))).toMatchObject({ verified: false, run: null });
  });
});

// ---------------------------------------------------------------- the Octokit calls (mock fetch)

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });

describe("OctokitSweeperGitHub release reads", () => {
  function client(respond: (path: string, url: URL) => Response | undefined) {
    const calls: string[] = [];
    const fetch = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url.pathname + url.search);
      if (/access_tokens$/.test(url.pathname)) {
        return new Response(JSON.stringify({ token: "ghs_synthetic", expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: {}, repository_selection: "selected" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      return respond(url.pathname, url) ?? new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    };
    const octokit = createAppOctokit({ appId: "Iv23synthetic", privateKey, installationId: 42 }, { repo: "o/r", fetch: fetch as typeof globalThis.fetch });
    return { calls, client: new OctokitSweeperGitHub(octokit, "o/r") };
  }

  it("lists deploy runs of main in one call and maps the fields", async () => {
    const { calls, client: c } = client((p) =>
      p === "/repos/o/r/actions/workflows/deploy.yml/runs"
        ? json({ total_count: 1, workflow_runs: [{ id: 9, run_attempt: 2, head_sha: sha("a"), status: "completed", conclusion: "success", created_at: "2026-11-16T09:00:00Z" }] })
        : undefined,
    );
    const runs = await c.listDeployRuns(new Date("2026-11-16T08:00:00.000Z"));
    expect(runs).toEqual([{ id: 9, runAttempt: 2, headSha: sha("a"), status: "completed", conclusion: "success", createdAt: new Date("2026-11-16T09:00:00Z") }]);
    const api = calls.filter((x) => !x.includes("access_tokens"));
    expect(api).toHaveLength(1);
    expect(api[0]).toContain("branch=main");
    expect(api[0]).toContain("per_page=50");
    expect(api[0]).toContain("created=%3E%3D2026-11-16T08%3A00%3A00Z");
  });

  it("reads the deploy job, the cache-clear step and the build id annotation (only a valid one)", async () => {
    const job = {
      id: 77,
      name: "deploy",
      conclusion: "success",
      completed_at: "2026-11-16T09:10:00Z",
      steps: [
        { name: "Prod build", conclusion: "success", completed_at: "2026-11-16T09:01:00Z" },
        { name: DEPLOY_CLEAR_CACHE_STEP, conclusion: "success", completed_at: "2026-11-16T09:08:00Z" },
      ],
    };
    const { calls, client: c } = client((p) => {
      if (p === "/repos/o/r/actions/runs/9/jobs") return json({ total_count: 1, jobs: [job] });
      if (p === "/repos/o/r/check-runs/77/annotations") return json([{ title: BUILD_ID_ANNOTATION_TITLE, message: "build-7" }]);
      return undefined;
    });
    expect(await c.getDeployJob(9)).toEqual({
      conclusion: "success",
      completedAt: new Date("2026-11-16T09:10:00Z"),
      clearCache: { conclusion: "success", completedAt: new Date("2026-11-16T09:08:00Z") },
      buildId: "build-7",
    });
    expect(calls.some((x) => x.includes("filter=latest"))).toBe(true);
  });

  it("returns null when the run has no deploy job, and maps compare status ahead/identical to descendant", async () => {
    const status = { current: "ahead" };
    const { client: c } = client((p) => {
      if (p === "/repos/o/r/actions/runs/9/jobs") return json({ total_count: 0, jobs: [] });
      if (p.startsWith("/repos/o/r/compare/")) return json({ status: status.current, ahead_by: 1, behind_by: 0, total_commits: 1, commits: [], files: [] });
      return undefined;
    });
    expect(await c.getDeployJob(9)).toBeNull();
    for (const [s, want] of [["ahead", true], ["identical", true], ["behind", false], ["diverged", false]] as const) {
      status.current = s;
      expect(await c.isDescendant(sha("a"), sha("b"))).toBe(want);
    }
  });
});
