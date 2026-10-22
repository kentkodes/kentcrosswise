# Runbook: GitHub repo settings and Apps (owner)

For the owner (or the Liaison with the owner's `gh` login). Covers the `main` ruleset (P1-17, DESIGN §4.1). The GitHub Apps and the Claude Console federation (P2-07) are added here in Phase 2.

Commands are PowerShell from the repo root. They need `gh` logged in as a repo admin; the token is handed to the script through an environment variable of this shell only and never printed.

## 1. The `main` ruleset

Expected definitions live in [scripts/repo-settings/](../../scripts/repo-settings/), in the shape of GitHub's ruleset API:

| Profile | File | When | What |
|---|---|---|---|
| `interim` | `main-protection.interim.json` | start of Phase 2 until P2-07 | PR required, 0 approvals, required check `ci/required` (source: GitHub Actions), squash only, no force pushes, no deletion, empty bypass list |
| `final` | `main-protection.json` | from P2-07 on | the same, plus 1 approval with stale approvals dismissed, plus required check `kcw/merge-rules` (source: the orchestrator App). "Require approval of the most recent reviewable push" stays off (QA pushes tests, then approves) |

The interim profile exists because nobody can approve the owner's own PRs until the QA App exists, and no App posts `kcw/merge-rules` before the orchestrator runs. With an empty bypass list, the final profile would block every merge before P2-07.

**Once the ruleset exists, every change to `main` goes through a pull request** (squash merge, after `ci/required` is green), including the Liaison's and the owner's own changes. Direct pushes to `main` are refused.

### Apply (start of Phase 2)

```powershell
$env:GH_TOKEN = gh auth token
pnpm apply-repo-settings --profile interim --dry-run     # shows the body; changes nothing
pnpm apply-repo-settings --profile interim
pnpm check-repo-settings --profile interim               # must print "matches the interim profile"
gh variable set KCW_RULESET_PROFILE --body interim --repo kentkodes/kentcrosswise
Remove-Item Env:GH_TOKEN
```

Same with plain `gh` instead of the script (interim only; the final file contains a placeholder for the App id):

```powershell
gh api -X POST repos/kentkodes/kentcrosswise/rulesets --input scripts/repo-settings/main-protection.interim.json
```

### Switch to the final profile (P2-07, after the Apps exist)

```powershell
$env:GH_TOKEN = gh auth token
gh variable set KCW_ORCHESTRATOR_APP_ID --body "<orchestrator App id>" --repo kentkodes/kentcrosswise
pnpm apply-repo-settings --profile final --orchestrator-app-id <orchestrator App id> --dry-run
pnpm apply-repo-settings --profile final --orchestrator-app-id <orchestrator App id>
pnpm check-repo-settings --profile final --orchestrator-app-id <orchestrator App id>
gh variable set KCW_RULESET_PROFILE --body final --repo kentkodes/kentcrosswise
Remove-Item Env:GH_TOKEN
```

The App id (a number) is on the App's settings page ("App ID"); it is not secret.

### Drift check

`ci.yml` runs `pnpm check-repo-settings --profile <KCW_RULESET_PROFILE, default interim>` on every PR as a non-blocking step. It reads the ruleset with the workflow token; GitHub may hide the bypass list from tokens without admin rights, in which case the check prints a warning instead of comparing it. Make the step blocking (drop `continue-on-error`) once the final profile is applied.

Unverified until the first live run: that `15368` is the GitHub Actions App id GitHub expects as the source of `ci/required` (a wrong id would leave `ci/required` pending forever: re-apply without it to recover).

