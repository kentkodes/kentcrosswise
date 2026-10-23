# Kentcrosswise project handoff

**Current state — 2026-10-23 20:45 UTC:** #26 and #28 are merged and deployed; #26 passed all required CI and deployment smoke checks. The required model key is present, and post-deployment read-only metadata confirms the orchestrator login owns the checkpoint tables. There are no tasks or saved graph checkpoints. The GitHub workflow flag is false and real intake remains held; deployment does not establish real graph execution or paid model-key validity.

## Observation and provenance

- The Liaison supplied Git/GitHub, deployment, CloudWatch, queue and explicitly approved non-disclosing configuration/DB observations during the continuation of #28/#26. Local implementation verification is reported separately below.
- Canonical guide: [agents/INSTRUCTIONS.md](agents/INSTRUCTIONS.md); resume procedure: [agents/CONTINUITY.md](agents/CONTINUITY.md). Trusted configuration was read from fetched main, initially `4b1e92586803042cc7b20e547f91fd692c04d21f`, then integrated through `e530358cd43a654b4c43bf6ec817ce7ae427f632`.
- Earlier security rollout and canary details remain in Git history and the [cutover/rollback runbook](runbooks/agent-security-cutover.md). This record transfers context, not approval.

## Repository and refs

- Repository: `kentkodes/kentcrosswise`; remote `origin`; default branch `main`.
- Fresh main supplied from the Liaison's successful fetch after the #26 merge: `4c1ba44756591f374c09df0d76dec026317f013c`. The implementation session's own earlier fetch failed DNS; it used the Liaison's supplied fresh refs.
- #26 original task head: `78008996dc7a8ff441b4269c550a7d54d422230a`; reviewed continuation candidate: `a4f9328c6170cdf2ab6abb3a89e06a3b2284b9c6`; merged as `4c1ba44756591f374c09df0d76dec026317f013c`.
- Owned docs branch: `docs/orchestrator-rollout-handoff-20261023`, created from that fetched main; only `docs/HANDOFF.md` is changed in the follow-up working tree. The primary checkout and other sessions' work were preserved. Inspect the follow-up PR/Git state for its eventual containing commit.

## PRs and checks

