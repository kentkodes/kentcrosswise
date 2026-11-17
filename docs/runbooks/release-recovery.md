# Runbook: release recovery (owner)

For the owner. How a release is recorded, what to do when a deploy step fails, how to go back to a previous build, and how to restore and rehearse restoring the production database (AR8a, [RELIABILITY-PLAN](../RELIABILITY-PLAN.md)). Agents and the Liaison may read this and prepare commands; they run none of the **owner-only live steps** below (rule 12 of [INSTRUCTIONS](../agents/INSTRUCTIONS.md)).

Steps marked "verify at execution time" are console actions whose labels or limits were not confirmed from this repository's documents ([prod-db.md](prod-db.md), [infra research](../research/infra.md)). Check the vendor console or documentation first, and do not paste a connection string or password into chat or a file.

## 1. Merged, deployed and verified are three facts

A change is **merged** when its squash commit is on `main`. It is **deployed** when the `deploy` run for that commit finished **Terraform apply infra/prod** and the CloudFront invalidation. It is **verified** when the last step of that same run, **Smoke check**, passed: it fetches the public pages and requires the build id in `apps/web/.open-next/kcw-build.json` (written by that run's own `pnpm build-web`) in the served HTML.

Record them separately, each bound to the commit:

| Fact | Evidence | Where |
|---|---|---|
| merged | merge commit SHA on `main` | GitHub commit page of the PR |
| deployed | the `deploy` run whose head SHA is that commit, steps up to **Clear the CloudFront cache** green | Actions, workflow `deploy` |
| verified | the same run's **Smoke check** step green (build id seen on the live site) | same run |

A red or cancelled run, or a run for a different commit, is not "deployed" or "verified" for this commit. Concurrency: runs are serialized and never cancelled mid-apply; a newer pending run replaces an older pending one, so the older commit is then covered only by the newer run (record the newer SHA as the deployed one). The three facts are recorded per merge commit in `task_releases` by the sweeper part `releases` (merged = the `merged` event, deployed = the `Clear the CloudFront cache` step succeeded, verified = the whole deploy job succeeded, bound to the deploy run id and attempt and, when the annotation is available, the build id; verified is final). The owner console "Releases" block shows: Merged (no deploy result yet, under 60 minutes), Deployed not verified (cache cleared, job not green), Verified, Deploy failed (job failed or timed out; also when the cache clear succeeded and the smoke check failed) and No deploy result (nothing recorded 60 minutes after the merge). Only merges of the last 24 hours get a row and a row is polled for 7 days: a merge whose deploy result is still missing after 7 days stays "No deploy result" in the console until it leaves the last 10. Gap: merges made by the owner scripts or externally (`by: external`, no SHA in the event) and merges from before migration 0023 are not tracked. A run superseded by a newer pending run is `cancelled` and ignored; the newer run covers the older commit. Not verified live: that GitHub returns the build-id annotation and the job step fields as the sweeper reads them.

## 2. Deploy order

`deploy.yml` (environment `prod`, role `kcw-gh-deploy`) runs, in this order:

1. **Prod build** (`pnpm build-web`) and **Lambda bundles** (`pnpm build-lambdas`): no AWS credentials, no production access.
2. AWS credentials, **Migrate prod** (`pnpm migrate --secret kcw/prod/migrator`).
3. **Terraform init/apply infra/prod** (uploads the web build and the Lambda code).
4. **Clear the CloudFront cache** (`/*`, waits for completion).
5. **Smoke check** (public pages carry this build id, `/hub` redirects to sign-in).

Builds come first, so a failed build never touches the production schema.

## 3. What to do when a step fails

Open the failed run, read the first red step. Nothing here needs production access except where marked **owner-only**.

**Build or Lambda bundles fail.** Production is unchanged (schema and infrastructure). Fix forward with a normal PR (or revert the merge commit, section 4). Nothing to restore.

**Migrate prod fails.** Each migration file runs in its own transaction, so the failing file rolled back; earlier files of the same run stay applied. Infrastructure and Lambdas are unchanged, so the previous build still runs against a schema that is the old one plus fully applied additive migrations (section 5). Read the error class (the runner prints the migration name and the driver message, never the URL). Typical causes: a lock that could not be taken (`55P03`, rerun in a quieter window, see [prod-db.md](prod-db.md) §5.6), a missing or invalid `kcw/prod/migrator` secret, an edited applied migration (checksum error: restore the file, add a new migration instead). Fix forward by a PR, then the next deploy retries the pending files. **Owner-only:** inspecting `schema_migrations` in the Neon SQL Editor.

**Terraform apply fails.** The schema is already migrated (additive, so the previous build still works), and infrastructure may be partly applied. Terraform state is locked during the run and unlocked on exit; a hard-cancelled run can leave a lock (`-lock-timeout=10m` makes the next run wait, then fail with the lock id). Re-run the failed run's jobs (**Re-run failed jobs**) once the cause is fixed: migrate is a no-op, apply is idempotent. If the cause is the code of the change, revert it (section 4). **Owner-only:** force-unlocking state, and any local `terraform` command.

**Smoke check fails.** The apply and the invalidation succeeded but the live site did not show this build id or a page was wrong. The release is **deployed but not verified**; do not report it as success. Retry only the smoke check first (**Re-run failed jobs** reruns the whole job, which is safe and idempotent), since CloudFront may still be propagating (the check already retries 20 times, 15 s apart). If it still fails, treat the change as bad: revert it (section 4) and check the web Lambda log group for `init failed` or database error classes ([prod-db.md](prod-db.md) §5).

## 4. Redeploying a previous build

**Normal path: revert through a PR.** Open a PR that reverts the merge commit (`git revert -m` is not needed for squash commits: `git revert <sha>`), let `ci/required` pass, merge it, and let `deploy.yml` deploy the result. This keeps every migration file on `main`: the runner refuses a database that has applied migrations missing on disk, so never remove a migration file to go back. If the reverted change added a migration, the schema keeps the additive objects; the previous build ignores them (section 5). Dropping them is a separate, owner-reviewed contract migration.

**Not available: re-running an old deploy run.** A re-run uses the old commit's migration list, which lacks the newer applied migrations, so **Migrate prod** fails by design (applied in the database but missing on disk). Do not work around it by editing the schema table.

**Emergency path (owner-only, live): apply an older commit by hand.** Only when `main` cannot be fixed quickly and the previous build must be served now. As the owner, with admin credentials, in a clean checkout of the older commit: `pnpm install --frozen-lockfile`, `pnpm build-web`, `pnpm build-lambdas`, then `terraform -chdir=infra/prod init` and `apply` as `deploy.yml` does, skipping `pnpm migrate`; invalidate CloudFront `/*`; run `pnpm smoke-check --url <prod url> --build-file apps/web/.open-next/kcw-build.json`. Verify at execution time: the state bucket and backend arguments (`TF_STATE_BUCKET`, domain variable `TF_VAR_domain_name`), and that the older commit's Terraform matches the current infrastructure (if infrastructure changed since, do not use this path). Afterwards land a revert PR so `main` matches what is served; the next deploy of `main` replaces the hand-applied build.

## 5. Expand, then contract

A migration must be compatible with the build that is live when it runs (the previous build keeps serving through a failed apply, a rollback, and Lambda instances that have not yet been replaced). Therefore:

- **Expand (one release):** add tables, nullable columns, columns with a default, indexes, grants. Ship the code that uses them in the same or a later release.
- **Contract (a later release, after no deployed build reads the old shape):** drop, rename, change a column type, `SET NOT NULL`, add a `NOT NULL` column without a default. Split a rename or type change into add new, backfill, switch code, then drop old.
- `agents/merge-rules` marks the incompatible patterns owner-critical (`DROP`, `RENAME`, `TRUNCATE`, `ALTER COLUMN ... TYPE`, `SET NOT NULL`, `ADD COLUMN ... NOT NULL` without `DEFAULT`), as it does for any edit of an existing migration. The owner approves a contract migration only after confirming that the previous build no longer needs the old shape and that a restore point exists (section 6).
- Never edit an applied migration; fix forward.

## 6. Database restore (Neon point-in-time)

Use when data was lost or corrupted and fixing forward is not enough. **Everything in this section is an owner-only live step.** Neon keeps a limited restore window (the research notes record 6 hours on the Free plan; verify at execution time in the project's settings, and that the plan has not changed). A restore outside the window is impossible, so decide quickly and note the time of the last good state.

1. **Stop writers.** Set `agents_paused=true` in the console and keep agent workflows disabled so the orchestrator stops writing. If the web app must not write either, `ALTER ROLE web_app NOLOGIN;` ([prod-db.md](prod-db.md) §6; reversible).
2. **Pick the timestamp** just before the damage (from application events or the deploy run time). Verify at execution time: the Neon console time zone.
3. **Restore as a new branch first** (console action: Neon project, **Branches**, create a branch from the default branch at that timestamp; wording verify at execution time). Do not overwrite the default branch yet. This gives an isolated copy to inspect and to rehearse against (section 7), and keeps the damaged state for forensics.
4. **Check the copy** with the rehearsal script (section 7) and by reading the rows you need.
5. **Cut over** (console action, verify at execution time: Neon's "restore" of the default branch to a time or to a branch, versus pointing the secrets at the new branch). Restoring in place keeps the connection strings and secrets unchanged, which is the simpler option; if the restore creates a new endpoint instead, update `db_url`, `db_url_public` in `kcw/prod/web`, `kcw/prod/orchestrator`, `kcw/prod/relay`, `kcw/prod/pipeline` and `kcw/prod/migrator` through the Secrets Manager console, and redeploy so warm Lambdas re-read them ([prod-db.md](prod-db.md) §5.2). Login users and passwords live in the database: a point-in-time restore returns them to their state at that time, so after restoring across a password rotation, rotate again.
6. **Reconcile the schema:** run `deploy.yml` (or wait for the next one). If the restore point is before the latest migration, the pending migrations are applied again, which is the point of additive migrations.
7. **Verify:** section 5 of [prod-db.md](prod-db.md), then re-enable writers (`ALTER ROLE web_app LOGIN;`, unpause agents).

Work done after the restore point (tasks, usage rows, events) is lost; list what the orchestrator and GitHub still know (open PRs, merged commits) and reconcile by hand.

## 7. Restore rehearsal

Run at least before the first contract migration, and after any change of Neon plan or database layout. **Owner-only live steps:** creating and deleting the Neon branch and reading its connection string. The script itself reads only the database it is given.

1. In the Neon console create an isolated branch from the default branch at a recent time (the same action as section 6 step 3; verify at execution time). Use a **direct** (non-pooled) connection string for a role that can read every table (for example `migrator_app`).
2. Put the URL in the environment of your shell without echoing it, for example in PowerShell `$env:DATABASE_URL = Read-Host "restored branch URL"` (the value shows on screen while typed, so do it where nobody watches), or store it in a scratch secret that is not a production name and use `--secret <name>`.
3. Run from the repository root:

   ```
   pnpm restore-rehearsal --isolated
   pnpm restore-rehearsal --isolated --secret <scratch secret name>
   ```

   It checks that every migration file on disk is recorded with a matching checksum and none is pending (the runner's dry run), and that a fixed set of reads works (row counts of `entries`, `todos`, `ideas`, `projects`, `contacts`, `essays`, `sources`, `ratings`, `tasks`, `agent_events`, `agent_runs`, `usage_events`). It prints counts and migration versions only, never rows, and exits 1 on any failure. Compare the counts with what you expect from production.
4. **How it refuses production:** it will not start without `--isolated` (you state the URL is a restored copy), and it refuses any `--secret` whose name has a `prod` or `production` segment (`kcw/prod/migrator` and the like). For `DATABASE_URL` it cannot see the host, so the flag and your care are the only guard: never export a production URL into the shell that runs it. It also runs the migration dry run, which creates `schema_migrations` if missing; on a restored branch that is harmless.
5. Delete the branch and clear the variable (`Remove-Item Env:DATABASE_URL`) afterwards. Record the date and result in [HANDOFF](../HANDOFF.md) through the Liaison.

A pending migration after a restore is expected when the restore point is older than the newest migration; the rehearsal then reports it as a failure on purpose, so you see it before cutting over (section 6 step 6 applies it).
