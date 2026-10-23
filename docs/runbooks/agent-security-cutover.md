# Agent publisher security cutover (Q14/Q15 proposal)

This is reviewable source preparation, **pending owner approval before merge and live rollout**. No AWS or GitHub setting was changed and no live negative test was performed during preparation. The approved product SPEC is unchanged. The proposed critical-change policy supersedes historical D8 treatment of behavior/governance instruction documents: neutral/native instructions, canonical `docs/agents/**` and trusted automation now require owner review. Factual `docs/HANDOFF.md`, ordinary research and routine design status remain ordinarily noncritical; other existing critical rules still apply. This policy proposal requires an explicit owner decision.

Trusted automation includes its command/resolver configuration and the core event parser imported by reporting, so an indirect dependency change also requires owner review.

All `pnpm-lock.yaml` updates now require owner review, including version, tarball or integrity updates for preapproved dependency names. A frozen install validates consistency with the lockfile; it does not establish that the selected runtime code is trusted. This deliberately strengthens the historical dependency policy and requires explicit owner acceptance before merge. The approved product SPEC is unchanged.

Source verification on 2026-10-23: IAM and merge-rules source contracts passed (184 tests), and bootstrap formatting passed. The Liaison independently reported successful backend-disabled Terraform validation using the pinned provider on the host after sandboxed provider startup failed. This is no evidence of effective live IAM, deployed environment protection or successful negative probes. No live plan had run at that earlier validation stage; the separately authorized plan below is the later evidence.

## Boundary to approve

The untrusted `work` job runs on a fresh hosted runner, without an environment and without AWS trust. Its main-ref OIDC subject must be denied by every repository AWS role. Its Anthropic federation does not grant AWS credentials. A fresh protected start runner reports coding/qa_reviewing before work. A separate fresh `publish` runner checks out trusted `main`, consumes artifacts as untrusted data, validates them through trusted helpers, and obtains only its own publisher identity. Never execute scripts/configuration from a downloaded commit bundle or artifact, load artifact-controlled environment variables, reuse a work runner, or fall back to the legacy shared role.

| Publisher environment | AWS role | GitHub variable |
| --- | --- | --- |
| `agent-publish-developer` | `kcw-gh-agent-developer` | `AWS_ROLE_AGENT_DEVELOPER_ARN` |
| `agent-publish-qa` | `kcw-gh-agent-qa` | `AWS_ROLE_AGENT_QA_ARN` |
| `agent-publish-scraper` | `kcw-gh-agent-scraper` | `AWS_ROLE_AGENT_SCRAPER_ARN` |
| `agent-publish-docs` | `kcw-gh-agent-docs` | `AWS_ROLE_AGENT_DOCS_ARN` |

Each role trusts only `sts.amazonaws.com` as audience and the exact subject `${local.github_sub}:environment:agent-publish-<agent>`, where the existing immutable identity is `repo:${var.github_owner}@${var.github_owner_id}/${var.github_repo}@${var.github_repo_id}`. Preserve the current owner/repository IDs and account/region inputs; do not substitute a mutable-name-only subject. Environment subjects replace the branch component: the AWS trust does **not** itself assert `main`. Configure GitHub environment deployment protection to allow the exact `main` branch only, with no tags and no other branch patterns. GitHub environments created by a workflow name alone are **unprotected** and must not be treated as ready. See [GitHub OIDC for AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws) and [AWS GitHub OIDC trust guidance](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-idp_oidc.html). AWS does not support GitHub custom OIDC claims as an alternative safeguard.

Each publisher's permission policy contains only existing actions: `secretsmanager:GetSecretValue` for `kcw/github/<agent>-app` (the ARN's six-character Secrets Manager suffix is matched by `??????`) and `sqs:SendMessage` to the existing orchestrator queue. No other App keys, `sts:AssumeRole`, broad secret wildcard or extra service action is allowed. CI, plan and deploy roles retain their existing trust and permissions.


Source lifecycle details: required payload entrypoints, canonical agent Markdown and the nested web guide are restored only from pinned trusted configuration after removing all PR-controlled discovery files; other native settings remain stripped. Missing handoff and security-cutover link targets on older task heads are filled from pinned trusted source without replacing existing factual task copies. Tracked restored paths retain skip-worktree, while paths absent from the task index are locally excluded from broad staging. Work and independent review upload only bounded advisory usage, including after model failure; missing/malformed execution files produce no usage and cannot suppress trusted lifecycle reporting. Developer/Scraper no-op without an existing validated task PR fails; an unchanged validated fix PR may complete. QA test commits defer approval and return the task graph through fresh CI and independent review at the new head.

## Offline review and owner-led plan

Use an owned, fetched task worktree and record its exact SHA and reviewed merge base. The source checks need no credentials:

```powershell
pnpm vitest run --project @kcw/merge-rules agents/merge-rules/test/evaluate.test.ts
pnpm vitest run --project @kcw/scripts scripts/test/agent-iam.test.ts scripts/test/agent-workflows.test.ts scripts/test/agent-pipeline.test.ts
terraform -chdir=infra/bootstrap fmt -check
# Only when this owned directory already has initialized providers/backend metadata:
terraform -chdir=infra/bootstrap validate
```

Do not initialize or migrate an unfamiliar backend, copy state, read secret values, or dump `terraform show -json`. Offline validation verifies syntax/schema only, not effective IAM or GitHub protection.

Only the owner or an explicitly authorized operator may run a live, read-only plan against the verified existing bootstrap backend and account. The following is a **placeholder**, not an instruction to execute with guessed credentials or account inputs:

```powershell
$env:AWS_PROFILE = '<owner-approved-profile-for-existing-bootstrap-account>'
terraform -chdir=infra/bootstrap plan -input=false -var-file='<existing-owner-reviewed-nonsecret-input-file>'
```

