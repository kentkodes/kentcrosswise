# Kentcrosswise: owner account setup

Current setup state consolidated 2026-10-25. [HANDOFF.md](HANDOFF.md) records evidence and holds; [OPEN-POINTS.md](OPEN-POINTS.md) lists remaining work. Vendor procedures and prices were researched on 2026-10-22 in [infra research](research/infra.md) and [API research](research/apis.md); verify them when executing a later setup step. This guide is an owner procedure and grants no agent authority to change accounts.

## Secrets and tools

Store fixed secrets directly in AWS Secrets Manager under the names and keys in [DESIGN §6](DESIGN.md#6-secrets-secrets-manager-one-json-secret-per-consumer-d19). Keep values out of chat, source, logs and GitHub secrets. Preview-only credentials use the scoped SSM exception. Use short-lived credentials in the current process when a command requires them. GitHub variables contain non-secret IDs only.

The project uses Node 24, pnpm 12, Terraform and AWS CLI v2; current commands are in [the canonical guide](agents/INSTRUCTIONS.md).

## Foundation already established

- Public repository `kentkodes/kentcrosswise`, production domain `kentcrosswise.com`, Terraform bootstrap/prod and per-PR preview/teardown have been used successfully.
- Neon production and separate synthetic CI projects exist. Production runtime logins, strict migrations and the public feed are wired. Relay login membership (`relay_rw=true`, `orch_rw=false`) and the accepted model-price row were independently verified during acceptance.
- Google owner sign-in is working. The earlier setup checklist records the OAuth app published In production; future Calendar/YouTube scopes and long-lived refresh-token behavior still need the incremental-consent checks below.
- Five separate GitHub Apps, Anthropic federation and isolated publisher roles/environments are established. The owner-authorized /healthz vertical slice passed through root and Docs-child merges/deployments on 2026-10-26, and U13 required-review counting passed on disposable PR #45. Remaining adversarial/failure cases are tracked in [OPEN-POINTS.md](OPEN-POINTS.md).
- Final main ruleset 25683184 is verified: one approval with stale dismissal, Actions and orchestrator-App required checks, squash only, no bypass. Final acceptance stop: `agents_paused=true`, `KCW_AGENT_WORKFLOWS_ENABLED=false`, `pipelines_paused=false`.
- Named IAM-user owner administration and MFA are verified while Free Tier credits remain; migrate to IAM Identity Center after they are exhausted.

## Immediate owner prerequisites

The named IAM user with MFA, the selected /healthz live slice and U13/final-ruleset steps are complete ([HANDOFF.md](HANDOFF.md)). Remaining:

1. Before any further live test, recheck current queue/DLQ counts, active workflow runs, stop controls and the workflow-enable flag. Retain the accepted [publisher security boundary](runbooks/agent-security-cutover.md); hard dollar caps are later work.
2. Recheck the historical normal-homepage cache gap and arrange authenticated targeted repair if still present. Review deployment content checks/invalidation as a follow-up.

Domain verification-email completion, renewal/billing health, the optional budget email alert, project-scoped Neon key availability and LangSmith/Jev account readiness are not freshly established by the documentation cleanup. Check them when needed; deployed infrastructure alone does not prove each account setting.

## Hub feature setup (Phase 3)

1. **Google Calendar and YouTube:** enable Google Calendar API, YouTube Data API v3 and YouTube Analytics API. Add incremental scopes `calendar.events.owned`, `youtube.readonly`, `yt-analytics.readonly`; request offline consent and store the refresh token in `kcw/prod/google-owner-token`. Verify production consent warnings/re-consent and token behavior.
2. **Instagram:** create/configure the Instagram Login app and tester account, verify development-mode access without App Review, and configure `https://kentcrosswise.com/api/instagram/callback`. The Instagram App ID/secret differ from the Meta app ID. Store credentials and long-lived token under `kcw/prod/social/instagram`; implement scheduled refresh before claiming connected metrics.
3. **TikTok:** make /terms and /privacy live, configure Login Kit/Display API and scopes `user.info.basic`, `user.info.stats`, `video.list`, then test the sandbox with the owner's target account. Confirm whether it returns real stats; manual entry is the accepted fallback if usable API access is unavailable. Production review feasibility remains open. Store rotating refresh tokens under `kcw/prod/social/tiktok`.
4. **Jev:** confirm self-serve access, numeric limits and the current OpenAPI request fields. Store the Typesafe key in `kcw/prod/models` under `typesafe_api_key`; retain deliberate model pinning and Haiku fallback.
5. **LangSmith and model runtime:** verify required runtime key/account readiness without exposing values; secret presence alone does not prove model calls or trace flushing.
6. **iPhone push:** build VAPID subscriptions, manifest/service worker and an in-app permission gesture; then test after Add to Home Screen on a supported iPhone. Store VAPID keys in `kcw/prod/web`.

## Operational references

Use [bootstrap](runbooks/bootstrap.md) for infrastructure procedures, [production DB](runbooks/prod-db.md) for runtime-role checks/rollback, and [GitHub Apps/settings](runbooks/github-apps.md) for rulesets. Existing account/resource creation should be reconciled before any procedure is rerun. [Research cost notes](research/infra.md) are dated estimates; U12 remains the current-pricing/free-tier verification item.
