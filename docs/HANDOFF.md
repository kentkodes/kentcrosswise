# Kentcrosswise project handoff

Current state only. Earlier chronology is in Git history (this file before 2026-11-13). The open backlog is [OPEN-POINTS.md](OPEN-POINTS.md); the resume procedure is [CONTINUITY.md](agents/CONTINUITY.md). A handoff reports facts and earlier approvals; it never grants permission.

## Observation and provenance

- Observed 2026-11-13 UTC by the Liaison from fetched `origin/main`, the GitHub PR list and the public site. Production database, AWS and repository variables were not re-read for this update; values marked "last recorded" come from the 2026-11-12 session.

## Repository and refs

- Default branch `main` at `3471d533993e380bcb21f1c55d691a1744b7e8ff` (PR #96, merged 2026-11-12).
- Protection: ruleset 25683184, profile `final` (one approval, `ci/required` and `kcw/merge-rules`, squash, no bypass). The owner merges reviewed PRs with passing CI through the pinned merge script, which restores and verifies final protection after each merge. This is the normal workflow.

## PRs and checks

- Merged 2026-11-10 to 2026-11-12: #59-#96. Highlights: Paper home (#79), `/office` team board (#80) and Room tab (#90, #91), `/demo` app frame (#84), reading layout for the essay reader and `/bot` (#86), owner console in Dense UI (#93), deploy-time CloudFront invalidation and build-id smoke check (#81), QA on Claude Haiku 5.5 (#88), Gutenberg extractor v2 and in-place re-extraction (#92, #94), 2-decimal usage costs (#95), local e2e PGlite harness fix (#96).
- 2026-11-13: `/essays` library for ~300 entries (#98) and the H2 capture box on `/hub` (#99: raw entries in `entries`, latest 10 with routing status, "Waiting for router" until H3).
- 2026-11-14: E3 recommendations (this PR): ratings of every kind shape the list (likes pull, 1–2 star ratings push, what-worked tags, last length answer), link-only essays are recommended and rateable at `/essays/<id>`, and each recommended card names the liked essay it follows. Not yet merged or deployed.
- Every deploy since #81 cleared the CloudFront cache and passed the build-id smoke check on `/`, `/demo`, `/office`, `/bot` and the `/hub` redirect.

## Ownership and changes

- Public pages: `/` (Paper home), `/demo` (simulated hub in an app frame), `/office` (Board and Room tabs over the sanitized public feed), `/bot`.
- Owner pages (Google sign-in, allowlisted owner): `/hub`, `/console`, `/console/usage`, `/inbox`, `/essays`, `/essays/setup`, `/essays/<id>` reader.
- Agents: Orchestrator planner on Claude Opus 5.5 at high effort; Developer, Scraper-builder and Docs-keeper on DeepSeek Flash through DeepSeek's Anthropic-compatible endpoint; QA work and review on Claude Haiku 5.5 through Anthropic workload identity federation. Monthly model spend cap $50 (#69).
- Essays: 300 approved seeds; 8 full Gutenberg texts in the private bucket (extractor v2, `sources.extractor_version = '2'` after the 2026-11-12 re-extraction run); the remaining approved seeds are link-only rows.

## Verification

- 2026-11-13: live `/`, `/demo`, `/office` and `/bot` render. `/office` shows the Paused badge and a replay of the latest recorded events (last activity 2026-11-11).
- Last recorded (2026-11-12): `agents_paused = true`, `KCW_AGENT_WORKFLOWS_ENABLED = false`, profile `final`. The owner checked the essay reader, `/console` and `/essays` signed in.
- 2026-11-11 canary (task 4, one-line docs change): planner on Opus 5.5 (2 calls, 654 input / 798 output tokens), Developer and QA on DeepSeek, before QA moved to Haiku in #88 (about 1.1M input / 11K output tokens), merged as #76 and deployed.
- Not verified: a planner run on a larger task; the orchestrator's external-close path from #78 against a real task; Safari, Firefox and physical phones; the cases listed under "Runtime cases not yet exercised" in [OPEN-POINTS.md](OPEN-POINTS.md).

## Decisions and security holds

- Agents stay paused and agent workflows stay disabled until the owner enables them. Each live step (enable flag, prod migrations or grants, workflow files, IAM or secrets, paid runs beyond cents) needs the owner's confirmation for that step.
- Execution observations stay off. They are enabled with migrator SQL only after one controlled run confirms a signed `workflow_run` reaches `agent_runs`, including the sender-allowlist check (owner sign-off 2026-10-26).
- Public office: task identifiers stay internal, no task links; private tasks display only "Private task"; replay keeps original timestamps.
- Owner-critical paths are listed in [INSTRUCTIONS.md](agents/INSTRUCTIONS.md) rule 10.

## Remaining work and next action

1. Next MVP area in the accepted order: H3 routing (DeepSeek routing, low-confidence inbox, corrections), then the remaining hub, social and inbox items in [OPEN-POINTS.md](OPEN-POINTS.md).
2. Owner decisions pending from the 2026-11-13 review: public copy that overstates delivered features, and worker context cost (see OPEN-POINTS R1 and R3).
