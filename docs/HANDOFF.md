# Kentcrosswise project handoff

**Current state — 2026-10-23 18:42 UTC:** secure workflows are merged/deployed and isolation probes passed. Agents are disabled after the Developer canary exposed a publisher App-key parsing failure. The normalization fix is prepared locally; its CI/merge and the same canary/QA retry remain pending.

## Observation and provenance

Current evidence was supplied and independently checked by the Liaison during the owner-approved source/policy rollout and explicitly approved Developer/QA model test/cleanup.
Earlier dated audit details remain in Git history and the [cutover/rollback runbook](runbooks/agent-security-cutover.md).
Canonical instructions and resume procedure remain in [agents/INSTRUCTIONS.md](agents/INSTRUCTIONS.md) and [agents/CONTINUITY.md](agents/CONTINUITY.md).

## Repository and refs

- Repository: `kentkodes/kentcrosswise`; default branch `main`; fetched baseline `30c98e3c27ce74a0dd10be64691826af8ef024d0`.
- Active branch: `security/agent-key-canary-fix-20261023`, working-tree fix atop that baseline. Fix PR/head: **not yet published**; inspect Git/PR for its eventual containing SHA.
- #29 merged as `30c98e3c27ce74a0dd10be64691826af8ef024d0`, with tree identical to reviewed `598e62eacabb9bc813403a647fc933a874fedb21`; #30 is closed as superseded/included.
- Primary checkout preserved. Local `team/` instructions/memory are workspace context, not Git-portable project state; private plan artifacts remain local.

## PRs and checks

| PR | Observed head / merge | State / condition |
|---|---|---|
| [#29: secure workflows](https://github.com/kentkodes/kentcrosswise/pull/29) | merge `30c98e3c27ce74a0dd10be64691826af8ef024d0` | Merged; all CI and deployment passed |
| [#30: continuity docs](https://github.com/kentkodes/kentcrosswise/pull/30) | `2ed0b6e9110f5162e8f7cf75358efd3143c78c9a` | Closed as superseded by #29 |
| [#28: sweeper PEM fix](https://github.com/kentkodes/kentcrosswise/pull/28) | `9e314ffecb8f1d8434465d2ecd394a9a53e6c7ec` (earlier observation) | Not merged; separate Octokit PEM path; recheck current head/review and live redelivery after deploy |
| [#26: live graph wiring](https://github.com/kentkodes/kentcrosswise/pull/26) | `78008996dc7a8ff441b4269c550a7d54d422230a` (earlier observation) | Not live; original conditional authorization requires secure-workflow readiness and current green/mergeability checks |

## Ownership and changes

Owner approved #29 source/Q14 behavior, stronger governance/import/configuration/all-lockfile review policy, staged rollout, and the specific independent Developer/QA canary plus cleanup.
The new publisher-key fix normalizes/validates PEM before App-token minting and keeps values out of outputs/logs. Its prepared source checks pass; live causation and successful publishing are not yet established.
The completed, disabled temporary `.github/workflows/agent-security-probe.yml` is removed by this cleanup patch; its main-branch removal follows CI/merge. Owned branch/tag probe refs are already deleted.

## Verification

- [#29 CI 40000253635](https://github.com/kentkodes/kentcrosswise/actions/runs/40000253635): all checks passed; [deploy 40002977225](https://github.com/kentkodes/kentcrosswise/actions/runs/40002977225): passed.
- Bootstrap applied exactly **8 add, 0 change, 2 destroy**, retiring the shared role/policy and creating four isolated roles/policies; post-apply plan showed no drift. Live trust/policy read-back matched the approved boundary.
- Four publisher environments allow exact custom `main` branch only, no tags, `admins_bypass=false`; scoped role variables set, old variable removed; legacy TokenIssueTime cutoff deny installed before retirement.
- [Live probe 40003138583](https://github.com/kentkodes/kentcrosswise/actions/runs/40003138583): **219 assertions passed**, covering own-role/key access, cross-key/cross-role denial, wrong audience, role chaining and four fixed-null queue messages.
- Worker and Liaison independently matched all four exact probe message IDs to `dropped (message must be a JSON object)` logs; queue and DLQ were both zero at verification.
- [Branch 40003427017](https://github.com/kentkodes/kentcrosswise/actions/runs/40003427017) and [tag 40003533025](https://github.com/kentkodes/kentcrosswise/actions/runs/40003533025): all four environments explicitly rejected deployment before steps (expected failed runs).
- [Developer canary 40003984068](https://github.com/kentkodes/kentcrosswise/actions/runs/40003984068): federation/model work and candidate export succeeded; App-token publishing failed with DECODER unsupported. Start/end failure reporting succeeded; no task PR or branch was created.
- Prepared publisher PEM fix: 49 tests including real crypto and safe CLI passed, scripts lint/typecheck and four workflow actionlint checks passed. Fix CI/merge, successful same-canary retry and independent QA: **PENDING**.
- Actual stored-key shape was not inspected; a formatting/encoding cause remains incompletely verified. Authorized own-key probes accessed and discarded values without inspecting/logging them.
- `KCW_AGENT_WORKFLOWS_ENABLED=false` now. Standard CI previews are separate from agent enablement; historical production app checks remain in [prod DB runbook](runbooks/prod-db.md).

## Decisions and security holds

- Q14/Q15 source/policy and staged isolation rollout: owner approved and deployed. Keep agents disabled until publisher fix and controlled canary/QA verification succeed.
- Independent test is public disposable [issue #31](https://github.com/kentkodes/kentcrosswise/issues/31), synthetic task **9000000001**, with no DB task; owner console has zero tasks. It is unmerged test work, not automatic orchestration.
- #26 automatic graph orchestration and real queued/console tasks remain held. Independent workflow success does not establish checkpoint ownership or real-task E2E.
- Q12 confirmation pending: 1–5 nonrecursive subtasks, parent waits outside the in-flight limit, bounded retry/escalation; full contract in [DESIGN §11, Q12](DESIGN.md#11-spec-conflicts-and-open-questions).
- Q13 confirmation pending despite historical resolved placement: stored cost/effective price/“no price,” deduped wall-clock Actions minutes, no duplicate minutes, UTC ranges; full contract in [DESIGN §11, Q13](DESIGN.md#11-spec-conflicts-and-open-questions).
- U13/final ruleset and model pricing remain open ([DESIGN §10, U13](DESIGN.md#10-unverified-items-status)); relay uses interim `orch_rw` pending a narrower approved role ([DESIGN §11](DESIGN.md#11-spec-conflicts-and-open-questions)).
- Full P2-18 console → issue → PR → QA → merge → deploy E2E remains open ([DESIGN §8, P2-18](DESIGN.md#8-phase-2-agent-system-local-sub-agents)).

## Remaining work and next action

1. Review/publish the prepared publisher PEM fix and probe-workflow cleanup; require green CI at its exact head before merge. Do not claim the live key cause or successful minting until verified.
2. Retry the same authorized independent Developer canary for issue #31/task **9000000001**, then complete independent QA verification and cleanup. Keep this separate from #26 and real task intake.
3. Record App publishing, QA review, reporting and final flag state; clean up only the authorized disposable task artifacts. Keep failures/unverified results explicit.
4. Review #28 independently and verify deployed sweeper redelivery. Revalidate #26's original conditional authorization, prerequisites and current checks before merge; verify `lg` ownership after deployment.
5. Address Q12/Q13, U13/final ruleset, model prices, relay-role decision and P2-18. Confirm required model secret configuration only through an authorized non-disclosing check.
