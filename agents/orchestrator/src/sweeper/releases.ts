// The `releases` sweeper part (AR8a, DESIGN §3.2, §4.3): merged, deployed and verified as three
// separately recorded facts per merge commit (task_releases, migration 0023). Pull, not push: it
// reads the deploy workflow's runs from GitHub. Read-only GitHub calls, no dispatch, so it is
// independent of the spend gate and runs while agents are paused. With nothing to poll it makes no
// GitHub call at all.
//
// A run covers merge commit M when its head is M or a descendant of M (a newer pending run replaces
// an older one, deploy.yml concurrency). Per release: the oldest covering run with conclusion success
// wins (deployed_at from the cache-clear step if it succeeded, verified_at from the job, failed_at
// cleared); otherwise the latest covering failure/timed_out run sets failed_at (and deployed_at when
// the cache clear succeeded). Cancelled, queued and in-progress runs are ignored. verified_at is
// never set unless the job concluded success. Repeating a sweep writes the same values.
import { MAX_RELEASE_POLLS, type ReleaseEvidence, type SweeperStore } from "./store";
import type { DeployJob, DeployRun, SweeperGitHub } from "./github";

/** A deploy run created up to this long before the merge time can still cover the merge commit. */
export const RELEASE_RUN_LEEWAY_MS = 10 * 60_000;
/** Compare calls per sweep (a descendant check per candidate run and release). */
export const MAX_RELEASE_COMPARES = 20;

export interface ReleasesReport {
  /** task_releases rows created this run. */
  created: number;
  /** Releases polled, and how many of them ended verified or failed in this poll. */
  polled: number;
  verified: number;
  failed: number;
}

export async function runReleases(store: SweeperStore, github: () => Promise<SweeperGitHub>): Promise<ReleasesReport> {
  const report: ReleasesReport = { created: await store.recordMergedReleases(), polled: 0, verified: 0, failed: 0 };
  const rows = await store.listReleasesToPoll(MAX_RELEASE_POLLS);
  if (rows.length === 0) return report;

  const client = await github();
  const oldest = Math.min(...rows.map((r) => r.mergedAt.getTime()));
  const runs = (await client.listDeployRuns(new Date(oldest - RELEASE_RUN_LEEWAY_MS)))
    .filter((r) => r.status === "completed" && (r.conclusion === "success" || r.conclusion === "failure" || r.conclusion === "timed_out"))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id);

  let compares = 0;
  const jobs = new Map<string, DeployJob | null>();
  const jobOf = async (run: DeployRun) => {
    const key = `${run.id}/${run.runAttempt}`;
    if (!jobs.has(key)) jobs.set(key, await client.getDeployJob(run.id));
    return jobs.get(key)!;
  };

  for (const row of rows) {
    report.polled += 1;
    const notBefore = row.mergedAt.getTime() - RELEASE_RUN_LEEWAY_MS;
    let success: DeployRun | undefined;
    let failure: DeployRun | undefined;
    for (const run of runs) {
      if (run.createdAt.getTime() < notBefore) continue;
      if (run.headSha !== row.mergeSha) {
        if (compares >= MAX_RELEASE_COMPARES) continue;
        compares += 1;
        if (!(await client.isDescendant(row.mergeSha, run.headSha))) continue;
      }
      if (run.conclusion === "success") {
        success = run;
        break;
      }
      failure = run;
    }

    let evidence: ReleaseEvidence | null = null;
    const run = success ?? failure;
    const job = run ? await jobOf(run) : null;
    if (run && job) {
      const cleared = job.clearCache?.conclusion === "success" ? job.clearCache.completedAt : null;
      const base = { runId: run.id, attempt: run.runAttempt, deploySha: run.headSha, buildId: job.buildId, deployedAt: cleared };
      if (success && job.conclusion === "success" && job.completedAt) {
        evidence = { ...base, verifiedAt: job.completedAt, failedAt: null };
        report.verified += 1;
      } else if (!success && (job.conclusion === "failure" || job.conclusion === "timed_out")) {
        evidence = { ...base, verifiedAt: null, failedAt: job.completedAt ?? run.createdAt };
        report.failed += 1;
      }
    }
    await store.recordReleaseCheck(row.mergeSha, evidence);
  }
  return report;
}
