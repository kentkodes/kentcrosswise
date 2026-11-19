# Kentcrosswise project handoff

Current state only; earlier chronology is in Git history. The open backlog is [OPEN-POINTS.md](OPEN-POINTS.md); the resume procedure is [CONTINUITY.md](agents/CONTINUITY.md). A handoff reports facts and earlier approvals; it never grants permission.

## Observation and provenance

- Observed 2026-11-17 UTC from merged source after #161 and #162. The #161 deploy run, the public pages and the bootstrap apply were read the same day; the production database was not read.

## Repository and refs

- Default branch `main`. Protection: ruleset 25683184, profile `final` (one approval, `ci/required` and `kcw/merge-rules`, squash, no bypass). The owner, or the Liaison with the owner's merge OK, merges through the pinned merge script, which requires agent workflows off, verifies the trusted preview and restores final protection.
- Migrations on main through `0027_public_records`, all applied on prod by their deploys; 0015 and 0017 are not on main.

## PRs and checks

- Through #136 (2026-11-16): public site, hub, essays, office, X-ray, legal pages, web jobs, Google Calendar, web push, alerts, AR1-AR3.
- #137-#153: `/privacy` integrations and Limited Use, AR4 ordered children (0020), AR6 owner status (0022), AR5a contracts, AR8a release state (0023), AR5b revisions and attempts (0021), AR6 reservations and the limit of one, `kcw-gh-plan` trusted-path only, docs waves 3 and 4.
- #154-#158: AR9's first live run (#155 owner nav and #156 docs merged by the orchestrator; #158 hub list merged by hand).
- #159-#165: the personal-helper direction (DESIGN 4.6), the social removal (#161, migration 0024), the AR9 results, a docs cleanup (#163), the PH4 and PH7 decisions (#164) and PL1, the record redactor and span-proposal call (#165). Then PL2, router step rows in `agent_events` (migration 0025), PL3, the review on `/hub` (migration 0026), and PL4, publication and the public log API (migration 0027).

## Ownership and changes

- Product: the owner's personal helper (capture, router, CRM, diary and mood, todos, ideas, essays, inbox, boss console). The autonomous development system builds and maintains the site. Specs: [hub SPEC](hub/SPEC.md), [essays SPEC](essays/SPEC.md); design: [DESIGN.md](DESIGN.md).
- Public pages: `/` (Paper home), `/demo` (simulated hub: Today, People, Mood, Notes and Essays tabs), `/office`, `/bot`, `/terms`, `/privacy`; a header toggle turns on the X-ray overlay. `/privacy` (17 November 2026) names the services in use (model services, web push, Google Calendar) and the Limited Use statement; update it and its date when an integration ships.
- Owner pages: Google sign-in, allowlisted owner; one nav row (Hub, Inbox, Todos, Diary, Ideas, Contacts) plus a "More" disclosure (Mood, Projects, Essays, Boss console, Usage, Connections, Notifications).
- Hub behaviour (DESIGN sections 3 and 5): a routed capture creates one derived row in the route transaction; CRM notes link to contacts by name; diary rows are scored after commit (6 s bound); a CRM note may get a calendar suggestion (6 s bound) added from `/inbox`; Google connects Calendar only (`kcw/prod/google-owner-token`).
- Social was removed on 2026-11-17: no `/social` page, `social-daily` job, demo Following tab or YouTube scope; migration 0024 dropped its tables; the Instagram and TikTok secrets are scheduled for deletion (30-day recovery).
- Scheduled web job: `inbox-push` every 15 minutes (one generic notification per device; VAPID keys written 2026-11-17).
- Agents: planner on Claude Opus 5.5 (high); Developer, Scraper-builder and Docs-keeper on DeepSeek Flash; QA on Claude Haiku 5.5 through Anthropic federation. Lifecycle (DESIGN 4.0): contracts sent with every Developer and QA dispatch (AR5a), revisions, attempts and replan on attempts exhausted (AR5b), ordered children through the outbox (AR4), reservations with `ACTIVE_EXECUTION_LIMIT` 1 under `IN_FLIGHT_LIMIT` 4 (AR6), release state per merge commit (AR8a).
- Accounting (AR3): every in-process model call writes `usage_events` call records; the $50 monthly control is soft and unpriced or usage-unknown rows add $0.
- Release: `deploy.yml` builds before the production migration, applies prod Terraform, smoke-checks the build id; failures publish to SNS `kcw-prod-alerts` (email subscription confirmed).
- Essays: 300 approved seeds, 8 full Gutenberg texts with hooks, the rest link-only; recommendations from ratings.

## Verification

- 2026-11-17: #161 deploy 44174477825 succeeded: `0024_drop_social` applied, the `social-daily` schedule destroyed, smoke check passed on attempt 1; `/`, `/demo`, `/office`, `/privacy`, `/healthz` 200, `/hub` 307, `/social` 404. The bootstrap apply destroyed only the two social secrets.
- 2026-11-17: alerts verified end to end (test publish, a test alarm to ALARM and back, three emails). AR9 ran live: planner split, contracts, Developer, CI, trusted preview, head-bound QA, orchestrator merge and deploy (OPEN-POINTS AR9).
- `KCW_AGENT_WORKFLOWS_ENABLED = false` and profile `final` at each merge (the merge script checks both).
- Not verified live: the list in [OPEN-POINTS.md](OPEN-POINTS.md) ("Not verified live").

## Decisions and security holds

- Owner direction 2026-11-17: the personal helper is the product and inspectable engineering evidence is its public proof. `/demo` becomes the public log of the owner's real entries (sanitized, published automatically once the owner has reviewed the route, fail closed, with routing, trace, read-back checks, the owner's verdicts, corrections and recovery); records extend `agent_events`; Essays and `/office` stay; social removed; playground ideas held. Target design: DESIGN section 4.6; built: PL1 (the redactor and the span-proposal call), PL2 (router step rows, private codes and ids only), PL3 (the review on `/hub`: public text, added replacements, Correct, verdict steps) and PL4 (snapshots in `public_records`, the two `web_public` views and `GET /api/public/log`). Order: the public log (PL1-PL7), then the remaining reliability work.
- Owner direction 2026-11-14 (framing superseded above; its lifecycle defaults stand): disposable workers with durable task state; retries keep task identity with separate attempts; replanning supersedes affected work and revalidates QA.
- Agents stay paused and agent workflows disabled until the owner enables them. Each live step (enable flag, prod migrations or grants, workflow files, IAM or secrets, paid runs) needs the owner's confirmation for that step.
- Execution observations stay off until one controlled run confirms a signed `workflow_run` reaches `agent_runs`, including the sender-allowlist check (owner sign-off 2026-10-26).
- Public office: no task identifiers or links; private tasks show only "Private task".
- Owner-critical paths are listed in [INSTRUCTIONS.md](agents/INSTRUCTIONS.md) rule 10.

## Remaining work and next action

1. Decision with the owner before PL7: PH8 (dummy calendar account). PH4 and PH7 are decided (DESIGN sections 4.5 and 4.6).
2. The public log, PL5-PL7 in order (OPEN-POINTS); PL1-PL4 are done, PL5 (the `/demo` log page) is next.
3. Reliability left: the AR9a follow-ups (task 8 to reconcile on resume), the canary token comparison, a schema-plus-consumer live run, raising the active limit, the restore rehearsal, X3.
4. Owner steps: connect Google for Calendar, consent-screen links and Google verification, delete the Meta and TikTok developer apps, the iPhone push check.
