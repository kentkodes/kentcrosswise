# kentcrosswise: infrastructure setup research (verified 2026-10-22)

Scope: research only. Nothing was created or changed. Every step cites a source. "UNVERIFIED" means I could not confirm it from an official source today.

Version snapshot (from `git ls-remote` / registry APIs on 2026-10-22):

| Thing | Latest seen | Source |
|---|---|---|
| aws-actions/configure-aws-credentials | v6.3.0 | https://github.com/aws-actions/configure-aws-credentials |
| aws-actions/aws-secretsmanager-get-secrets | v3.0.2 | https://github.com/aws-actions/aws-secretsmanager-get-secrets |
| actions/create-github-app-token | v3.3.0 | https://github.com/actions/create-github-app-token |
| anthropics/claude-code-action | v1 (v1.0.258) | https://github.com/anthropics/claude-code-action |
| neondatabase/create-branch-action | v6.4.0 | https://github.com/neondatabase/create-branch-action |
| Terraform CLI | 1.17.0 (winget manifest still 1.16.6) | https://developer.hashicorp.com/terraform/install |
| @opennextjs/aws (npm) | 4.1.12 | `npm view @opennextjs/aws` |
| next (npm) | 16.4.2 | `npm view next` |
| RJPearson94/terraform-aws-open-next | v3.7.1 (2026-07-12) | https://github.com/RJPearson94/terraform-aws-open-next |
| nhs-england-tools/terraform-aws-opennext | v1.0.7 (2026-10-08) | https://github.com/nhs-england-tools/terraform-aws-opennext |
| kislerdm/neon Terraform provider | v0.18.0, **repo archived 2026-09-11** | https://github.com/kislerdm/terraform-provider-neon |

---

## 1. AWS account hardening (solo developer)

### 1a. Root user MFA
1. Sign in as root at https://console.aws.amazon.com/ → account name (top right) → **Security credentials** → under **Multi-factor authentication (MFA)** choose **Assign MFA device** → enter a device name, choose **Passkey or Security Key** (recommended) → follow the browser prompt → **Continue**. Source: https://docs.aws.amazon.com/IAM/latest/UserGuide/enable-fido-mfa-for-root.html
2. Supported types: passkey or security key (recommended, phishing-resistant), virtual authenticator app (TOTP), hardware TOTP. Source: https://docs.aws.amazon.com/IAM/latest/UserGuide/enable-mfa-for-root.html
3. Before enabling, check the account email and phone are current (they are the recovery path if the MFA device is lost). Same source.

Gotchas:
- MFA on root is now **mandatory** for all account types; it must be registered within 14 days of the first console sign-in attempt. Source: https://docs.aws.amazon.com/IAM/latest/UserGuide/enable-mfa-for-root.html
- Do **not** use an `@kentcrosswise.com` address as the root email for this same account. If the account is suspended, the domain is suspended, and you can no longer recover the root password. Keep root on an external email (e.g. Gmail). Source: https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/domain-register.html
- Cost: free.

### 1b. Admin identity: recommendation
**Recommend IAM Identity Center (organization instance) with an AdministratorAccess permission set**, *unless* the account is still on the AWS **Free plan** and you want to keep its credits. In that case use an IAM user with MFA (see "Alternative" below).

Why it matters: enabling an organization instance on a standalone account creates an AWS Organization, with this account as the management account. The docs say: "If you use a free tier account, creating an AWS organization automatically upgrades your account to a paid plan with pay-as-you-go pricing. Your free tier credits expire immediately." An *account instance* does not give AWS-account (console/CLI) access, only application assignments, so it doesn't help here. Source: https://docs.aws.amazon.com/singlesignon/latest/userguide/enable-identity-center.html

