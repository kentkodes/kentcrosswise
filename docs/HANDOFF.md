# Kentcrosswise project handoff

Current state only. Earlier chronology is in Git history (this file before 2026-11-16). The open backlog is [OPEN-POINTS.md](OPEN-POINTS.md); the resume procedure is [CONTINUITY.md](agents/CONTINUITY.md). A handoff reports facts and earlier approvals; it never grants permission.

## Observation and provenance

- Observed 2026-11-16 UTC from fetched `origin/main` at `268fcf9` (PR #136), the deploy workflow runs and the public site. The production database and AWS were not re-read; values marked "last recorded" come from the session named with them.
- Sprint 2026-11-15 (wave 2): the owner pre-approved the Liaison's default design decisions and merging reviewed PRs on green, including their gated content (migrations, `.github/**`, `infra/**`, SPEC-relevant behaviour). This is an earlier approval, not a standing one; privileged live steps still need the owner's confirmation per step.

## Repository and refs

- Default branch `main` at `268fcf9`. Protection: ruleset 25683184, profile `final` (one approval, `ci/required` and `kcw/merge-rules`, squash, no bypass). The owner merges reviewed PRs with passing CI through the pinned merge script, which restores and verifies final protection after each merge.
- The sprint's parallel PRs did not edit the shared docs. The wave 2 docs PR brought this file, [OPEN-POINTS.md](OPEN-POINTS.md), [DESIGN.md](DESIGN.md), the hub spec, [PRODUCT.md](../PRODUCT.md), the reliability plan's status lines and the agent instructions up to date with #123-#136.

## PRs and checks

- 2026-11-10 to 2026-11-12: #59-#96 (Paper home, `/office` and its Room tab, `/demo` app frame, reading layout, owner console in Dense UI, CloudFront invalidation and build-id smoke check, QA on Claude Haiku 5.5, Gutenberg extractor v2, 2-decimal usage costs).
- 2026-11-13 to 2026-11-14: `/essays` library (#98), H2 capture box (#99), planner stop reasons (#100), E3 recommendations (#101), H3 routing (#102), essay validator v2 (#103), reliability direction and AR1/AR2 slices (#105-#113, migrations 0011 and 0012).
- 2026-11-15, sprint: #114-#122 (`/terms` and `/privacy`, contacts, capture recovery and derived rows, essay hooks phase and acceptance report, social dashboard, release recovery, X-ray overlay, diary and mood, todos, ideas and projects; migrations 0014 and 0016).
- 2026-11-15 to 2026-11-16, wave 2, in merge order: #123 scheduled web jobs; #124 Google connection; #126 hook reject reasons and one retry; #127 AR2 slice 3 (migration 0013); #128 hub integration; #129 migration 0018; #130 failure alerts (AR8b); #131 `social-daily` job; #132 hook stop reasons; #133 `/demo` Essays tab; #134 calendar suggestions; #135 web push and owner nav entries; #136 AR3 accounting (migration 0019). Migration numbers 0015 and 0017 are not on main.

## Ownership and changes

- Public pages: `/` (Paper home), `/demo` (simulated hub in an app frame; tabs Today, People, Mood, Following, Notes and Essays), `/office`, `/bot`, `/terms` and `/privacy`. A header toggle turns on the X-ray overlay. `/terms` and `/privacy` state only what the code does; `/privacy` names the third-party services in use, so update it and its "Last updated" date when an integration ships or tracking is added.
- Owner pages (Google sign-in, allowlisted owner). The owner nav has 14 entries in this order: Hub, Inbox, Contacts, Diary, Mood, Todos, Ideas, Social, Projects, Essays, Boss console, Usage, Connections, Notifications. Sub-pages keep their section marked. Reached by URL only: `/contacts/new`, `/contacts/[id]`, `/diary/[id]`, `/essays/setup` and `/essays/<id>`.
- Capture and derived records: a routed capture creates one derived row (CRM note, diary entry, todo or idea) in the route transaction (`applyRoute` in `apps/web/src/server/derived.ts`). Reassignment moves the current body; moving to an agent request discards it; a same-kind save is a no-op.
- Contact linking: a routed CRM note is matched to a contact by name inside the route transaction (`applyRouteLinked` in `router.ts`, `linkCrmNote` in `contacts.ts`). One match links it; several show "Choose a contact" and a `contact_match` item on `/inbox`; none leaves it unlinked. A failed link keeps the route.
- Mood scoring: a diary row created by a route is scored after the transaction commits, bounded to 6 s (`scoreCreated`). A timeout or failure leaves "Not scored" with "Score again" on the diary page. Where `KCW_MODELS_SECRET` is unset (preview, local) the page says "Mood scoring is not set up here". In prod it names the router secret `kcw/prod/router`.
- Calendar: after a route creates a CRM note, one bounded model call may suggest a dated plan (`suggestFromNote` in `calendar.ts`, 6 s bound; also after owner reassignment). The `/inbox` calendar region offers one-tap add to Google Calendar or dismiss; without a Google connection it links to `/connections`.
- Google: `/connections` connects Calendar events and read-only YouTube with a refresh token in `kcw/prod/google-owner-token`, and disconnects (revoke at Google).
- Social: `/social` has manual entries (ingest `manual`). The `social-daily` job writes one daily YouTube and Instagram snapshot per UTC day for the accounts with ingest `api`. No such account exists yet, and `/social` cannot create one (its add form always stores `manual`), so the job reads nothing until that fix lands (OPEN-POINTS H8, H9).
- Web push: the `inbox-push` job runs every 15 minutes and sends one generic notification to each subscribed device when open inbox items have not been announced. It returns `off` until the VAPID keys exist. `/notifications` enables, disables and tests a device.
- Scheduled web jobs: EventBridge Scheduler invokes the server function with `kcw_job`; the origin wrapper routes it to the fixed registry (`social-daily` at 06:15 UTC, `inbox-push` every 15 minutes).
- Release: `deploy.yml` builds before the production migration, and two `if: failure()` steps publish to the alerts topic. Failure alarms: `kcw-prod-alerts` (SNS, no subscriber until the owner subscribes), four CloudWatch alarms and one metric filter ([alerts runbook](runbooks/alerts.md)).
- Agents: planner on Claude Opus 5.5 at high effort; Developer, Scraper-builder and Docs-keeper on DeepSeek Flash; QA on Claude Haiku 5.5 through Anthropic workload identity federation.
- Accounting (AR3): every in-process model call (planner, hub router, mood, calendar suggestion, essay categorize and hooks) writes call records to `usage_events`: `started` before the request, then `reported`, `unknown` (sent, no usage: tokens NULL) or `rejected` (4xx: $0). Planner rows come from `trackPlannerCalls` in the orchestrator Lambda. Agent `router` rows carry purpose `route`, `mood` or `calendar`, and `pipeline` rows carry purpose and subject. `/console/usage` shows unpriced and usage-unknown counts next to every total. The monthly $50 control stays soft: those rows add $0 to the cap total.
- Essays: 300 approved seeds; 8 full Gutenberg texts in the private bucket; the rest are link-only rows. All 8 stored essays have a hook (`essays.hook`). Validator v2 (E7): `essays.text_hash` is the sha256 of the normalized text, and the store phase quarantines near duplicates.

## Verification

- 2026-11-16: the deploy runs for every merge up to `268fcf9` (#136) succeeded, each with the build-id smoke check. The #136 deploy applied migration `0019_usage_accounting` on prod. Afterwards the live `/`, `/office`, `/demo`, `/bot`, `/healthz`, `/sw.js` and `/manifest.webmanifest` returned 200, and `/hub`, `/inbox` and `/notifications` redirected to sign-in.
- 2026-11-16: `KCW_AGENT_WORKFLOWS_ENABLED = false` and profile `final` (the merge script checks the flag and restores and verifies the profile at every merge).
- Essay hooks: all 8 stored essays have a hook (essay-ingest runs 43741611142 and 43771188924). Acceptance run 43743007872 on `9ecc11c` passed: 300 approved seeds, 8 full, 292 link-only, 0 quarantined.
- 2026-11-12 (last recorded; the production database was not re-read): `agents_paused = true`.
- Not verified live: the list in [OPEN-POINTS.md](OPEN-POINTS.md) ("Not verified live"). In short: a scheduled job run in prod, AR3 call records against live providers, a live DeepSeek route, mood score or calendar extraction, a real Google Calendar insert, YouTube and Instagram API calls, a real web push, email delivery of an alert, an outbox delivery, QA on Anthropic federation, and a restore rehearsal against a real restored branch.
- Also not verified: Safari, Firefox and physical phones, and the cases under "Runtime cases not yet exercised" in [OPEN-POINTS.md](OPEN-POINTS.md).

## Decisions and security holds

- Sprint decisions are listed in [OPEN-POINTS.md](OPEN-POINTS.md).
- Owner direction in the 2026-11-14 adversarial-review conversation: autonomous development is the main success criterion; the personal hub demonstrates the workflow. Adopt disposable workers and complete reliability work before expansion. The owner then accepted the default that retries retain task identity with separate attempts, replanning explicitly supersedes affected work and revalidates results/QA, and capture reclassification moves derived content while preserving the original capture and edits. This authorizes the direction documents; implementation and privileged live actions remain separate. DESIGN section 4.0 is the canonical target, not a claim of delivered behavior.
- The owner next requested in-session GitHub access first, otherwise continued preparation for a Claude execution/CI handoff. This preparation supplies proposed implementation slices and tests; it grants no missing live approval or privileged workflow/IAM change. Numeric rollout settings in the execution plan are recommendations, not accepted changes to limits.
- Agents stay paused and agent workflows stay disabled until the owner enables them. Each live step (enable flag, prod migrations or grants, workflow files, IAM or secrets, paid runs beyond cents) needs the owner's confirmation for that step.
- Execution observations stay off. They are enabled with migrator SQL only after one controlled run confirms a signed `workflow_run` reaches `agent_runs`, including the sender-allowlist check (owner sign-off 2026-10-26).
- Public office: task identifiers stay internal, no task links; private tasks display only "Private task"; replay keeps original timestamps.
- Owner-critical paths are listed in [INSTRUCTIONS.md](agents/INSTRUCTIONS.md) rule 10.

## Remaining work and next action

1. AR1 is done and live (#106-#109; the owner applied the bootstrap changes on 2026-11-14, and the trusted `prod-plan` job has verified every PR since #110). AR2 (#110, #112, #113, #127) and AR3 (#136) are merged; their live checks are in "Not verified live". Next: AR4-AR6 and AR9 per [RELIABILITY-PLAN.md](RELIABILITY-PLAN.md), plus the AR8a deploy-state follow-up.
2. Owner steps (listed in OPEN-POINTS): alert email subscription and controlled test, connecting Google and the Instagram token, the consent-screen links, and the VAPID keys with the iPhone check. Liaison-side: a restore rehearsal, and a first live run of `social-daily` and `inbox-push` once the owner has connected the accounts.
3. Decisions still needed: worker/WIP/time limits (AR6), alert recovery targets, the scoped live acceptance task (AR9), and whether `kcw-gh-plan` keeps its `pull_request` trust for the advisory plan before agents are enabled. No new budget or live enablement was approved.
