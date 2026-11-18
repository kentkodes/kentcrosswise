# Kentcrosswise open points

Current backlog, 2026-11-17 UTC. Current state and holds are in [HANDOFF.md](HANDOFF.md); done items are removed (Git history has them). Order of work (owner, 2026-11-17): the public log (PL slices), then the remaining reliability work.

## Personal helper and the public log

Design target: [DESIGN.md](DESIGN.md) section 4.6, hub SPEC features 9 and 10, the X-ray README (`packages/xray/README.md`). Decided 2026-11-17: `/demo` becomes the public log (Essays tab kept), `/office` and the essays library unchanged, records extend `agent_events`, sanitized text for every kind with bracketed filler names, timestamps rounded to the hour, no backfill, detailed corrections and recovery, a dummy Google account's calendar. PH4 decided 2026-11-17: read-back checks plus the owner's per-step verdicts, no model judge; a record publishes once the owner has reviewed its route (DESIGN section 4.6). Built: PL1 (#165), `createRecordRedactor` in `@kcw/core/sanitize` and `proposeSpans` in `apps/web/src/server/public-spans.ts`, used by the PL3 review screen. Built: PL2, router step rows in `agent_events` (migration 0025, `apps/web/src/server/steps.ts`), and PL3, the review on `/hub` with the stored span proposal, the owner's added replacements and the verdict steps (migration 0026, `apps/web/src/server/review.ts`; DESIGN section 4.6). PH7 decided 2026-11-17: a bounded model call proposes names, places and another person's private topics; the deterministic sanitizer applies and re-checks; a failed call withholds; the review screen shows the public text and allows added replacements; no keep-private button.

| ID | Open work |
|---|---|
| PH8 | Dummy calendar: the owner creates the dummy Google account; its token needs its own secret (gated); proposed: events are added when a published CRM note has a calendar suggestion, and the log renders stored copies, so no Google call per visitor. |
| PL4 | Public view, `web_public` grant and public API route (owner-critical). |
| PL5 | `/demo` log page with the evidence view, the withheld and awaiting-review counts and the honest label; the home page leads with it and its copy moves to the 2026-11-17 framing (closes R1). |
| PL6 | Read-back checks per DESIGN section 4.6 (versioned check list) and the per-step accuracy aggregates. |
| PL7 | Dummy calendar (after PH8). |

## Autonomous development reliability

Target lifecycle: [DESIGN.md](DESIGN.md) section 4.0; implementation detail in the on-demand [execution plan](RELIABILITY-PLAN.md). AR1-AR4, AR7 and AR8a/b are done (their live gaps are under "Not verified live"). Existing owner gates still apply.

| ID | Open work |
|---|---|
| AR5 | Contracts (AR5a) and revisions, attempts and replan (AR5b) are merged. Left: compare accepted-task usage with the ~1.1M-input-token one-line canary. |
| AR6 | Reservations are merged; `ACTIVE_EXECUTION_LIMIT` is 1 under `IN_FLIGHT_LIMIT` 4 (one-line change in `graph/types.ts`). Left: raise it after the AR9a cost check (owner decision); backpressure is verified with fakes only. |
| AR8 | Left: a restore rehearsal against a real restored branch and a manual prior-build apply ([release-recovery.md](runbooks/release-recovery.md)); the first `releases` rows from an orchestrator merge are not yet read back. |
| AR9 | First live run 2026-11-17 (owner-confirmed steps, active limit 1, $3 allowance, about $2.74 spent). The planner split task 6 "declutter the owner hub" into task 7 (owner nav, #155) and task 8 (hub list, #158). Task 7 ran the whole chain without the owner: contract, Developer, CI, trusted preview, head-bound QA approval, orchestrator merge, deploy, then the Docs task (#156), also merged by the orchestrator. Task 8: QA requested changes for a two-line selector update in `integration.e2e.ts`, outside the contract's file list; the Developer retry hit its 80-turn limit; the owner accepted the deviation and #158 was merged by hand. Owner interventions: issue-text review per subtask (the sanitizer flags HTML tags in task text), the stop at $3, the #158 acceptance. Not exercised: a schema-plus-consumer change, restart and duplicate cases, the per-attempt cost query. |
| AR9a | Follow-ups: (1) a contract should cover the tests that exercise the changed files, or QA should allow selector-only test updates the contract asks for; (2) a contract conflict loops into Developer retries and the turn limit instead of going to the owner; (3) cost per subtask (~$1.40 with Docs) is far above the earlier estimate: record per-role usage before raising the active limit; (4) task 8 is still open in the orchestrator (merge events deferred while paused): reconcile on resume. |
| X3 | Execution-observation rollout per the owner sign-off in [HANDOFF.md](HANDOFF.md) (controlled signed-run check first). Contract: [LIVE-CONTRACT.md](office/LIVE-CONTRACT.md). |

Open risk: the spend cap stays soft; unpriced and usage-unknown rows add $0 to the total until prices are entered and live provider usage is checked.

## Other open work

| ID | Open work |
|---|---|
| R1 | Public copy overstates what is delivered (agents "make every change", the office shows work "as it happens", "Three hundred ... essays" with 8 full texts; the "Simulated data" frame shows real agent rows). Closed by PL5. |
| E5 | Further essay sources: Wikisource access path (its API path is robots-disallowed), source health recovery, schedules. |
| E6 | Per-site extractors with public-domain fixtures; keep paywall and login boundaries and the link-only fallback; add the navigation/ad-text and language checks of SPEC item 4 with the first non-Gutenberg extractor. |
| E10 | Nightly source health and weekly quality report; deferred until E5 or the Scraper-builder runs. |
| H12 | Web push: the owner's iPhone Home Screen check. |

Decisions not recorded elsewhere: a link-only essay passes acceptance with a title and author (zero approved seeds fails); the X-ray overlay uses no accent colour and keeps its state per browser tab.

## Owner steps (open)

1. Google: connect Google at `/connections` for Calendar. If an earlier consent granted YouTube, revoke it at Google (Google Account, third-party access). The Google verification request lists only the Calendar scope.
2. Consent screens (H1 console step): enter `https://kentcrosswise.com/terms` and `https://kentcrosswise.com/privacy` in the Google Cloud OAuth consent screen.
3. Delete the Instagram (Meta) and TikTok developer apps.
4. Web push: on an iPhone (iOS 16.4+) add the site to the Home Screen, open it from there, sign in, enable notifications on `/notifications` and send a test.

## Not verified live

Source or CI facts only until a scoped live check records a result. Each live case needs its own owner-approved run.

- A scheduled `inbox-push` run in prod; a real web push.
- AR3 call records from real provider calls (model ids, usage fields on errors).
- A live DeepSeek route of a real capture, a live mood score and calendar extraction; a real Google Calendar insert and token refresh.
- An outbox delivery and AR2 effect reconciliation; a blocked child (AR4); the 422 for a missing contract input (AR5a).
- AR5b: a replan with a real planner call, attempt rows from real runs, the per-attempt cost query.
- AR6: the capacity line against live data, a real reservation refusal and retry, run cancellation timing.
- AR8a: annotation and run reads as the sweeper does them with the installation token.
- Agents: cold-container restart, late or duplicate reports, conflict escalation, Scraper execution, no-op Docs completion; webhook retry and dedupe; missing-cost injection (A11); owner approval and rejection of a protected path through the inbox (A6).
- Browsers: Safari, Firefox and physical phones. Runtime adapters: native instruction loading per runtime (A13).
- `docs/runbooks/oidc-debug.yml` predates the trusted-path roles; repair or delete it before reuse (A14).

## Vendor and account facts to verify at execution time

- U4 LangGraph checkpoint behaviour across cold starts and LangSmith flush.
- U5 Fork-PR id-token behaviour (keep same-repo CI guards).
- U7 Neon project-scoped keys and URL masking.
- U9 Google consent screen and refresh-token longevity after incremental consent.
- U12 Current AWS pricing and free-tier state.

## Later (not blockers)

- Migrate owner administration to IAM Identity Center when the Free Tier credits run out (A15).
- Owner-driven continuous console work; capture-to-task approval flow.
- Embedding recommendations, EPUB/PDF import, Apple Shortcut capture, Gmail/Voice bridge, native app.
- Periodic dependency and security updates; consider making ruleset-drift CI blocking (A4); DeepSeek peak/off-peak/cache pricing.
