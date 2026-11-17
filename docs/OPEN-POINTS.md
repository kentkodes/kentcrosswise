# Kentcrosswise open points

Current backlog, 2026-11-17 UTC, from origin/main at `88190c7`. Current state and holds are in [HANDOFF.md](HANDOFF.md); done items are removed (Git history has the earlier list). Owner direction: autonomous development is the primary outcome; the hub is its demonstration workload. Complete the reliability sequence below before further hub, essay or office expansion.

## Autonomous development reliability (accepted priority, implementation pending)

The target lifecycle is defined in [DESIGN.md](DESIGN.md), section 4.0. For implementation, read the on-demand [execution plan](RELIABILITY-PLAN.md): scoped PR slices, trust boundaries, failure tests and session handoff. Deliver in the order below; later implementation can identify independent work without weakening prerequisites. Source-review findings are not claims that a production incident occurred. Existing owner gates still apply.

| ID | Work and completion evidence |
|---|---|
| AR5 | AR5a is merged (the worker side #143, the planner side #145, QA of a Docs-keeper PR without a contract #146): contracts are authored against a repository brief and sent with every Developer and QA dispatch. AR5b is merged (#147, migration 0021, applied on prod by its deploy): task revisions, attempt rows, CI and QA evidence tied to revision and head, and replan (approving an attempts-exhausted failure replans the task). Remaining: measure accepted-task input/output usage against the recorded ~1.1M-input-token one-line canary (former R3), not a token target invented here. Depends on AR3-AR4. |
| AR6 | Reservations are implemented and merged (#149, no migration; the owner status is #141): `claimExecution` before dispatch, `ACTIVE_EXECUTION_LIMIT` in `graph/types.ts`, reconcile before replacement on timeouts. The limit is 1 under `IN_FLIGHT_LIMIT` 4 (owner decision 2026-11-17: one worker for AR9, raised after it; a one-line change). Remaining: deliberate backpressure is verified with fakes only. |
| AR7 | Delivered and deployed (migration 0014): `/hub` Unresolved region, stored outcome and per-entry retry, derived rows that move on reassignment. Not verified live: a real capture routed by DeepSeek or recovered after a provider failure. |
| AR8 | AR8a is done (#120): build before production migration, a pinned workflow-shape test, incompatible-schema rules in merge-rules, `pnpm restore-rehearsal` and [release-recovery.md](runbooks/release-recovery.md). AR8b failure alerts are merged (#130): SNS topic, alarms, metric filter and deploy failure steps ([alerts runbook](runbooks/alerts.md)); the owner's email subscription and one controlled test are open (see Owner steps). The AR8a follow-up is merged and deployed (#144, migration 0023): the sweeper part `releases` records merged, deployed and verified per merge commit and the console shows them; its live check needs a real orchestrator merge and belongs to AR9. Not verified live: a restore rehearsal against a real restored branch, a manual prior-build apply (the runbook's Neon steps say "verify at execution time"), and email delivery of an alert. |
| AR9 | Demonstrate one representative dependent task through implementation, CI, independent head-bound QA, merge, deploy and verification, with restart/duplicate/failure recovery. Define the acceptance task, cost allowance and live steps before running; use offline fault tests wherever external behavior is not the question. Depends on AR1-AR8. Record elapsed time, usage, human interventions and unresolved gaps. |

Done and removed from the table: AR1 (#106-#109, live since the owner's bootstrap applies of 2026-11-14; the trusted `prod-plan` job has verified every PR since #110), AR2 (#110, #112, #113, #127), AR3 (#136) and AR4 (#140: validated prerequisites, sequential by default, merge commits recorded, child starts through the outbox, a blocked parent parked for the owner; migration 0020 applied by its deploy). Their live checks are under "Not verified live". AR4 is verified with PGlite and fakes only: SQS delivery of a child start, a real planner order and GitHub merges by the orchestrator are not verified live.

Migrations on main: 0020, 0021, 0022 and 0023 are applied on prod by their deploys (0021 landed after 0023; the runner applies any unrecorded file); 0015 and 0017 are not on main.

Unsettled implementation choices: worker/WIP/time limits (when to raise the active-worker limit after AR9), alert recovery targets, the exact paid/live acceptance scope, and whether `kcw-gh-plan` keeps its `pull_request` trust (it now serves only the advisory `ci.yml` plan) before agents are enabled. The accepted priority and lifecycle defaults do not approve those privileged steps.

## Review candidates (2026-11-13, owner decision)

| ID | Open point |
|---|---|
| R1 | Kept for later (owner 2026-11-14). Public copy overstates what is delivered. The home page says every change is made by the agents and that the office shows the work "as it happens", but agents are paused and most recent changes were owner-run sessions. It lists "Three hundred classic and modern essays, with a reader and recommendations" (8 full texts, the rest links). Its "Simulated data" frame also shows real agent rows. Revisit with AR9, which decides how much of the first claim becomes true. |

## Essays (Phase 5)

| ID | Open work |
|---|---|
| E5 | Further sources: Wikisource access path (its API path is robots-disallowed), source health recovery, schedules. |
| E6 | Per-site extractors with public-domain fixtures; keep paywall and login boundaries and the link-only fallback. With the first non-Gutenberg extractor, add the navigation/ad-text and language checks of SPEC item 4. |
| E10 | Nightly source health and weekly quality report; open a GitHub issue for quarantined essays once the Scraper-builder runs. Deferred (2026-11-16): the essays spec lists these as agent duties, not under "Done means (MVP)", and the only source is ingested by a manual run. Take it up with E5 or when the Scraper-builder runs. |

## Hub MVP (Phase 3)

| ID | Open work |
|---|---|
| H8, H9 | The daily YouTube and Instagram job is built (#131), and the `/social` add form marks an account for it (ingest `api`, one account per platform). Open: owner step 2, then the first live run (see "Not verified live"). |
| H10 | TikTok sandbox stats spike and refresh-token rotation, optional later. The manual-entry fallback is done (`/social`, ingest `manual`); no code is planned. |
| H12 | Unified owner inbox and web push. The inbox shows every region (routing, contact matches, calendar suggestions) and web push is built (W2-6, #135). Open: the owner steps below (VAPID keys, the iPhone Home Screen check). |

## Office and X-ray (Phase 4)

| ID | Open work |
|---|---|
| X3 | Execution-observation rollout per the owner sign-off in [HANDOFF.md](HANDOFF.md) (controlled signed-run check first). Contract: [LIVE-CONTRACT.md](office/LIVE-CONTRACT.md). |

## Decisions made in the sprints (2026-11-15 and wave 2)

- Bounded model calls outside the agents use DeepSeek. Mood scoring uses the web server's router secret (`KCW_MODELS_SECRET` names `kcw/prod/router` in prod) and is recorded as agent `router`, purpose `mood`. Essay categorize and hooks use the pipeline's models secret and are recorded as agent `pipeline` (AR3).
- Unknown-price policy: soft and visible. A model call without a price, or with usage unknown, adds $0 to the monthly cap total; it is counted apart on `/console/usage` and in the sweep's spend log lines. No cap value or enforcement changed. The essay pipeline does not check the spend cap.
- Derived rows move on reassignment, and moving to an agent request discards edits to the derived body. A same-kind save is a no-op.
- A link-only essay passes acceptance with a title and author; the missing source URL is counted, and zero approved seeds fails.
- TikTok is manual entry for the MVP.
- Alerts: failures publish to SNS topic `kcw-prod-alerts`. The owner subscribes an email address in the console; no subscription is in Terraform.
- Social snapshots: one per UTC day, a rerun replaces that day, no backfill. Instagram stores exact followers with views null. YouTube followers are approximate (rounded by YouTube) and views are the channel's cumulative count.
- Web push sends one generic notification (`N new items in your inbox`) that never carries item text.
- Calendar: the suggestion step is bounded to 6 s and Google calls have an 8 s timeout. A suggestion is added with the suggestion's id as the event id, so a repeated tap is safe.
- Google: `yt-analytics.readonly` is not requested. The refresh token lives only in `kcw/prod/google-owner-token`.
- Mood scoring strips one code fence and is otherwise strict.
- No new dependencies were added; charts are hand-written SVG.
- The X-ray overlay uses no accent colour and keeps its state per browser tab.
- Ordered children (AR4): each merged task records its own merge commit (`tasks.merge_sha`), nothing pins the dispatch base, and the consumer's issue footer lists its prerequisites' merge commits. A released child starts when the sweeper's outbox part sends its start row (within one sweep interval). A failed or cancelled child that blocks others parks the parent for the owner, and either decision fails the parent and cancels the blocked children.
- Task contracts (AR5a): planning needs GitHub read access (the `main` head and one file) before the first model call. A work task planned before contracts existed fails at its Developer or QA dispatch instead of going to the owner. The worker renders the contract goal as markdown, so the orchestrator's sanitizer is the only guard on that text. QA of a Docs-keeper PR takes no contract (decided by the PR author id).
- Deploy state (AR8a): a verified release row is final; a failing annotation read leaves `build_id` null; no failure is recorded when the compare budget ran out; the console shows "Release state is unavailable right now." on a failing read.
- Dependency: `next` and `@next/eslint-plugin-next` are 16.4.5 (advisory GHSA-mfr8-8qww-v76h, moderate; the app does not use the affected API).
- Open risk: the spend cap stays soft; unpriced and usage-unknown rows add $0 to the total until prices are entered and live provider usage is checked (AR3).

## Owner steps (open)

1. Alerts: subscribe an email address to SNS topic `kcw-prod-alerts` in the console, confirm it, then run one controlled test ([alerts runbook](runbooks/alerts.md), section 2). Until then alarms publish to a topic with no subscriber.
2. Google: connect Google at `/connections` (Calendar and YouTube). Paste the Instagram token into the Instagram secret. Then add one YouTube and one Instagram account on `/social` with "Numbers from" set to "Daily job (API)". An account that was already added as manual must be deleted and added again, because the choice cannot be changed afterwards.
3. Consent screens (H1 console step): enter `https://kentcrosswise.com/terms` and `https://kentcrosswise.com/privacy` in the Google Cloud OAuth consent screen, the Meta for Developers app settings (Instagram) and the TikTok for Developers app.
4. Web push: approve the Liaison running `pnpm exec tsx scripts/vapid-keys.ts --secret kcw/prod/web` (a gated secret write; it refuses to overwrite keys without `--rotate`). Then on an iPhone (iOS 16.4+) add the site to the Home Screen, open it from there, sign in, enable notifications on `/notifications` and send a test.

## Runtime cases not yet exercised

Use these cases in AR9's acceptance matrix; each live case needs its own scoped, owner-approved run. Source/offline tests do not close an external-runtime verification gap.

- Agents: cold-container restart, bounded retry and failure recovery, active-agent cancellation, late or duplicate reports, conflict escalation, Scraper execution, no-op Docs completion.
- Webhooks: retry of a real failed delivery and dedupe.
- Spend: missing-cost injection and late or duplicate usage reports (A11).
- Protected paths: owner approval and rejection through the inbox (A6).
- Browsers: Safari, Firefox and physical phones (canvas, touch, reduced motion, playback).
- Runtime adapters: native instruction loading in each supported local and cloud runtime (A13).
- `docs/runbooks/oidc-debug.yml` predates per-agent publishing; repair or delete it before reuse (A14).

## Not verified live

These are source or CI facts only until a scoped live check records a result.

- A scheduled job run in prod (`social-daily`, `inbox-push`): the owner's AWS session had expired, so alarm states and job logs were not read.
- AR3 call records against live providers (migration 0019 is applied on prod): a record written by a real call, returned model ids and usage fields on error responses.
- A live DeepSeek route of a real capture, a live mood score, and a live calendar extraction (Google event-id character set included).
- A real Google Calendar insert and a real Google token refresh.
- YouTube and Instagram API calls (no account connected yet). Instagram `/me`, API version `v23.0` and token lifetime are unverified until the first live run.
- A real web push and email delivery of an alert.
- An outbox delivery and a live AR2 effect reconciliation (agents paused).
- Live acceptance of the AR2 slice 3 identities after workflows are enabled.
- QA on Anthropic federation (not run since #88).
- AR4: SQS delivery of a child start, a real planner order and GitHub merges by the orchestrator.
- AR5a: a real Developer or QA dispatch with a contract (the 422 for a missing required input, the `compare` containment call, the artifact round trip), a real Docs-keeper QA run without one, and a planner run against a real repository brief.
- AR8a: that `::notice` annotations are returned by `GET /check-runs/{job_id}/annotations` with the installation token, the job step and run list fields as the sweeper reads them, the compare `status` values, and that the job id equals the check-run id; and the first `releases` rows from a real orchestrator merge.
- AR5b: a replan with a real planner call, attempt rows from real workflow runs, and the per-attempt cost query (the canary token comparison belongs to AR9).
- AR6: the console capacity line against live data, a real reservation refusal and retry, and GitHub run cancellation timing before a replacement.

## Vendor and account facts to verify at execution time

- U4 LangGraph checkpoint behaviour across cold starts and LangSmith flush.
- U5 Fork-PR id-token behaviour (keep same-repo CI guards).
- U7 Neon project-scoped keys and URL masking.
- U9 Google consent screen and refresh-token longevity after incremental consent.
- U10 Instagram development mode without App Review; TikTok sandbox stats.
- U12 Current AWS pricing and free-tier state.

## Later (Phase 6, not blockers)

- Migrate owner administration to IAM Identity Center when the Free Tier credits run out (A15).
- Owner-driven continuous console work; capture-to-task approval flow.
- Embedding recommendations, EPUB/PDF import, Apple Shortcut capture, Gmail/Voice bridge, native app.
- Periodic dependency and security updates; consider making ruleset-drift CI blocking (A4).
