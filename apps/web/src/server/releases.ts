// Owner console: the last merges with their deploy state (AR8a, DESIGN §3.2, §4.3). Runs as web_rw
// (read only). task_releases holds SHAs, run ids, build ids and timestamps only: no task text.
import type { Queryable } from "./db";

export const RELEASE_LIST_LIMIT = 10;
/** A merge without a deploy result after this long is shown as "No deploy result". */
export const RELEASE_MISSING_AFTER_MS = 60 * 60_000;

export type ReleaseLabel = "verified" | "deployed" | "failed" | "missing" | "merged";

export interface ReleaseRow {
  taskId: number;
  prNumber: number | null;
  mergeSha: string;
  /** First 7 characters of mergeSha. */
  shortSha: string;
  runId: number | null;
  runAttempt: number | null;
  buildId: string | null;
  mergedAt: string;
  deployedAt: string | null;
  verifiedAt: string | null;
  failedAt: string | null;
  label: ReleaseLabel;
}

interface Row {
  merge_sha: string;
  task_id: string | number;
  pr_number: number | null;
  merged_at: Date | string;
  deploy_run_id: string | number | null;
  deploy_attempt: number | null;
  build_id: string | null;
  deployed_at: Date | string | null;
  verified_at: Date | string | null;
  failed_at: Date | string | null;
}

/**
 * One label per release. Verified needs verified_at; a failed deploy stays "failed" even when its
 * cache clear succeeded (deployed_at is also set); "missing" is derived here, never stored.
 */
export function releaseLabel(
  r: { mergedAt: string; deployedAt: string | null; verifiedAt: string | null; failedAt: string | null },
  now: Date,
): ReleaseLabel {
  if (r.verifiedAt) return "verified";
  if (r.failedAt) return "failed";
  if (r.deployedAt) return "deployed";
  return now.getTime() - Date.parse(r.mergedAt) > RELEASE_MISSING_AFTER_MS ? "missing" : "merged";
}

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

/** The last 10 releases, newest merge first. */
export async function listReleases(db: Queryable, now: Date = new Date()): Promise<ReleaseRow[]> {
  const { rows } = await db.query<Row>(
    `SELECT merge_sha, task_id, pr_number, merged_at, deploy_run_id, deploy_attempt, build_id, deployed_at, verified_at, failed_at
       FROM task_releases ORDER BY merged_at DESC, merge_sha LIMIT $1`,
    [RELEASE_LIST_LIMIT],
  );
  return rows.map((r) => {
    const times = { mergedAt: iso(r.merged_at)!, deployedAt: iso(r.deployed_at), verifiedAt: iso(r.verified_at), failedAt: iso(r.failed_at) };
    return {
      taskId: Number(r.task_id),
      prNumber: r.pr_number,
      mergeSha: r.merge_sha,
      shortSha: r.merge_sha.slice(0, 7),
      runId: r.deploy_run_id === null ? null : Number(r.deploy_run_id),
      runAttempt: r.deploy_attempt,
      buildId: r.build_id,
      ...times,
      label: releaseLabel(times, now),
    };
  });
}

/**
 * The releases for the console, isolated from the rest of the page: a failing read (inside the page's
 * transaction, so under a savepoint) gives `unavailable` and no detail, never an error.
 */
export async function loadReleases(db: Queryable, now: Date = new Date()): Promise<{ releases: ReleaseRow[]; unavailable: boolean }> {
  try {
    await db.query("SAVEPOINT releases_read");
    const releases = await listReleases(db, now);
    await db.query("RELEASE SAVEPOINT releases_read");
    return { releases, unavailable: false };
  } catch {
    try {
      await db.query("ROLLBACK TO SAVEPOINT releases_read");
    } catch {
      // The transaction is unusable; the caller's own error handling applies on commit.
    }
    return { releases: [], unavailable: true };
  }
}