Inspect the human-readable plan privately; do not upload raw state, binary plans, plan JSON, secret values or credential logs. Expected IAM changes: four isolated roles and inline policies are created; shared `aws_iam_role.github["kcw-gh-agent"]` and its inline policy are removed; the shared output variable is replaced by four scoped variables. Any other infrastructure change, immutable identity drift, CI/plan/deploy policy expansion, unexpected state address or secret-value change stops rollout for review. The separately authorized read-only plan completed with the exact expected 8-add/0-change/2-destroy result recorded below. It does not authorize apply or prove effective live controls.


## Observed read-only plan (2026-10-23)

The user explicitly authorized the Liaison's read-only plan with `kc-admin`; that step is complete and does not require another permission question solely because a session/model changed. At source `567f842a00c8f948a58ec97d68f92f9db9f32460`, account `619888736396`, `us-east-1`, domain `kentcrosswise.com`, using the existing S3 backend key `bootstrap.tfstate`, Terraform reported **8 add, 0 change, 2 destroy**. This adds the four per-agent roles and their four inline policies, and removes only the shared legacy role and its policy.

Rendered trust was checked for every role: audience `sts.amazonaws.com` and exact immutable subject `repo:kentkodes@107236483/kentcrosswise@1430035147:environment:agent-publish-<role>`. Each policy permits only its own App secret `secretsmanager:GetSecretValue` and the existing orchestrator queue `sqs:SendMessage`. No unexpected infrastructure or role-permission expansion appeared. Plan/rendered-source inspection is not a live positive/negative security probe.

CI at this source had checks and prod-plan green, with preview pending at observation; PR #30 at `2ed0b6e9110f5162e8f7cf75358efd3143c78c9a` was all green. No secret values were read by the plan, and no bootstrap/production apply, settings change, merge, agent dispatch or live probe was performed by this task. Standard PR CI independently runs temporary preview deployment and teardown. Source/policy acceptance and the separately authorized ordered rollout remain the next gates. Keep private plan artifacts and raw credential/state material outside this public record.

## Ordered rollout — separate owner authorization required

1. Approve Q14 behavior, Q15 isolation and the expanded critical-path policy at the exact proposed head. Keep `KCW_AGENT_WORKFLOWS_ENABLED` absent or a value other than the literal `true` throughout preparation. Pause/disable existing legacy agent workflows through owner controls and cancel/drain outstanding legacy runs **before** applying or merging the new security boundary. Existing deployed legacy workflows do not gain a new source flag until updated, so the flag alone cannot stop them.
2. Create and explicitly protect all four environments above. Select only the exact `main` branch for deployments; exclude tags. Review access/reviewer controls and reject any unexpected environment. Verify configuration directly before any workflow can use it. Do not rely on auto-creation, a naming convention, or the presence of a role ARN variable as protection.
3. Review the recorded bootstrap plan at its exact source/account/backend and approve the exact live change separately. The authorized read-only plan is already complete; refresh the plan only if relevant source or live-state assumptions change. With all agent execution disabled, the owner applies the reviewed source through the existing bootstrap procedure. No automated apply script is supplied. Verify all four policies and exact trust subjects, and verify the legacy shared main-ref role grant and inline policy are gone. There is no compatibility role/output fallback.
4. Address credentials issued before retirement: trust-policy changes alone are not evidence that an outstanding STS session is unusable. The owner must review active-session exposure and follow verified AWS revocation guidance or wait for the verified maximum lifetime of outstanding legacy credentials before enablement. Record the cutoff and evidence; never infer session expiry merely from a cancelled workflow. See [AWS role session revocation](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_revoke-sessions.html); no revocation operation was performed here.
5. Set each scoped GitHub variable from its reviewed Terraform output, verify role/environment correspondence, and remove `AWS_ROLE_AGENT_ARN`. Merge only after the owner's review and required checks; ensure the secure workflows, trusted helpers, critical-path gate and disabled enable flag land together. Keep all four new environments protected and agents disabled while checking the merged SHA and runner separation.
6. Run the explicitly authorized live verification below using a controlled probe, with no model execution or untrusted code. Record only pass/fail, subjects/role names and audit identifiers; suppress tokens, PEMs and secret-response values. An engineer must review the probe and its temporary branch/environment settings before any dispatch. Do not create arbitrary broadly trusted environments, relax branch protection, or merge an approval-bypass probe.
7. After successful negative/positive verification, explicit owner acceptance and confirmation that old sessions are closed, set `KCW_AGENT_WORKFLOWS_ENABLED=true`. Run the owner-approved toy-issue/QA test first. Real task intake remains held until its results are reviewed. If anything fails, disable the workflows/flag again; do not restore the shared main-ref role as rollback.

## Required live verification (not performed)

Use the exact protected environments and approved branch, then verify every matrix cell:

| OIDC context | Expected result |
| --- | --- |
| Work job, no environment, `ref:refs/heads/main` | Cannot assume any publisher, CI, plan or deploy role |
| Each publisher environment on `main` | Can assume exactly its corresponding publisher role; all other publisher roles denied |
| Each publisher role | Can read only its own App key; the other three App keys denied |
| Each publisher role | Can send a controlled message to the existing orchestrator queue only; no role chaining |
| Non-main branch or a tag using a publisher environment | GitHub blocks deployment before AWS credentials can be issued |
| Missing/misspelled environment or wrong audience/subject | AWS assumption denied; no fallback |

Positive own-key checks, if separately authorized, must discard secret bodies without logging them. Test reporting in a controlled fixture so no unintended orchestration begins. Source contracts are not evidence that these live results passed. Store a redacted verification record with exact source SHA, time, operator, account/region, environment restrictions and pass/fail before enabling.
