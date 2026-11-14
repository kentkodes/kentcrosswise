# Kentcrosswise project handoff

Current state only. Earlier chronology is in Git history (this file before 2026-11-13). The open backlog is [OPEN-POINTS.md](OPEN-POINTS.md); the resume procedure is [CONTINUITY.md](agents/CONTINUITY.md). A handoff reports facts and earlier approvals; it never grants permission.

## Observation and provenance

- Observed 2026-11-14 UTC by the Liaison from fetched `origin/main`, the GitHub PR list, workflow runs and the public site (docs consistency pass after #101-#103). Production database, AWS and repository variables were not re-read; values marked "last recorded" come from the 2026-11-12 session.
- Reliability-direction docs, 2026-11-14: prepared offline on the #104 PR head (`dc2a9f0`, tree-identical to main `2fa8102`), then fetched and rebased onto `origin/main` `2fa81024150dec6b5f6b20b1d36222e4ce1ba4ca` (#104) as branch `docs/reliability-direction-20261114`. Production state and protection were not re-read.

## Repository and refs

- Default branch `main` at `2fa81024150dec6b5f6b20b1d36222e4ce1ba4ca` (PR #104, merged 2026-11-14).
- Protection: ruleset 25683184, profile `final` (one approval, `ci/required` and `kcw/merge-rules`, squash, no bypass). The owner merges reviewed PRs with passing CI through the pinned merge script, which restores and verifies final protection after each merge. This is the normal workflow.

## PRs and checks

- Merged 2026-11-10 to 2026-11-12: #59-#96. Highlights: Paper home (#79), `/office` team board (#80) and Room tab (#90, #91), `/demo` app frame (#84), reading layout for the essay reader and `/bot` (#86), owner console in Dense UI (#93), deploy-time CloudFront invalidation and build-id smoke check (#81), QA on Claude Haiku 5.5 (#88), Gutenberg extractor v2 and in-place re-extraction (#92, #94), 2-decimal usage costs (#95), local e2e PGlite harness fix (#96).
- 2026-11-13: `/essays` library for ~300 entries (#98) and the H2 capture box on `/hub` (#99: raw entries in `entries`, latest 10 with routing status, "Waiting for router" until H3).
- 2026-11-14: planner handles truncated and refused replies with an 8000-token limit (#100, R2). E3 recommendations (#101): ratings of every kind shape the list (likes pull, 1–2 star ratings push, what-worked tags, last length answer), link-only essays are recommended and rateable at `/essays/<id>`, and each recommended card names the liked essay it follows. H3 routing (#102): DeepSeek classifies each capture into the five kinds; confidence below 0.6 marks it "Needs you" with a routing inbox item; `/hub` rows have a route picker and owner changes store a correction; router calls are usage events; nothing downstream is created yet. The web server now reads `kcw/prod/models` (applied by the #102 deploy). Validator v2 (#103, E7), below under Essays.
- Every deploy since #81 cleared the CloudFront cache and passed the build-id smoke check on `/`, `/demo`, `/office`, `/bot` and the `/hub` redirect; the #102 and #103 deploys did too.

## Ownership and changes

- The reliability-direction docs PR changes PRODUCT, agent DESIGN (section 4.0), hub SPEC, OPEN-POINTS (AR1-AR9) and this handoff, and adds the on-demand [RELIABILITY-PLAN.md](RELIABILITY-PLAN.md). No design change to runtime: code, schemas, IAM, workflows, credentials and live systems are unchanged.
- Public pages: `/` (Paper home), `/demo` (simulated hub in an app frame), `/office` (Board and Room tabs over the sanitized public feed), `/bot`.
- Owner pages (Google sign-in, allowlisted owner): `/hub`, `/console`, `/console/usage`, `/inbox`, `/essays`, `/essays/setup`, `/essays/<id>` reader.
- Agents: Orchestrator planner on Claude Opus 5.5 at high effort; Developer, Scraper-builder and Docs-keeper on DeepSeek Flash through DeepSeek's Anthropic-compatible endpoint; QA work and review on Claude Haiku 5.5 through Anthropic workload identity federation. Monthly model-spend control $50 (#69), soft because usage is delayed/incomplete and unpriced rows do not count toward enforcement today. The categorizer accounting gap remains open under AR3.
- Essays: 300 approved seeds; 8 full Gutenberg texts in the private bucket (extractor v2, `sources.extractor_version = '2'` after the 2026-11-12 re-extraction run); the remaining approved seeds are link-only rows. Validator v2 (E7): `essays.text_hash` is now the sha256 of the normalized text (the S3 key stays the raw-text hash), `essays.minhash` holds a 128-slot MinHash; the store phase quarantines near duplicates (MinHash >= 0.9) and same-author titles at similarity >= 0.9, and upgrades a seed's link-only row in place when its full text arrives. The 8 stored rows were backfilled on 2026-11-14 (essay-ingest run 43613965538, `reextract`: all 8 `reextracted`, word counts unchanged).

## Verification

- 2026-11-14 reliability-direction docs: `node scripts/check-agent-docs.mjs` and `git diff --check` pass. Independent documentation and security/lifecycle reviews were reconciled; the execution plan was checked against source and primary AWS/GitHub references. It is a plan, not an implemented or live-verified fix. The full test suite and live verification were not run.
- 2026-11-14: after the #103 deploy, `/`, `/office`, `/demo`, `/bot` and `/healthz` return 200. Not verified: a live DeepSeek route of a real capture (owner prod capture test pending).
- 2026-11-13: live `/`, `/demo`, `/office` and `/bot` render. `/office` shows the Paused badge and a replay of the latest recorded events (last activity 2026-11-11).
- Last recorded (2026-11-12): `agents_paused = true`, `KCW_AGENT_WORKFLOWS_ENABLED = false`, profile `final`. The owner checked the essay reader, `/console` and `/essays` signed in.
- 2026-11-11 canary (task 4, one-line docs change): planner on Opus 5.5 (2 calls, 654 input / 798 output tokens), Developer and QA on DeepSeek, before QA moved to Haiku in #88 (about 1.1M input / 11K output tokens), merged as #76 and deployed.
- Not verified: a planner run on a larger task; the orchestrator's external-close path from #78 against a real task; Safari, Firefox and physical phones; the cases listed under "Runtime cases not yet exercised" in [OPEN-POINTS.md](OPEN-POINTS.md).

## Decisions and security holds

- Owner direction in the 2026-11-14 adversarial-review conversation: autonomous development is the main success criterion; the personal hub demonstrates the workflow. Adopt disposable workers and complete reliability work before expansion. The owner then accepted the default that retries retain task identity with separate attempts, replanning explicitly supersedes affected work and revalidates results/QA, and capture reclassification moves derived content while preserving the original capture and edits. This authorizes the direction documents; implementation and privileged live actions remain separate. DESIGN section 4.0 is the canonical target, not a claim of delivered behavior.
- The owner next requested in-session GitHub access first, otherwise continued preparation for a Claude execution/CI handoff. This preparation supplies proposed implementation slices and tests; it grants no missing live approval or privileged workflow/IAM change. Numeric rollout settings in the execution plan are recommendations, not accepted changes to limits.
- Agents stay paused and agent workflows stay disabled until the owner enables them. Each live step (enable flag, prod migrations or grants, workflow files, IAM or secrets, paid runs beyond cents) needs the owner's confirmation for that step.
- Execution observations stay off. They are enabled with migrator SQL only after one controlled run confirms a signed `workflow_run` reaches `agent_runs`, including the sender-allowlist check (owner sign-off 2026-10-26).
- Public office: task identifiers stay internal, no task links; private tasks display only "Private task"; replay keeps original timestamps.
- Owner-critical paths are listed in [INSTRUCTIONS.md](agents/INSTRUCTIONS.md) rule 10.

## Remaining work and next action

1. AR1 slice 1 (authority and secret split) is in #106: owner-gated bootstrap plan/apply, two new secret values, then CI and merge. Next: AR1 slices 2-3 per [RELIABILITY-PLAN.md](RELIABILITY-PLAN.md), then the remaining AR1-AR9 sequence. Existing H3 production capture and essay acceptance checks remain pending, not the next expansion step.
2. Implementation decisions still needed: preview isolation technique, unknown-price policy, worker/WIP/time limits, alert destination/recovery targets and the scoped live acceptance task. No new budget or live enablement was approved. Public copy overclaims remain deferred under R1; worker context cost is now AR5 (former R3).