| PR | Observed head / merge | State and evidence |
|---|---|---|
| [#28: sweeper PEM fix](https://github.com/kentkodes/kentcrosswise/pull/28) | reviewed head `9e314ffecb8f1d8434465d2ecd394a9a53e6c7ec`; merge `e530358cd43a654b4c43bf6ec817ce7ae427f632` | Merged; [deploy 40019332883](https://github.com/kentkodes/kentcrosswise/actions/runs/40019332883) succeeded, verified at 20:29 UTC |
| [#26: live graph wiring](https://github.com/kentkodes/kentcrosswise/pull/26) | reviewed head `a4f9328c6170cdf2ab6abb3a89e06a3b2284b9c6`; merge `4c1ba44756591f374c09df0d76dec026317f013c` | [CI 40019704227](https://github.com/kentkodes/kentcrosswise/actions/runs/40019704227): all four jobs succeeded, including preview Playwright/teardown and `ci/required`; merged at 20:42:51 UTC |
| [#29: secure workflows](https://github.com/kentkodes/kentcrosswise/pull/29) | merge `30c98e3c27ce74a0dd10be64691826af8ef024d0` | Merged and deployed; accepted Q14/Q15 isolation/governance boundary |
| [#32: publisher-key fix](https://github.com/kentkodes/kentcrosswise/pull/32) | merge `d4dde25eaef44e7b7e1aa0e4bb9c2572f0f05036` | Merged and deployed; App publishing verified |
| [#34: QA context follow-up](https://github.com/kentkodes/kentcrosswise/pull/34) | merge `afb5cca66bb914b367296b6fcf544541a415f1be` | Merged and deployed; independent QA canary succeeded |
| [#33: disposable canary](https://github.com/kentkodes/kentcrosswise/pull/33) | `c17e970dbda48af2180fd242d00b23e7502127fd` | Closed unmerged after green CI and QA approval from a separate App at the unchanged head; issue #31 closed and task branch deleted |

#30 was closed as superseded by #29. The canary's preview cleanup passed; it created no DB task and did not establish real automatic orchestration.

- #28 merged tree `9c286fe8252f0665309ac8fd0d2e361eef71c97f` exactly matched the local `git merge-tree` result for `4b1e92586803042cc7b20e547f91fd692c04d21f` and the reviewed #28 head.
- #26 merged tree `cba1d0f9900b3e83de5701da0c87d00ee78f5d2a` exactly equals reviewed candidate `a4f9328c6170cdf2ab6abb3a89e06a3b2284b9c6`.
- #26 deployment [40021344460](https://github.com/kentkodes/kentcrosswise/actions/runs/40021344460) for merge `4c1ba44756591f374c09df0d76dec026317f013c` succeeded, including smoke checks, verified at 20:45 UTC. AWS reported orchestrator `LastUpdateStatus: Successful`, `LastModified: 20:44:16 UTC`, and `CodeSha256: hgPakOy3WBIVeA6JJ0mO06dxrOSeCTJy+1msN8WcW6c=`.

## Ownership and changes

- The implementation writer owned #26's orchestrator graph/Lambda/usage integration, its tests and task-specific handoff facts. The docs-only follow-up owns this handoff; preserve other writers' changes when applying it.
- Deployed #26 wires the task graph, GitHub client, model planner and per-task usage into Lambda and removes the skeleton. Missing model/App/DB configuration returns the batch to SQS. Integration retained #28's PEM/sweeper fixes and bundle assertions. No graph task has been invoked to verify this behavior live.
- Main's canonical root entrypoint, security workflows, governance/infra/lockfile contents, fresh-CI/QA-on-new-commit behavior and Q12/Q13 design text were preserved. No workflow enablement or real task/model run was added by the continuation.

## Verification

- Local integration atop `e530358` passed by 20:29 UTC: frozen offline dependency installation with lifecycle scripts disabled; `pnpm lint`; `pnpm typecheck`; `node scripts/check-agent-docs.mjs`; `pnpm build-lambdas` (all three bundles load); `pnpm vitest run --project @kcw/orchestrator --maxWorkers 2` (**207 tests**); `pnpm vitest run --project @kcw/scripts scripts/test/lambda-bundle.test.ts --maxWorkers 1` (**23 tests**). Services and model responses were local fakes. Final docs-only changes passed the checker and diff check.
- Historical local full-suite limitation: the initial default-parallel `pnpm test` reported 1,008 passes, 5 test timeouts and 5 suite-hook timeouts under PGlite/ESLint load (28 skipped; 55/63 files passed). Affected bounded suites passed; no later local full-suite pass is claimed. Current CI code checks passed separately at the candidate SHA.
- #26 prod-plan summary: format `1`, `infra: []`, **21 build-artifact changes**. This describes planned changes, not deployed behavior.
- #28 sweeper Lambda update: AWS reported successful status and `LastModified` 20:28:42 UTC. The scheduled 20:30:30 UTC sweep completed with no failed parts and `redelivered: 0`. This verifies the scheduled path succeeded with no retry work; it does **not** prove retry of an actual failed delivery.
- After the owner saved the model key, an approved presence-only check confirmed `anthropic_api_key` nonempty. No secret value was disclosed; this establishes presence, not paid API/model operation.
- Approved read-only DB metadata checks, including an identical post-deployment rerun at 20:45 UTC: `current_user = orch_app`; `lg.checkpoint_blobs`, `lg.checkpoint_migrations`, `lg.checkpoint_writes` and `lg.checkpoints` are owned by `orch_app`; tasks **0**; checkpoints/writes/blobs **0**; checkpoint migrations **6**. No task/checkpoint content or identifiers were read and no setup/write ran. Runtime login ownership is verified; persisted real-task interrupt/resume remains unverified.
- At 20:45 UTC the orchestrator queue and DLQ each had all three counts zero; GitHub `KCW_AGENT_WORKFLOWS_ENABLED` was false. The DB Agents/Pipelines controls are separate and were not changed.
- Post-deployment verification covers deployment smoke checks, Lambda update metadata, read-only DB ownership/counts and queue/flag state. No graph invocation, paid model call, real task or workflow enablement was performed; model-key validity and runtime graph E2E remain unverified.

## Decisions and security holds

- Q14/Q15 isolation rollout, stronger governance/import/configuration/all-lockfile policy, publisher key fix and independent Developer/QA canary are verified. The retired shared-role boundary and isolated App identities remain in force. Earlier probes and the canary do not authorize real intake.
- Q12 remains pending: 1–5 nonrecursive subtasks; parent waits outside the in-flight limit; bounded retry/escalation. Q13 remains pending despite historical resolved placement: stored/effective-date cost or “no price,” deduped wall-clock Actions minutes without duplicates, UTC ranges. See [DESIGN §11](DESIGN.md#11-spec-conflicts-and-open-questions); semantics were not changed.
- U13/final ruleset and model pricing remain open ([DESIGN §10](DESIGN.md#10-unverified-items-status)); relay still uses interim `orch_rw` pending a narrower approved role.
- Native adapter runtime loading and Docs/Scraper model execution remain unverified. Actual failed-delivery retry, paid graph execution, real task persistence/interrupt/resume and full [P2-18 console → issue → PR → QA → merge → deploy E2E](DESIGN.md#8-phase-2-agent-system-local-sub-agents) remain open.
- Authorization covers the original conditional #26 continuation and the separately approved #28/log, presence-only and read-only metadata checks within their conditions. Keep GitHub workflows disabled and real intake held; no further canary, paid task or workflow enablement is implied. Recheck exact current authorization before dependent external actions.

## Remaining work and next action

1. Publish this factual docs-only follow-up through ordinary review/CI. Exact reviewed/merged tree equality and deployment success are verified; keep deployment and live-task claims distinct. Keep local/private context outside the public repository.
2. Resolve remaining owner decisions before a controlled graph test. Such a test needs separate authorization defining task/model scope and verification; no live test follows automatically from this rollout.
3. Keep `KCW_AGENT_WORKFLOWS_ENABLED=false` and real intake held pending user readiness and a specifically scoped decision. Do not create a paid graph task merely to close verification gaps.
4. Resolve Q12/Q13, U13/final ruleset, model prices and relay role with the owner; separately scope actual redelivery, native adapter/Docs/Scraper and P2-18 validation.
