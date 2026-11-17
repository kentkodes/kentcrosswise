-- 0023 (AR8a): merged, deployed and verified as three separately recorded facts per merge commit
-- (docs/runbooks/release-recovery.md section 1, DESIGN §3.2, §4.3).
-- One row per merge commit. The sweeper part `releases` creates the row from the `merged` event
-- (merge_sha, task_id, pr_number, merged_at) and later fills the evidence columns from GitHub: the
-- deploy run chosen, its head SHA, the build id, and the three timestamps deployed_at (the cache
-- clear step succeeded), verified_at (the whole deploy job succeeded) and failed_at. verified_at is
-- never set for a job that did not conclude success. Public-safe data only: SHAs, run ids, build ids,
-- timestamps. Additive, no foreign keys, nothing in the live build reads it.
-- Grants match the queries in agents/orchestrator/src/sweeper/store.ts (orch_rw) and
-- apps/web/src/server/releases.ts (web_rw, read only); no other role.
SET LOCAL lock_timeout = '5s';
CREATE TABLE task_releases (
  merge_sha text PRIMARY KEY CHECK (merge_sha ~ '^[0-9a-f]{40}$'),
  task_id bigint NOT NULL,
  pr_number integer,
  merged_at timestamptz NOT NULL,
  deploy_run_id bigint,
  deploy_attempt integer,
  deploy_sha text CHECK (deploy_sha ~ '^[0-9a-f]{40}$'),
  build_id text CHECK (build_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  deployed_at timestamptz,
  verified_at timestamptz,
  failed_at timestamptz,
  checked_at timestamptz
);

GRANT SELECT ON task_releases TO orch_rw, web_rw;
GRANT INSERT (merge_sha, task_id, pr_number, merged_at) ON task_releases TO orch_rw;
GRANT UPDATE (deploy_run_id, deploy_attempt, deploy_sha, build_id, deployed_at, verified_at, failed_at, checked_at) ON task_releases TO orch_rw;
