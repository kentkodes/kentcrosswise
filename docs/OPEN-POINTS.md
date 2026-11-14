# Kentcrosswise open points

Current backlog, 2026-11-13 UTC. Current state and holds are in [HANDOFF.md](HANDOFF.md); done items are removed (Git history has the earlier list). Delivery order: essay reader and recommendations, capture and routing, remaining hub/social/inbox, then X-ray and final acceptance.

## Review candidates (2026-11-13, owner decision)

| ID | Open point |
|---|---|
| R1 | Public copy overstates what is delivered. The home page says every change is made by the agents and that the office shows the work "as it happens", but agents are paused and most recent changes were owner-run sessions. It lists "Three hundred classic and modern essays, with a reader and recommendations" (8 full texts, the rest links) and "Contacts, moods, essays and notes" (the private hub's contacts and mood are not built). Its "Simulated data" frame also shows real agent rows. |
| R2 | The planner calls Opus 5.5 with `max_tokens` 1024 at high effort. Opus 5.5 always thinks, so thinking can use the whole limit and leave no JSON; neither model provider checks `stop_reason`. The 2026-11-11 canary already used 798 output tokens over two calls for a one-line task. Raise the limit, check `stop_reason` (`max_tokens`, `refusal`), and consider structured output instead of hand-parsed JSON. |

| R3 | Worker context cost: the canary's one-line docs task sent about 1.1M input tokens to DeepSeek over about 40 turns, because each turn re-sends the large instruction, handoff and design files the playbooks require. Shorter required reading (this cleanup) is the first step; measure the next task's input tokens before doing more. |

## Essays (Phase 5)

| ID | Open work |
|---|---|
| E2 | `/essays` list for ~300 entries (in progress on `frontend/essays-feed-20261113`). |
| E3 | Recommendations that change with ratings by type, author, era and tags; today Recommended lists unrated full texts. |
| E5 | Further sources: Wikisource access path (its API path is robots-disallowed), source health recovery, schedules. |
| E6 | Per-site extractors with public-domain fixtures; keep paywall and login boundaries and the link-only fallback. |
| E7 | Validator: normalized hash, near-duplicate and fuzzy-metadata checks, quality checks; quarantine failures. |
| E8 | DeepSeek categorization in production and hook writing. |
| E10 | Nightly source health and weekly quality report. |
| E11 | Public demo with a few public-domain essays. |
| E12 | MVP acceptance: every approved seed is validated full text or link-only, no duplicates, preferences and ratings visibly change recommendations. |

## Hub MVP (Phase 3)

| ID | Open work |
|---|---|
| H1 | Public `/terms` and `/privacy` pages and the provider/domain configuration they need. |
| H2 | Phone-friendly private capture box, raw-entry persistence and routing status (in progress on `feat/hub-capture-20261113`). |
| H3 | Routing on DeepSeek, low-confidence inbox, owner reassignment and stored corrections. |
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
| A16 | Report deployment completion into the task lifecycle and feed. |

## Runtime cases not yet exercised

Each needs its own scoped, owner-approved run.

- Agents: cold-container restart, bounded retry and failure recovery, active-agent cancellation, late or duplicate reports, conflict escalation, Scraper execution, no-op Docs completion.
- Webhooks: retry of a real failed delivery and dedupe.
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

## Later (Phase 6, not blockers)

- Migrate owner administration to IAM Identity Center when the Free Tier credits run out (A15).
- Owner-driven continuous console work; capture-to-task approval flow.
- Embedding recommendations, EPUB/PDF import, Apple Shortcut capture, Gmail/Voice bridge, native app.
- Periodic dependency and security updates; consider making ruleset-drift CI blocking (A4).