Steps (organization instance):
1. Open the IAM Identity Center console (https://console.aws.amazon.com/singlesignon) **in the Region you want to keep it in**. Choose the Region carefully: changing it later means deleting and recreating the instance. Pick e.g. `us-east-1`. Source: https://docs.aws.amazon.com/singlesignon/latest/userguide/enable-identity-center.html
2. If shown, **Instance configuration** → **Single-Region instance**. Multi-Region creates a customer managed KMS key, which costs money. → **Enable** → on **Enable IAM Identity Center with AWS Organizations** → **Enable**. Same source.
3. **Users** → **Add user**. Username (cannot be changed later), email, name. Choose **Send an email to this user with password setup instructions**. → **Create group** `Admins` → add the user to it → **Add user**. Source: https://docs.aws.amazon.com/singlesignon/latest/userguide/quick-start-default-idc.html
4. **Multi-account permissions → AWS accounts** → tick the management account → **Assign users or groups** → group `Admins` → **Create permission set** → **Predefined permission set** → **AdministratorAccess** → keep defaults (1 h session) → **Create** → back, refresh, select it → **Submit**. Same source.
5. Accept the email invitation, set a password, and register MFA. Record the **AWS access portal URL** (start URL) from the email. Same source.
6. Optional least-privilege step: also create and assign a `PowerUserAccess` set and use it day to day. Sources: https://docs.aws.amazon.com/singlesignon/latest/userguide/quick-start-default-idc.html and https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html

Cost: no IAM Identity Center charge for this use. UNVERIFIED: I did not fetch an Identity Center pricing page. AWS Organizations is free (UNVERIFIED, not fetched), but note the Free-plan upgrade above.

Alternative (IAM user): IAM console → Users → create a user with console access, attach `AdministratorAccess`, enable MFA. For the CLI you would then need long-lived access keys, which is weaker than SSO. UNVERIFIED: this click path was not re-fetched today.

### 1c. AWS CLI v2 on Windows with SSO
1. Install AWS CLI v2. Must be >= 2.22.0 for the default PKCE browser flow. Source: https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html
2. Run `aws configure sso` and answer:
   - `SSO session name`: `kentcrosswise`
   - `SSO start URL`: the access portal URL from step 1b.5 (`https://<id>.awsapps.com/start`)
   - `SSO region`: the Identity Center Region (e.g. `us-east-1`)
   - `SSO registration scopes`: `sso:account:access`

   The browser opens. Approve the `botocore-client-...` prompt, pick the account and role, then set `Default client Region` (e.g. `us-east-1`), output `json`, and profile name (e.g. `kc-admin`). Source: https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html
3. Daily use: `aws sso login --profile kc-admin`, then `aws sts get-caller-identity --profile kc-admin`. Add `--use-device-code` only if the browser flow fails. Same source.
4. Terraform and the AWS SDK read the same profile: set `AWS_PROFILE=kc-admin`. UNVERIFIED: standard SDK behaviour, not re-fetched today.

### 1d. Billing alert (alert only, no cap)
1. Billing and Cost Management console (https://console.aws.amazon.com/cost-management/) → **Budgets** → **Create budget** → **Use a template (simplified)** → **Monthly cost budget** (or **Zero spend budget** to get an alert on any spend) → enter the amount (e.g. `$20`) and your email → **Create budget**. Source: https://docs.aws.amazon.com/cost-management/latest/userguide/budget-templates.html
2. The monthly template alerts on actual and forecasted overspend. UNVERIFIED: the exact default thresholds (commonly 85% actual / 100% actual / 100% forecasted) were not stated on the page I read.
3. Budgets only notify. They do not stop spending unless you configure "budget actions" (don't). Notifications are free. Action-enabled budgets: first two free, then $0.10/day each. Reports cost $0.01 each. Source: https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/

---

## 2. Route 53 domain `kentcrosswise.com`

1. Route 53 console (https://console.aws.amazon.com/route53/) → **Domains → Registered domains → Register domains** → search `kentcrosswise.com` → select → **Proceed to checkout**. Source: https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/domain-register.html
2. **Pricing** page: 1 year, **Auto-renew ON** (recommended; renewals are non-refundable). → **Next**. Same source.
3. **Contact information**: use your legal name (some registries need ID proof later). Keep **Privacy protection** on (hides WHOIS). → **Next** → accept terms → **Submit**. Same source.
4. **Domains → Requests**: click the verification link in the registrant-email message (from `noreply@registrar.amazon` or a Gandi address). If it isn't verified, the domain is **suspended** per ICANN. Same source.
5. Route 53 **automatically creates a public hosted zone** for the domain. If Terraform should manage the zone, import that zone into Terraform (`terraform import`). Do not create a second zone; if you do, you must repoint the domain's name servers. Same source.

Cost:
- `.com` registration/renewal: **$16.00/year** (raised from $15 on **July 1, 2026**). Transfer is also $16. Source: Route 53 domain pricing PDF, "Updated Pricing – Effective July 1, 2026": https://d32ze2gidvkk54.cloudfront.net/Amazon_Route_53_Domain_Registration_Pricing_20140731.pdf
- Hosted zone **$0.50/month**. Standard queries $0.40 per million. **Alias queries to CloudFront are free.** Source: https://aws.amazon.com/route53/pricing/
- AWS promotional credits cannot pay domain fees. Source: https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/domain-register.html

ACM certificate for CloudFront:
- Request (or import) the certificate in **`us-east-1`** (N. Virginia), whatever Region the rest of the stack uses. In Terraform, use a second `aws` provider with `alias = "us_east_1"`. Source: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html
- The certificate's SAN must cover each alternate domain on the distribution (e.g. `kentcrosswise.com` and `*.kentcrosswise.com` or `www`). Same source.
- Public, non-exportable ACM certificates cost **$0** for integrated services. Exportable ones cost $7 per FQDN. Source: https://aws.amazon.com/certificate-manager/pricing/ (the page doesn't name CloudFront explicitly; CloudFront is an ACM-integrated service per the CloudFront doc above).
- Use DNS validation via Route 53 records (`aws_acm_certificate_validation`). UNVERIFIED: standard practice, no page fetched.

---

## 3. GitHub Actions → AWS via OIDC

### Identity provider (one per AWS account)
1. IAM console → **Identity providers** → **Add provider** → **OpenID Connect**.
   - Provider URL: `https://token.actions.githubusercontent.com`
   - Audience: `sts.amazonaws.com`

   → **Add provider**. Sources: https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html and https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws
2. Thumbprint: not needed. configure-aws-credentials says it "is no longer necessary... will be ignored". In Terraform `aws_iam_openid_connect_provider`, omit it or leave it empty. Source: https://github.com/aws-actions/configure-aws-credentials

### IAM role trust policy scoped to one repo
**Important (new in 2026):** repositories created after **July 15, 2026** use an *immutable* `sub` claim that includes numeric owner and repo IDs:
`repo:OWNER@OWNER_ID/REPO@REPO_ID:ref:refs/heads/main`. Existing repos keep the old format unless opted in, and renames or transfers after that date also switch. The new `kentcrosswise` repo will therefore use the **new** format. Sources: https://docs.github.com/en/actions/reference/security/oidc and https://github.blog/changelog/2026-04-23-immutable-subject-claims-for-github-actions-oidc-tokens

Trust policy conditions (fill in IDs; get them with `gh api repos/OWNER/kentcrosswise --jq '.owner.id, .id'`). UNVERIFIED: that command is my suggestion; the docs don't say how to look up the IDs.

```json
"Condition": {
  "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
  "StringLike":   { "token.actions.githubusercontent.com:sub": "repo:OWNER@OWNER_ID/kentcrosswise@REPO_ID:*" }
}
```

Recommended split (two roles):
- **deploy role**: `sub` = `repo:OWNER@OWNER_ID/kentcrosswise@REPO_ID:ref:refs/heads/main` or `...:environment:production`.
- **PR/preview role**: `...:pull_request`, with read-only and preview permissions.

The `pull_request` form applies only when the job doesn't use an environment. If a job uses `environment:`, the sub becomes `...:environment:NAME`. Source: https://docs.github.com/en/actions/reference/security/oidc (immutable examples there are shown only for branches; the environment and pull_request immutable forms are UNVERIFIED but follow the same prefix).

GitHub states you **must** set at least one condition, or other repos could assume the role. Source: https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws

### Workflow
```yaml
permissions:
  id-token: write
  contents: read
steps:
  - uses: aws-actions/configure-aws-credentials@v6.3.0   # or pin to commit SHA
    with:
      role-to-assume: arn:aws:iam::<ACCOUNT_ID>:role/kc-github-deploy
      aws-region: us-east-1
  - uses: aws-actions/aws-secretsmanager-get-secrets@v3
    with:
      secret-ids: |
        ANTHROPIC_API_KEY, kentcrosswise/anthropic-api-key
        NEON, kentcrosswise/neon
      parse-json-secrets: true
```
Sources: https://github.com/aws-actions/configure-aws-credentials and https://github.com/aws-actions/aws-secretsmanager-get-secrets

Secrets Manager action behaviour:
- Inputs are `secret-ids` (name, ARN, or prefix with `*`, at least 3 characters before it, up to 100 matches), `name-transformation` (default `uppercase`), and `parse-json-secrets` (default false).
- `ALIAS, secretId` sets the env var name. JSON keys become `ALIAS_KEY`.
- Values are exported as **masked env vars for all later steps in the job**. Debug logging shows the variable names.
- The role needs `secretsmanager:GetSecretValue` (plus `ListSecrets` if you use prefixes). UNVERIFIED: the IAM permission list was not on the page I read.

Source: https://github.com/aws-actions/aws-secretsmanager-get-secrets

Gotchas:
- Secrets are scoped per **job**. Every job that needs them must repeat the OIDC and get-secrets steps.
- Public repo: PRs from **forks** don't get secrets, and the GitHub docs say so explicitly for the Claude review workflow. Source: https://code.claude.com/docs/en/github-actions. UNVERIFIED: whether fork PRs can mint an OIDC `id-token`; assume no. All agent PRs come from same-repo branches, so this is fine.
- Cost: OIDC and STS are free. Secrets Manager is about $0.40 per secret per month plus $0.05 per 10k API calls. UNVERIFIED: pricing page not fetched.

---

## 4. GitHub Apps as agents

### Create (one per agent: developer, qa, docs, scraper-builder, merge-bot)
1. GitHub → profile picture → **Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**. Source: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app
2. **GitHub App name**: unique across GitHub, **max 34 characters** (e.g. `kentcrosswise-dev`, `kentcrosswise-qa`). Homepage URL: the repo URL. Leave Callback URL, Setup URL and Device Flow empty. Same source.
3. **Webhook**: **untick Active**. These apps are driven by Actions workflows, not by a server, so no URL or secret is needed. If you ever do enable it, set a webhook secret and keep SSL verification on. Same source.
4. **Repository permissions** (minimum per need). Source: https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps

   | Need | Permission |
   |---|---|
   | push branches, create refs | **Contents: Read & write** |
   | open PRs | **Pull requests: Read & write** |
   | review / approve PRs | **Pull requests: Read & write** |
   | merge PRs (`PUT /pulls/{n}/merge`) | **Contents: Read & write** |
   | create issues | **Issues: Read & write** |
   | read check runs | **Checks: Read** |
   | read commit statuses | **Commit statuses: Read** |
   | trigger `workflow_dispatch` | **Actions: Read & write** |
   | create or edit `.github/workflows/*` | **Workflows: Read & write** (in addition to Contents) |
   | always | Metadata: Read (mandatory) |

   Suggested per app:
   - developer: Contents RW, PRs RW, Issues RW, Checks R, Statuses R, Actions RW. Add Workflows RW only if it must edit CI.
   - qa: PRs RW, Contents R, Checks R, Statuses R, Issues RW.
   - docs: Contents RW, PRs RW.
   - scraper-builder: like developer.
   - merge-bot: Contents RW, PRs RW, Checks R, Statuses R.
5. **Where can this GitHub App be installed?** → **Only on this account** → **Create GitHub App**. Source: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app
6. Note the **Client ID** (create-github-app-token v3 prefers `client-id` over `app-id`). Source: https://github.com/actions/create-github-app-token
7. **Private key**: App settings → **Private keys / Key pairs** → **Generate a private key**. It downloads a `.pem` file (PKCS#1); an app can have up to 25 keys. Put the PEM in **AWS Secrets Manager** (e.g. `kentcrosswise/apps/qa`), then delete the local file. Source: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps
8. **Install**: App page → **Install App** → your account → **Only select repositories** → `kentcrosswise`. UNVERIFIED: exact button labels were not re-fetched; the flow is standard.

### Mint a token in a workflow (no GitHub secrets)
```yaml
- uses: aws-actions/configure-aws-credentials@v6.3.0   # OIDC, as in §3
- uses: aws-actions/aws-secretsmanager-get-secrets@v3
  with:
    secret-ids: QA_APP_KEY, kentcrosswise/apps/qa-private-key
- id: app
  uses: actions/create-github-app-token@v3
  with:
    client-id: ${{ vars.QA_APP_CLIENT_ID }}       # not secret; a repo variable is fine
    private-key: ${{ env.QA_APP_KEY }}
    permission-pull-requests: write                # optional down-scoping
```
- Outputs: `token`, `installation-id`, `app-slug`.
- The token **expires after 1 hour** and is revoked in the post step, so it can't be passed to another job.
- `\n`-escaped keys are handled.

Source: https://github.com/actions/create-github-app-token

Why Apps rather than `GITHUB_TOKEN`: events caused by `GITHUB_TOKEN` don't start new workflow runs (except `workflow_dispatch` and `repository_dispatch`). Pushes and PRs made with an **App installation token do** trigger CI. Source: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow

### Can App B approve App A's PR, and does it count?
- An App can submit an APPROVE review (`POST /pulls/{n}/reviews` needs Pull requests: write). Source: https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
- PR authors cannot approve their own PR, so the developer App can never approve its own PR. QA App ≠ developer App is required. Source: https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews
- Required-review counting: the docs say approvals count from "people with write permissions". **UNVERIFIED in official docs** whether a GitHub App's approval counts. A community thread reports that reviews from a dedicated GitHub App (or machine-user PAT) **do** count, while `GITHUB_TOKEN` reviews may not. Copilot reviews explicitly do **not** count. Sources: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches and https://github.com/orgs/community/discussions/181487. **Action: verify on a test PR before relying on it.**
- If you enable **"Require approval of the most recent reviewable push"**, the approver must not be the last pusher, so the QA App must not push fixes to the PR. Source: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets

### Ruleset for `main`: "require PR + passing checks + 1 approval"
Rulesets are available on **public repos with GitHub Free**. Source (search result, docs.github.com "About rulesets"): https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets
1. Repo → **Settings** → **Rules → Rulesets** → **New ruleset → New branch ruleset**. Name `main-protection`, Enforcement **Active**, Target: **Include default branch**. UNVERIFIED: exact click labels were not fetched.
2. Enable **Restrict deletions** and **Block force pushes**.
3. **Require a pull request before merging**:
   - Required approvals = **1**
   - "Dismiss stale approvals when new commits are pushed" ON
   - Optionally "Require approval of the most recent reviewable push" ON
   - "Require conversation resolution" optional
   - Allowed merge methods: **Squash**

   Source: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets
4. **Require status checks to pass**: add your CI job names. Optionally pin **expected source = GitHub Actions** so another App can't spoof a status. Turn on "Require branches to be up to date" if you accept extra rebases. Same source.
5. **Bypass list**: leave empty for the merge bot. It should merge through normal rules. Optionally add yourself (Repository admin) "for pull requests only" as an escape hatch. Same source.

---

## 5. GitHub Actions minutes (public repo)
- **Free and unlimited for public repos on standard GitHub-hosted runners.** Self-hosted runners are also free. **Larger runners are always billed**, even on public repos. Private repos on Free get 2,000 minutes/month. Source: https://docs.github.com/en/billing/concepts/product-billing/github-actions
- Limits that still apply. Source: https://docs.github.com/en/actions/reference/limits
  - 6 h per job
  - 35 days per workflow run
  - **20 concurrent jobs** (5 macOS) on Free
  - `GITHUB_TOKEN` API limit 1,000 requests/hour/repo
  - matrix max 256 jobs
- Scheduled workflows in public repos are disabled after 60 days without repo activity. Source: https://code.claude.com/docs/en/github-actions
- Cache: 10 GB per repo; artifacts/packages 500 MB on Free (stated for the Free plan quota). Source: https://docs.github.com/en/billing/concepts/product-billing/github-actions

---

## 6. Claude Code GitHub Action (`anthropics/claude-code-action@v1`)

Setup without GitHub secrets. There are three options; the first is best.

**(A) Workload identity federation, no key at all (recommended).**
- In the Claude Console (Settings → Workload identity; admin access required):
  1. Register issuer `https://token.actions.githubusercontent.com` (JWKS: discovery).
  2. Create a service account (`svac_...`).
  3. Create a federation rule (`fdrl_...`) matching the repo's `sub` prefix.
- Workflow inputs:
  - `anthropic_federation_rule_id`
  - `anthropic_organization_id`
  - optional `anthropic_service_account_id`
  - optional `anthropic_workspace_id`
- Add `permissions: id-token: write`.
- The IDs are not secrets and can go in repo variables.
- Do **not** also set `anthropic_api_key`, or federation is bypassed. Default audience is `https://api.anthropic.com`.
- The rule's subject prefix must match the **immutable** sub format (see §3). UNVERIFIED: the docs example shows `repo:your-org/your-repo:`.

Sources: https://github.com/anthropics/claude-code-action/blob/main/docs/setup.md and https://code.claude.com/docs/en/github-actions

**(B) API key from AWS Secrets Manager.** Fetch it with `aws-secretsmanager-get-secrets` (alias `ANTHROPIC_API_KEY`), then pass `anthropic_api_key: ${{ env.ANTHROPIC_API_KEY }}`. The action's `action.yml` also falls back to `env.ANTHROPIC_API_KEY` when the input is empty: `ANTHROPIC_API_KEY: ${{ inputs.anthropic_api_key || env.ANTHROPIC_API_KEY }}`. Pass it explicitly anyway, because a later step (inline-comment classifier) reads only `inputs.anthropic_api_key`. Source: https://github.com/anthropics/claude-code-action/blob/main/action.yml (read at commit 6b6870e, 2026-10-22)

**(C) Bedrock** (`use_bedrock: "true"`) through the same AWS OIDC role, billed to AWS. Source: https://code.claude.com/docs/en/github-actions

Model choice:
- `claude_args: --model claude-opus-5-5` (or `claude-sonnet-5`). Without it, the action uses the Claude Code default model.
- `--max-turns` caps cost.

Source: https://code.claude.com/docs/en/github-actions

GitHub identity for each agent:
- Pass the agent App's token: `github_token: ${{ steps.app.outputs.token }}`. With no token, the action authenticates as the official Claude GitHub App via OIDC (needs `id-token: write`).
- Set `bot_id` and `bot_name` for commit authorship. App tokens can't call `/user`.

Sources: https://code.claude.com/docs/en/github-actions and https://github.com/anthropics/claude-code-action/blob/main/docs/faq.md

What the action loads from the repo:
- `CLAUDE.md`, `.claude/settings.json`, `.claude/skills`: **yes**. The SDK is started with `settingSources: ["user","project","local"]` unless you pass `--setting-sources`. Source: `base-action/src/parse-sdk-options.ts` in https://github.com/anthropics/claude-code-action
  - Skills need `actions/checkout` first. Invoke one with `prompt: "/skill-name"`. Source: https://code.claude.com/docs/en/github-actions
  - Docs: "Create a `CLAUDE.md` ... Claude follows these guidelines." The system prompt also tells Claude to read CLAUDE.md. Sources: https://code.claude.com/docs/en/github-actions and `src/create-prompt/index.ts`
- **Security gotcha:** on PR events the action **restores `.claude/`, `CLAUDE.md`, `.mcp.json`, `.claude.json`, `CLAUDE.local.md`, `.gitmodules`, `.ripgreprc`, `.husky` from the PR's base branch**, because the PR head is untrusted. A PR that changes a skill or CLAUDE.md is reviewed with the *old* version, and the new one takes effect only after merge. Source: `src/github/operations/restore-config.ts` and `src/entrypoints/run.ts` in https://github.com/anthropics/claude-code-action
- Plugins and marketplaces: use the `plugin_marketplaces` (git URLs) and `plugins` (`name@marketplace`) inputs. Source: https://code.claude.com/docs/en/github-actions. UNVERIFIED: whether `enabledPlugins` / `extraKnownMarketplaces` in the repo's `.claude/settings.json` auto-install in the action; use the inputs to be safe.
- `.mcp.json` at the repo root is detected, but its tools must be allowed explicitly. `enableAllProjectMcpServers` is forced to true. Source: https://github.com/anthropics/claude-code-action/blob/main/docs/configuration.md

Other gotchas:
- **Bots are rejected as triggering actors** unless listed in `allowed_bots`, which matters because our Apps trigger each other. The default is no bots, and docs warn it is risky on public repos. Source: https://code.claude.com/docs/en/github-actions and `action.yml`
- Triggering users need write access. Fork authors can't trigger. Source: https://code.claude.com/docs/en/github-actions
- Bash is disabled by default. Allow specific commands via `claude_args: --allowedTools "Bash(npm:*),Bash(git:*)"`. Source: https://github.com/anthropics/claude-code-action/blob/main/docs/faq.md
- The action's prompt tells Claude not to modify `.github/workflows` "GitHub App permissions do not allow workflow modifications". This holds for the official Claude App. With our own App plus Workflows: write, it's a prompt-level restriction only. UNVERIFIED: whether it blocks with a custom token. Source: `src/create-prompt/index.ts`
- `show_full_output` may expose secrets in public logs; keep it false. Source: `action.yml`
- Cost: Actions minutes are free (public repo, §5). API tokens are billed per use.

---

## 7. Neon Postgres

Signup: https://neon.com → Sign up (GitHub, Google or email) → create project `kentcrosswise`, pick the AWS Region nearest your Lambda (e.g. `aws-us-east-1`). UNVERIFIED: signup click path not re-fetched.

Free plan limits. Source: https://neon.com/docs/introduction/plans

| Limit | Free |
|---|---|
| Projects | 100 |
| Branches | **10 per project** |
| Storage | 1 GB per project, 20 GB total |
| Compute | 100 CU-hours per project per month, autoscale up to 2 CU |
| Scale to zero | after 5 min, cannot disable |
| Restore window | 6 h |
| Egress | 5 GB per project per month |

Launch (paid): $0.106/CU-hour, $0.35/GB-month, no minimum. Same source.

- **Branch per PR plus 10-branch cap:** each open PR uses a branch (with `main` and any dev branches), so roughly 8 concurrent PR branches. Delete branches on PR close, and/or set `expires_at` (TTL) on PR branches. Sources: https://neon.com/docs/introduction/branching and https://github.com/neondatabase/create-branch-action

API key:
- Personal key: Console → profile menu → **Settings → API keys**.
- Org key or **project-scoped** key: switch to the org → **Settings → API keys → Create new → Project-scoped** (org admins only).
- The key is shown **once**. Keys don't expire until revoked. Store it in AWS Secrets Manager (`kentcrosswise/neon`).

Source: https://neon.com/docs/manage/api-keys. Prefer a project-scoped key for CI. UNVERIFIED: whether a personal-account user has an org for this.

Terraform provider. **Correction:** the community provider `kislerdm/neon` is **archived (2026-09-11)**. Its README says the provider "will be officially maintained and distributed as **neondatabase/neon**" (repo `github.com/neondatabase/terraform-provider-neon`, Terraform >= 1.14). Sources: https://github.com/kislerdm/terraform-provider-neon and https://github.com/neondatabase/terraform-provider-neon
- However, on 2026-10-22 the Terraform Registry API returned "provider not found" for `neondatabase/neon`, while `kislerdm/neon` v0.18.0 is still downloadable. Neon's docs page still points to `kislerdm/neon`. Source: https://neon.com/docs/reference/terraform
- **UNVERIFIED** which source address to use today. Options: pin `kislerdm/neon ~> 0.18` now and migrate when `neondatabase/neon` appears in the registry, or create the Neon project manually and keep it out of Terraform.
- Auth: the provider reads `NEON_API_KEY` from the environment. Source: https://neon.com/docs/reference/terraform

GitHub integration for branch-per-PR:
- Neon's built-in GitHub integration (Console → project → **Integrations → GitHub → Add → Install GitHub App**) creates a `NEON_API_KEY` **GitHub secret** and a `NEON_PROJECT_ID` variable. **This conflicts with "no GitHub secrets"**, so skip the integration and call the actions directly. Source: https://neon.com/docs/guides/neon-github-integration
- Direct approach:
  1. OIDC to AWS.
  2. Get `NEON_API_KEY` from Secrets Manager.
  3. `neondatabase/create-branch-action@v6` with `project_id: ${{ vars.NEON_PROJECT_ID }}`, `api_key: ${{ env.NEON_API_KEY }}`, `branch_name: preview/pr-${{ github.event.number }}`, optional `expires_at`.
  4. Outputs: `db_url`, `db_url_pooled`, `branch_id`, `password`.
  5. On PR `closed`, run `neondatabase/delete-branch-action`. The integration docs show `@v3`; check the latest.

  Sources: https://github.com/neondatabase/create-branch-action and https://neon.com/docs/guides/neon-github-integration. The integration docs still show `create-branch-action@v5`; v6 is current. UNVERIFIED: v5→v6 breaking changes are not documented on the README.
- The `db_url` output contains a password, so treat it as secret (mask it, don't echo it). UNVERIFIED: whether the action auto-masks it.

---

## 8. Terraform

Install on Windows:
- Official: download `terraform_1.17.0_windows_amd64.zip` from https://developer.hashicorp.com/terraform/install, unzip to e.g. `C:\tools\terraform\`, add to PATH. The page lists only binary downloads (AMD64/ARM64/386).
- Convenience: `winget install Hashicorp.Terraform`. The manifest currently gives **1.16.6**, one minor behind. It isn't mentioned on HashiCorp's page, so treat it as community-maintained (UNVERIFIED).

S3 backend with native locking:
```hcl
terraform {
  required_version = ">= 1.11"
  backend "s3" {
    bucket       = "kentcrosswise-tfstate-<account-id>"
    key          = "prod/terraform.tfstate"
    region       = "us-east-1"
    use_lockfile = true
    encrypt      = true
  }
}
```
- `use_lockfile` is **GA since Terraform 1.11**: "S3 native state locking is now generally available." It was experimental in 1.10. Source: https://raw.githubusercontent.com/hashicorp/terraform/v1.11/CHANGELOG.md
- DynamoDB locking "is deprecated and will be removed in a future minor version", so don't create a DynamoDB table. Source: https://developer.hashicorp.com/terraform/language/backend/s3
- Required IAM on the lock object: `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` on `<key>.tflock`, in addition to state permissions. Same source.
- Bootstrap: create the state bucket once by hand or with a tiny separate config. Turn on versioning and block public access. UNVERIFIED: best practice, not cited.

OpenNext via Terraform: maturity

| Option | Status | OpenNext support | Notes |
|---|---|---|---|
| `RJPearson94/terraform-aws-open-next` (registry `RJPearson94/open-next/aws`) v3.7.1 | Last release 2026-07-12; AWS provider v6 | `open_next_version` default `v2.x.x`, supports `v3.x.x`; v1 legacy module deprecated | Single-zone and multi-zone, Lambda Function URL with OAC/IAM auth, CloudFront staging distributions, ISR, image optimisation, server actions, function splitting. Lambda / Lambda@Edge only. |
| `nhs-england-tools/terraform-aws-opennext` v1.0.7 | Recent commits are dependency bumps only. README Usage/Architecture sections are still template text. | Example uses legacy `open-next ^2.0.0` (OpenNext **v2**) | Terraform >= 1.5, AWS provider >= 4.0. Most downloads (23k) but looks maintenance-only. |
| `GNorfolk/opennext/aws` 4.0.0 (2026-09-21), `pagopa-dx/aws-open-next/aws` 2.1.1 (2026-10-15) | Found in registry search; not evaluated | UNVERIFIED | Possibly newer; check before choosing. |

Sources: https://github.com/RJPearson94/terraform-aws-open-next, https://github.com/nhs-england-tools/terraform-aws-opennext, Terraform Registry module search API (`registry.terraform.io/v1/modules/search?q=opennext`), and https://opennext.js.org/aws/get_started

**Key risk:** the current `@opennextjs/aws` is **4.1.12**. No Terraform module I checked documents support for OpenNext **v4**. RJPearson tops out at v3.x and NHS at v2. OpenNext's own docs say the IaC options are community-contributed and "many are no longer maintained", and recommend **SST** as the maintained path. Source: https://opennext.js.org/aws/get_started. Options:
- (a) pin `@opennextjs/aws` to 3.x plus a supported Next.js version with the RJPearson module;
- (b) write our own thin Terraform for the OpenNext v4 output (S3 assets, server Lambda with Function URL, image Lambda, revalidation SQS, CloudFront);
- (c) use SST for the app layer.

UNVERIFIED: which Next.js versions OpenNext 3.x supports (Next 16 is current).

---

## Corrections to our assumptions

1. **OIDC trust policy format changed.** New repos (created after 2026-07-15) emit `sub` = `repo:OWNER@OWNER_ID/REPO@REPO_ID:...`. A trust policy written as `repo:OWNER/kentcrosswise:*` **will not match** and AssumeRole will fail. Use the immutable form (or opt the repo out if GitHub allows; UNVERIFIED that it does).
2. **Claude Code Action doesn't need an API key at all.** Use workload identity federation (GitHub OIDC → Claude Console service account), or Bedrock via the AWS role. If we keep a key, pull it from Secrets Manager into `env` and pass `anthropic_api_key: ${{ env.ANTHROPIC_API_KEY }}`.
3. **The Claude action rejects bot actors by default.** App-to-App triggering (dev App opens PR → QA workflow runs Claude) needs `allowed_bots` listing those App bot names.
4. **The Claude action uses the base branch's `.claude/` and `CLAUDE.md` on PR events.** Skill or instruction changes in a PR don't affect that PR's agent runs.
5. **`kislerdm/neon` is archived.** The official `neondatabase/neon` provider isn't in the Terraform Registry yet (as of 2026-10-22), so pin the archived one or keep Neon out of Terraform for now.
6. **Neon's one-click GitHub integration writes a GitHub secret.** Skip it and use `create-branch-action@v6` with the key from Secrets Manager. Also, the Free plan caps branches at **10 per project**, so PR branches need cleanup or TTL.
7. **No maintained Terraform module supports OpenNext v4** (current). Pin OpenNext 3.x with the RJPearson module, or own the Terraform.
8. **Enabling IAM Identity Center (organization instance) creates an AWS Organization**, which upgrades a Free-plan account to paid and **ends free credits immediately**.
9. **.com on Route 53 costs $16/yr** (since 2026-07-01), not $15. The hosted zone adds $0.50/month.
10. **GitHub App approvals counting toward required reviews** is not stated in official docs. Community reports say yes; test on a dummy PR. The developer App can never approve its own PR.
11. **App installation tokens last 1 hour and are per-job.** Long agent runs (> 1 h) need a refresh strategy.
