# Kentcrosswise open points

Current backlog, 2026-11-14 UTC. Current state and holds are in [HANDOFF.md](HANDOFF.md); done items are removed (Git history has the earlier list). Owner direction: autonomous development is the primary outcome; the hub is its demonstration workload. Complete the reliability sequence below before further hub, essay or office expansion.

## Autonomous development reliability (accepted priority, implementation pending)

The target lifecycle is defined in [DESIGN.md](DESIGN.md), section 4.0. For implementation, read the on-demand [execution plan](RELIABILITY-PLAN.md): scoped PR slices, trust boundaries, failure tests and session handoff. Deliver in the order below; later implementation can identify independent work without weakening prerequisites. Source-review findings are not claims that a production incident occurred. Existing owner gates still apply.

| ID | Work and completion evidence |
|---|---|
| AR1 | Isolate candidate CI from production authority. Prove the preview role cannot retag/mutate prod CloudFront resources or shared policies, and candidate builds cannot obtain production write authority. Narrow the web router's model-secret access to its consumer need. Choose the IAM/provisioning technique after fresh source and policy review; bootstrap/workflow/live changes remain separately gated. Slice 1 (PR-scoped preview boundary, prod CloudFront deny, shared preview policies, router-only secret) is in #106 and waits for the owner's bootstrap cutover ([bootstrap runbook](runbooks/bootstrap.md#ar1-slice-1-cutover-authority-and-secret-split)); slices 2-3 follow. |
| AR2 | Make relay-to-SQS handoff recoverable and GitHub effects reconcilable. Fault tests cover crash after delivery claim, after issue/dispatch success and before checkpoint save; retries neither lose accepted work nor create duplicate logical effects. Deduplicate partial/late usage writes with stable operation identities. Depends on AR1 before live acceptance. |
| AR3 | Account for every model caller, including essay categorization; test missing, late and duplicate reports and price lookup failure. Reconcile totals across usage and spending decisions. The existing $50 control stays soft; choose the unknown-price policy and any enforcement change explicitly before implementation. Depends on AR2's accounting identities. |
| AR4 | Enforce subtask prerequisites. Start sequentially by default and verify a schema-then-consumer task uses the accepted predecessor revision; permit parallel work only when independence is explicit. Enqueue child starts without bundling their model work into one parent invocation. Depends on AR2. |
| AR5 | Supply bounded, revision-pinned task contracts and on-demand context; record attempts, supersession, result validity and verification evidence per DESIGN 4.0. Test retry and replanning without losing task identity or reusing incompatible results/QA. Measure accepted-task input/output usage against the recorded ~1.1M-input-token one-line canary (former R3), not a token target invented here. Depends on AR3-AR4. |
| AR6 | Separate active execution capacity from parked-work/PR limits. Verify four owner waits do not silently masquerade as four running workers; choose numeric limits and demonstrate deliberate backpressure. Depends on AR5's execution model. |
| AR7 | Keep every unresolved saved capture retrievable, with failed/capped/pending states and retry or owner correction. Test more than ten captures during provider failure. Preserve raw entries and edits; downstream move semantics are implemented with H4/H6/H7, not claimed delivered by H3. |
| AR8 | Add actionable failure visibility and release recovery: DLQ/oldest-message and sweeper/deploy failures, build before production migration, compatible schema rollout, rollback/restore procedure and a restore rehearsal. Report merged, deployed and verified outcomes separately (former A16). Exact alert delivery and recovery targets remain implementation decisions. |
| AR9 | Demonstrate one representative dependent task through implementation, CI, independent head-bound QA, merge, deploy and verification, with restart/duplicate/failure recovery. Define the acceptance task, cost allowance and live steps before running; use offline fault tests wherever external behavior is not the question. Depends on AR1-AR8. Record elapsed time, usage, human interventions and unresolved gaps. |

Unsettled implementation choices: preview isolation mechanism, unknown-price policy, worker/WIP/time limits, alert destination and recovery targets, and the exact paid/live acceptance scope. The accepted priority and lifecycle defaults do not approve those privileged steps.

## Review candidates (2026-11-13, owner decision)

| ID | Open point |
|---|---|
| R1 | Kept for later (owner 2026-11-14). Public copy overstates what is delivered. The home page says every change is made by the agents and that the office shows the work "as it happens", but agents are paused and most recent changes were owner-run sessions. It lists "Three hundred classic and modern essays, with a reader and recommendations" (8 full texts, the rest links) and "Contacts, moods, essays and notes" (the private hub's contacts and mood are not built). Its "Simulated data" frame also shows real agent rows. |

## Essays (Phase 5)

| ID | Open work |
|---|---|
| E5 | Further sources: Wikisource access path (its API path is robots-disallowed), source health recovery, schedules. |
| E6 | Per-site extractors with public-domain fixtures; keep paywall and login boundaries and the link-only fallback. With the first non-Gutenberg extractor, add the navigation/ad-text and language checks of SPEC item 4. |
| E8 | DeepSeek categorization in production and hook writing. |
| E10 | Nightly source health and weekly quality report; open a GitHub issue for quarantined essays once the Scraper-builder runs. |
| E11 | Public demo with a few public-domain essays. |
| E12 | MVP acceptance: every approved seed is validated full text or link-only, no duplicates, preferences and ratings visibly change recommendations. |

## Hub MVP (Phase 3)

| ID | Open work |
|---|---|
| H1 | Public `/terms` and `/privacy` pages and the provider/domain configuration they need. |
| H4 | Contacts: CRUD, aliases, tags, birthday, context, linking notes with owner resolution of ambiguous matches. |
| H5 | Calendar OAuth with incremental consent, suggestion extraction, one-tap event creation. |
| H6 | Diary editor, eight 0-1 mood metrics plus overall sentiment, chart history with metric toggles. |
| H7 | Todos and ideas lists; project tabs including Essays. |
| H8 | Daily YouTube statistics and stored snapshots; rounded versus exact follower labels. |
| H9 | Instagram Login integration and long-lived token refresh. |
| H10 | TikTok sandbox stats spike, refresh-token rotation, manual-entry fallback. |
| H11 | Social dashboard totals, source filter, manual-entry provenance. |
| H12 | Unified owner inbox (routing, contact matches, calendar, agent requests); web push and iPhone Home Screen check. |

## Office and X-ray (Phase 4)

| ID | Open work |
|---|---|
| X1 | X-ray component registry and public overlay (the package is a stub). |
| X3 | Execution-observation rollout per the owner sign-off in [HANDOFF.md](HANDOFF.md) (controlled signed-run check first). Contract: [LIVE-CONTRACT.md](office/LIVE-CONTRACT.md). |

## Runtime cases not yet exercised

Use these cases in AR9's acceptance matrix; each live case needs its own scoped, owner-approved run. Source/offline tests do not close an external-runtime verification gap.

- Agents: cold-container restart, bounded retry and failure recovery, active-agent cancellation, late or duplicate reports, conflict escalation, Scraper execution, no-op Docs completion.
- Webhooks: retry of a real failed delivery and dedupe.
- Spend: missing-cost injection and late or duplicate usage reports (A11).
- Protected paths: owner approval and rejection through the inbox (A6).
- Browsers: Safari, Firefox and physical phones (canvas, touch, reduced motion, playback).
- Runtime adapters: native instruction loading in each supported local and cloud runtime (A13).
- `docs/runbooks/oidc-debug.yml` predates per-agent publishing; repair or delete it before reuse (A14).

## Vendor and account facts to verify at execution time

- U4 LangGraph checkpoint behaviour across cold starts and LangSmith flush.
- U5 Fork-PR id-token behaviour (keep same-repo CI guards).
- U7 Neon project-scoped keys and URL masking.
- U9 Google consent screen and refresh-token longevity after incremental consent.
- U10 Instagram development mode without App Review; TikTok sandbox stats.
- U12 Current AWS pricing and free-tier state.
- U2 QA on Claude Haiku 5.5 through Anthropic federation has not run live since #88 (the canary's QA ran on DeepSeek); federation usage reporting is unexercised.

## Later (Phase 6, not blockers)

- Migrate owner administration to IAM Identity Center when the Free Tier credits run out (A15).
- Owner-driven continuous console work; capture-to-task approval flow.
- Embedding recommendations, EPUB/PDF import, Apple Shortcut capture, Gmail/Voice bridge, native app.
- Periodic dependency and security updates; consider making ruleset-drift CI blocking (A4).
