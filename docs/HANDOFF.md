# Kentcrosswise project handoff

**Current state — 2026-10-23 19:18 UTC:** publisher-key fix #32 is merged/deployed and the Developer input-only retry succeeded in all five jobs, creating disposable PR #33. Its CI and independent QA remain pending. The workflow flag is temporarily true only for the specifically authorized canary; real task intake remains closed and #26 is not live.

## Observation and provenance

Current evidence was supplied and independently checked by the Liaison during the owner-approved source/policy rollout and explicitly approved Developer/QA model test/cleanup.
Earlier dated audit details remain in Git history and the [cutover/rollback runbook](runbooks/agent-security-cutover.md).
Canonical instructions and resume procedure remain in [agents/INSTRUCTIONS.md](agents/INSTRUCTIONS.md) and [agents/CONTINUITY.md](agents/CONTINUITY.md).

## Repository and refs

- Repository: `kentkodes/kentcrosswise`; default branch `main`; fetched baseline `d4dde25eaef44e7b7e1aa0e4bb9c2572f0f05036` (#32 merge).
- Active branch: `security/agent-publish-canary-fix-20261023`, follow-up source/docs work atop that baseline; inspect Git/PR for its eventual containing SHA.
- #29 merged as `30c98e3c27ce74a0dd10be64691826af8ef024d0`, with tree identical to reviewed `598e62eacabb9bc813403a647fc933a874fedb21`; #30 is closed as superseded/included.
- Primary checkout preserved. Local `team/` instructions/memory are workspace context, not Git-portable project state; private plan artifacts remain local.

## PRs and checks

| PR | Observed head / merge | State / condition |
|---|---|---|
| [#29: secure workflows](https://github.com/kentkodes/kentcrosswise/pull/29) | merge `30c98e3c27ce74a0dd10be64691826af8ef024d0` | Merged; all CI and deployment passed |
| [#32: publisher-key fix](https://github.com/kentkodes/kentcrosswise/pull/32) | merge `d4dde25eaef44e7b7e1aa0e4bb9c2572f0f05036` | Merged; CI and deploy green |
| [#33: disposable canary](https://github.com/kentkodes/kentcrosswise/pull/33) | `c17e970dbda48af2180fd242d00b23e7502127fd` | Open/unmerged; CI and independent QA pending |
| [#30: continuity docs](https://github.com/kentkodes/kentcrosswise/pull/30) | `2ed0b6e9110f5162e8f7cf75358efd3143c78c9a` | Closed as superseded by #29 |
| [#28: sweeper PEM fix](https://github.com/kentkodes/kentcrosswise/pull/28) | `9e314ffecb8f1d8434465d2ecd394a9a53e6c7ec` (earlier observation) | Not merged; separate Octokit PEM path; recheck current head/review and live redelivery after deploy |
| [#26: live graph wiring](https://github.com/kentkodes/kentcrosswise/pull/26) | `78008996dc7a8ff441b4269c550a7d54d422230a` (earlier observation) | Not live; original conditional authorization requires secure-workflow readiness and current green/mergeability checks |

## Ownership and changes

Owner approved #29 source/Q14 behavior, stronger governance/import/configuration/all-lockfile review policy, staged rollout, and the specific independent Developer/QA canary plus cleanup.
The merged publisher-key fix normalizes/validates PEM without exposing values. Developer retry now demonstrates successful App-token publishing; the historical stored-key encoding was not inspected. Current follow-up work addresses stale QA context paths; no QA outcome is claimed.
The completed temporary `.github/workflows/agent-security-probe.yml` was removed by #32. Owned branch/tag probe refs are already deleted.

## Verification

- [#29 CI 40000253635](https://github.com/kentkodes/kentcrosswise/actions/runs/40000253635): all checks passed; [deploy 40002977225](https://github.com/kentkodes/kentcrosswise/actions/runs/40002977225): passed.
- Bootstrap applied exactly **8 add, 0 change, 2 destroy**, retiring the shared role/policy and creating four isolated roles/policies; post-apply plan showed no drift. Live trust/policy read-back matched the approved boundary.
- Four publisher environments allow exact custom `main` branch only, no tags, `admins_bypass=false`; scoped role variables set, old variable removed; legacy TokenIssueTime cutoff deny installed before retirement.
- [Live probe 40003138583](https://github.com/kentkodes/kentcrosswise/actions/runs/40003138583): **219 assertions passed**, covering own-role/key access, cross-key/cross-role denial, wrong audience, role chaining and four fixed-null queue messages.
- Worker and Liaison independently matched all four exact probe message IDs to `dropped (message must be a JSON object)` logs; queue and DLQ were both zero at verification.
- [Branch 40003427017](https://github.com/kentkodes/kentcrosswise/actions/runs/40003427017) and [tag 40003533025](https://github.com/kentkodes/kentcrosswise/actions/runs/40003533025): all four environments explicitly rejected deployment before steps (expected failed runs).
- [Developer canary 40003984068](https://github.com/kentkodes/kentcrosswise/actions/runs/40003984068): federation/model work and candidate export succeeded; App-token publishing failed with DECODER unsupported. Start/end failure reporting succeeded; no task PR or branch was created.
- [#32 CI 40005934642](https://github.com/kentkodes/kentcrosswise/actions/runs/40005934642) and [deploy 40007817660](https://github.com/kentkodes/kentcrosswise/actions/runs/40007817660): green. The key fix had 49 tests including real crypto/safe CLI, scripts lint/typecheck and four actionlint checks passing.
- [Developer retry 40009044371](https://github.com/kentkodes/kentcrosswise/actions/runs/40009044371): all five jobs succeeded, including federation/model work, App publishing and reporting. Created only PR #33/`kcw/task-9000000001`, exactly `docs/research/agent-cutover-canary.md` (three lines).
- [PR #33 CI 40009578757](https://github.com/kentkodes/kentcrosswise/actions/runs/40009578757): pending at observation; independent QA and final cleanup: **PENDING**. `KCW_AGENT_WORKFLOWS_ENABLED=true` temporarily for the exact authorized canary only; real intake remains closed. Historical app checks remain in [prod DB runbook](runbooks/prod-db.md).

## Decisions and security holds

- Q14/Q15 source/policy and staged isolation rollout: owner approved and deployed. Publisher fix and Developer retry succeeded; independent QA and cleanup are still required before ending controlled verification. The temporary canary flag does not authorize real task intake.
- Independent test is public disposable [issue #31](https://github.com/kentkodes/kentcrosswise/issues/31), synthetic task **9000000001**, with no DB task; owner console has zero tasks. It is unmerged test work, not automatic orchestration.
- #26 automatic graph orchestration and real queued/console tasks remain held. Independent workflow success does not establish checkpoint ownership or real-task E2E.
- Q12 confirmation pending: 1–5 nonrecursive subtasks, parent waits outside the in-flight limit, bounded retry/escalation; full contract in [DESIGN §11, Q12](DESIGN.md#11-spec-conflicts-and-open-questions).
- Q13 confirmation pending despite historical resolved placement: stored cost/effective price/“no price,” deduped wall-clock Actions minutes, no duplicate minutes, UTC ranges; full contract in [DESIGN §11, Q13](DESIGN.md#11-spec-conflicts-and-open-questions).
- U13/final ruleset and model pricing remain open ([DESIGN §10, U13](DESIGN.md#10-unverified-items-status)); relay uses interim `orch_rw` pending a narrower approved role ([DESIGN §11](DESIGN.md#11-spec-conflicts-and-open-questions)).
- Full P2-18 console → issue → PR → QA → merge → deploy E2E remains open ([DESIGN §8, P2-18](DESIGN.md#8-phase-2-agent-system-local-sub-agents)).

## Remaining work and next action

1. Complete the scoped QA context/prompt follow-up, verify it through CI, and wait for PR #33 checks at exact head `c17e970dbda48af2180fd242d00b23e7502127fd` before the independent review.
2. Complete the specifically authorized independent QA review of PR #33, then disposable issue/PR/branch cleanup and final flag reset. Keep the canary unmerged and separate from #26/real task intake; record results only after observation.
3. Record App publishing, QA review, reporting and final flag state; clean up only the authorized disposable task artifacts. Keep failures/unverified results explicit.
4. Review #28 independently and verify deployed sweeper redelivery. Revalidate #26's original conditional authorization, prerequisites and current checks before merge; verify `lg` ownership after deployment.
5. Address Q12/Q13, U13/final ruleset, model prices, relay-role decision and P2-18. Confirm required model secret configuration only through an authorized non-disclosing check.
