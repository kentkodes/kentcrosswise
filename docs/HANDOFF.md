# Kentcrosswise project handoff

**Current state — 2026-10-23 19:51 UTC:** the independent Developer/QA canary completed successfully. QA approved the unchanged disposable PR head from a separate App identity; the PR and issue are closed unmerged, its branch is deleted, and the GitHub workflow flag is false. Closing-PR preview cleanup also passed; real intake remains operationally on hold pending user readiness.

## Observation and provenance

Current evidence was supplied and independently checked by the Liaison during the owner-approved source/policy rollout and explicitly approved Developer/QA model test/cleanup.
Earlier dated audit details remain in Git history and the [cutover/rollback runbook](runbooks/agent-security-cutover.md).
Canonical instructions and resume procedure remain in [agents/INSTRUCTIONS.md](agents/INSTRUCTIONS.md) and [agents/CONTINUITY.md](agents/CONTINUITY.md).

## Repository and refs

- Repository: `kentkodes/kentcrosswise`; default branch `main`; fetched baseline `afb5cca66bb914b367296b6fcf544541a415f1be` (#34 merge).
- Active branch: `docs/agent-cutover-final-20261023`, final evidence/docs work atop that baseline; inspect Git/PR for its eventual containing SHA.
- #29 merged as `30c98e3c27ce74a0dd10be64691826af8ef024d0`, with tree identical to reviewed `598e62eacabb9bc813403a647fc933a874fedb21`; #30 is closed as superseded/included.
- Primary checkout preserved. Local `team/` instructions/memory are workspace context, not Git-portable project state; private plan artifacts remain local.

## PRs and checks

| PR | Observed head / merge | State / condition |
|---|---|---|
| [#29: secure workflows](https://github.com/kentkodes/kentcrosswise/pull/29) | merge `30c98e3c27ce74a0dd10be64691826af8ef024d0` | Merged; all CI and deployment passed |
| [#32: publisher-key fix](https://github.com/kentkodes/kentcrosswise/pull/32) | merge `d4dde25eaef44e7b7e1aa0e4bb9c2572f0f05036` | Merged; CI and deploy green |
| [#34: QA context follow-up](https://github.com/kentkodes/kentcrosswise/pull/34) | merge `afb5cca66bb914b367296b6fcf544541a415f1be` | Merged; exact reviewed tree `2a32d140053fd108cb3bd2641f0447b71ce7669e`; CI and deploy green |
| [#33: disposable canary](https://github.com/kentkodes/kentcrosswise/pull/33) | `c17e970dbda48af2180fd242d00b23e7502127fd` | Closed unmerged after green CI and QA approval at unchanged head |
| [#30: continuity docs](https://github.com/kentkodes/kentcrosswise/pull/30) | `2ed0b6e9110f5162e8f7cf75358efd3143c78c9a` | Closed as superseded by #29 |
| [#28: sweeper PEM fix](https://github.com/kentkodes/kentcrosswise/pull/28) | `9e314ffecb8f1d8434465d2ecd394a9a53e6c7ec` | Open/mergeable, not merged; separate Octokit PEM path; recheck current head/review and live redelivery after deploy |
| [#26: live graph wiring](https://github.com/kentkodes/kentcrosswise/pull/26) | `78008996dc7a8ff441b4269c550a7d54d422230a` | Open/conflicting with main; old CI green is historical; not live; original conditional authorization requires secure-workflow readiness and current green/mergeability checks |

## Ownership and changes

Owner approved #29 source/Q14 behavior, stronger governance/import/configuration/all-lockfile review policy, staged rollout, and the specific independent Developer/QA canary plus cleanup.
The merged publisher-key fix normalizes/validates PEM without exposing values. Developer retry now demonstrates successful App-token publishing; the historical stored-key encoding was not inspected. QA context/prompt follow-up #34 is merged; independent QA completed successfully with an approval from the QA App at the unchanged Developer-authored head.
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
- [#34 CI 40011153189](https://github.com/kentkodes/kentcrosswise/actions/runs/40011153189): all green at `2a32d140053fd108cb3bd2641f0447b71ce7669e`; merged tree equality verified. [Deploy 40013750437](https://github.com/kentkodes/kentcrosswise/actions/runs/40013750437): passed.
- [PR #33 CI 40009578757](https://github.com/kentkodes/kentcrosswise/actions/runs/40009578757): all green at unchanged `c17e970dbda48af2180fd242d00b23e7502127fd`. [QA 40013755835](https://github.com/kentkodes/kentcrosswise/actions/runs/40013755835): all six jobs succeeded at main `afb5cca`; review `5633657724` is APPROVED at canary head `c17e970dbda48af2180fd242d00b23e7502127fd` by Bot `kentcrosswise-qa[bot]`, separate from Developer author `app/kentcrosswise-dev`. No new commits.

- Cleanup at 19:50 UTC: workflow flag read back false; #33 CLOSED with `mergedAt=null`; issue #31 CLOSED; task branch deleted after exact-SHA guard and empty `git ls-remote`. Queue/DLQ each had all three counts zero at 19:50 UTC. [#34 GC 40013751465](https://github.com/kentkodes/kentcrosswise/actions/runs/40013751465) passed; [#33 closing GC 40014543612](https://github.com/kentkodes/kentcrosswise/actions/runs/40014543612) passed (closed-PR job succeeded; sweep skipped as expected).

## Decisions and security holds

- Q14/Q15 source/policy and staged isolation rollout: owner approved and deployed. Publisher fix, Developer and independent QA verification succeeded; workflow flag is now false. The completed canary does not authorize real task intake.
- Independent test is public disposable [issue #31](https://github.com/kentkodes/kentcrosswise/issues/31), synthetic task **9000000001**, with no DB task. Console refreshed at 19:51 UTC showed zero tasks while DB Agents/Pipelines switches displayed running; these are distinct from the GitHub workflow flag and were unchanged. The disposable PR was closed unmerged after verification; this was not automatic orchestration.
- #26 automatic graph orchestration and real queued/console tasks remain held. Independent workflow success does not establish checkpoint ownership or real-task E2E.
- Q12 confirmation pending: 1–5 nonrecursive subtasks, parent waits outside the in-flight limit, bounded retry/escalation; full contract in [DESIGN §11, Q12](DESIGN.md#11-spec-conflicts-and-open-questions).
- Q13 confirmation pending despite historical resolved placement: stored cost/effective price/“no price,” deduped wall-clock Actions minutes, no duplicate minutes, UTC ranges; full contract in [DESIGN §11, Q13](DESIGN.md#11-spec-conflicts-and-open-questions).
- U13/final ruleset and model pricing remain open ([DESIGN §10, U13](DESIGN.md#10-unverified-items-status)); relay uses interim `orch_rw` pending a narrower approved role ([DESIGN §11](DESIGN.md#11-spec-conflicts-and-open-questions)).
- Native adapter runtime loading and Docs/Scraper model execution remain unverified; automatic graph/task persistence and real-task E2E remain held.
- Full P2-18 console → issue → PR → QA → merge → deploy E2E remains open ([DESIGN §8, P2-18](DESIGN.md#8-phase-2-agent-system-local-sub-agents)).

## Remaining work and next action

1. If this handoff branch is not merged, require normal review/CI before merge; otherwise retain this record until new evidence changes it. The authorized independent canary and cleanup are complete; keep the GitHub workflow flag false and real intake operationally on hold until the user is ready.
2. Resume #28/#26 only within the original scope and current eligibility: review #28 and verify deployed redelivery; resolve #26 conflicts, recheck prerequisites/green head and authorization before merge, then verify `lg` ownership. No further canary or real task is implied.
3. Address Q12/Q13, U13/final ruleset, model prices, relay-role decision and P2-18. Native adapter loading, Docs/Scraper model runs and automatic graph/task persistence remain unverified. Confirm required model secret configuration only through an authorized non-disclosing check.

## Local preparation of PR #26 — 2026-10-23

- Scope: local integration only, continuing PR head `78008996dc7a8ff441b4269c550a7d54d422230a` on owned branch `resume/orchestrator-20261023`. The Liaison fetched `origin/main` at `4b1e92586803042cc7b20e547f91fd692c04d21f`; the implementation session's own fetch failed DNS, so it used that supplied baseline. Live PR state, checks and deployment were not refreshed by this session.
- Merged that main locally. Resolved the root `AGENTS.md` conflict by preserving main's canonical entrypoint. Preserved main's security workflows, graph transitions requiring fresh CI/QA after new commits, and the exact Q12/Q13 design text. No dependency, infrastructure, workflow enablement or #28 PEM changes were added.
- Candidate behavior: Lambda wires the task graph, GitHub client, model planner and per-task model usage; the old skeleton is removed. Missing model/App/DB configuration returns messages to the queue. This remains candidate source, with no deployment or real intake implied.
- Verification on the integration working tree atop the original PR head, completed by 20:26 UTC: frozen offline installation with lifecycle scripts disabled; `pnpm lint`; `pnpm typecheck`; `node scripts/check-agent-docs.mjs`; `pnpm build-lambdas` (all three bundles load); `pnpm vitest run --project @kcw/orchestrator --maxWorkers 2` (12 files, 193 tests passed); `pnpm vitest run --project @kcw/scripts scripts/test/lambda-bundle.test.ts --maxWorkers 1` (23 tests passed). Local socket tests required execution outside the restricted sandbox; all services and model replies were local fakes.
- Default-parallel `pnpm test`: 55 files passed, 8 failed; 1,008 tests passed, 5 timed out and 28 were skipped following hook timeouts. Every reported failure was a PGlite setup/test or ESLint timeout under load. These failures remain a full-suite verification limitation, not a passing full-suite claim.
- Next: independent review and current GitHub checks before any publication/merge decision. Required non-disclosing model configuration, deployed `lg` ownership, live redelivery and real-task E2E remain unverified. Keep the workflow flag false and intake held; Q12/Q13 and all existing decisions/holds above remain unchanged.

### Latest-main integration and model prerequisite — 20:27 UTC onward

- The Liaison subsequently supplied freshly fetched main `e530358cd43a654b4c43bf6ec817ce7ae427f632`: #28 is now merged; [deploy 40019332883](https://github.com/kentkodes/kentcrosswise/actions/runs/40019332883) was in progress when reported. This supersedes the earlier open-#28 table entry; deployed redelivery is still unverified.
- At 20:29 UTC the Liaison verified that deployment succeeded. Merged tree `9c286fe8252f0665309ac8fd0d2e361eef71c97f` exactly matched the local `git merge-tree` result for baseline `4b1e92586803042cc7b20e547f91fd692c04d21f` and the reviewed #28 head. AWS reported the sweeper update successful with `LastModified` 20:28:42 UTC. The scheduled live redelivery summary was still pending the 20:30 UTC sweep; deployment success alone does not verify redelivery.
- Merged that baseline into the owned #26 continuation after local preparation commit `a910eb8301834be62f1b3e7810c525f4c211571c`. The bundle-test overlap merged automatically, retaining the task-graph fake-model coverage and #28's sweeper assertions. Main's security boundary and Q12/Q13 remain unchanged.
- Integration checks passed by 20:29 UTC: lint, full typecheck, docs checker, all three Lambda bundle builds/load checks, orchestrator tests with two workers (12 files, 207 tests), and bundle integration with one worker (23 tests). No further full-suite run; the earlier timeout-only limitation remains recorded above.
- An owner-approved presence-only check reported `anthropic_api_key` missing or empty at 20:27 UTC. No value was disclosed. **#26 merge is blocked until the owner fills that setting and its prerequisite is rechecked.** This check and #28 approval authorize no model run, real task, workflow enablement or deployment of #26.
