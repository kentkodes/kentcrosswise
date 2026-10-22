# Runbook: bootstrap AWS, prod and a manual preview (owner)

For the owner. Covers the live steps of P1-10, P1-11, P1-12 and P1-13 (DESIGN §7). Account setup that comes before this (AWS hardening, Neon projects, Google client, GitHub repo: P1-00) is in [../SETUP.md](../SETUP.md), sourced from [../research/infra.md](../research/infra.md) and [../research/apis.md](../research/apis.md).

Commands are PowerShell, run from the repo root unless a step says `cd`. They use your admin SSO profile `kc-admin`; those credentials are never stored anywhere.

**Never paste a secret value into a command line, a file or chat.** Values go into the Secrets Manager console. Where a command needs a value, it is read with `Read-Host -MaskInput` into an environment variable of the current shell only.

## 0. Before you start

- Tools: Terraform >= 1.11 (`terraform version`), AWS CLI v2, Node 24, pnpm 12, `gh` logged in.
- `pnpm install`
- Log in and remember the account id:

```powershell
aws sso login --profile kc-admin
$env:AWS_PROFILE = "kc-admin"
$acct = aws sts get-caller-identity --query Account --output text
$bucket = "kentcrosswise-tfstate-$acct"
```

**Domain or not (D22).** Everything below works without a domain: prod and previews get `https://<id>.cloudfront.net` URLs. Add `-var "domain_name=kentcrosswise.com"` to the bootstrap, prod and preview commands only once the Route 53 hosted zone for the domain exists (it is looked up, never created by Terraform). You can add it later: re-run step 1 (certificate), then step 6 (aliases and DNS).

## 1. Apply `infra/bootstrap` (local state)

Creates: state bucket `kentcrosswise-tfstate-<account>` (versioned, encrypted, public access blocked), the GitHub OIDC provider, roles `kcw-gh-ci`, `kcw-gh-plan`, `kcw-gh-deploy`, `kcw-gh-agent`, the policy `kcw-preview-boundary`, the 15 empty secrets of DESIGN §6, and (with a domain) the ACM certificate for `domain`, `*.domain`, `*.preview.domain`.

```powershell
cd infra/bootstrap
terraform init
terraform plan -var "aws_account_id=$acct" -out bootstrap.tfplan
terraform apply bootstrap.tfplan
terraform output
```

The plan refuses to run if `AWS_PROFILE` points at another account. With a domain, the apply waits for DNS validation of the certificate (usually a few minutes).

## 2. Move the bootstrap state into S3

```powershell
Copy-Item backend.tf.example backend.tf
terraform init -migrate-state -backend-config="bucket=$bucket"
# answer "yes" to copy the state
terraform state list                       # still lists everything, now read from S3
aws s3 ls "s3://$bucket/"                  # shows bootstrap.tfstate
Remove-Item terraform.tfstate, terraform.tfstate.backup, bootstrap.tfplan
cd ../..
git add infra/bootstrap/backend.tf
git commit -m "infra/bootstrap: S3 backend after migration"
```

From now on, bootstrap commands need `terraform init -backend-config="bucket=$bucket"` in a fresh checkout.

## 3. Repo variables and the `prod` environment

```powershell
$vars = terraform -chdir=infra/bootstrap output -json repo_variables | ConvertFrom-Json
$vars.PSObject.Properties | ForEach-Object { gh variable set $_.Name --body $_.Value --repo kentkodes/kentcrosswise }
gh variable set NEON_CI_PROJECT_ID --body "<kentcrosswise-ci project id>" --repo kentkodes/kentcrosswise
gh api -X PUT repos/kentkodes/kentcrosswise/environments/prod
```

This sets `AWS_ACCOUNT_ID`, `AWS_ROLE_CI_ARN`, `AWS_ROLE_PLAN_ARN`, `AWS_ROLE_DEPLOY_ARN`, `AWS_ROLE_AGENT_ARN`, `TF_STATE_BUCKET` and `NEON_CI_PROJECT_ID` (all non-secret IDs). The Neon project id is on the project's Settings page.

## 4. Check the roles live (P1-10)

The trust policies expect these exact subjects (`terraform -chdir=infra/bootstrap output role_subjects`):

| Role | Expected `sub` |
|---|---|
| `kcw-gh-ci`, `kcw-gh-plan` | `repo:kentkodes@107236483/kentcrosswise@1430035147:pull_request` |
| `kcw-gh-deploy` | `repo:kentkodes@107236483/kentcrosswise@1430035147:environment:prod` |
| `kcw-gh-agent` | `repo:kentkodes@107236483/kentcrosswise@1430035147:ref:refs/heads/main` |

The `pull_request` and `environment` forms are not confirmed in GitHub's docs yet (DESIGN U5), so test them:

1. Copy [oidc-debug.yml](oidc-debug.yml) to `.github/workflows/oidc-debug.yml`, commit it **on main** and push (before the `main` ruleset exists), then run it: `gh workflow run oidc-debug.yml --ref main`. Jobs `main` and `prod` must be green.
2. Open a throwaway PR from a branch of this repo (any one-line change). Job `pr` must be green.
3. In each job log, copy the `sub=...` line into the table below. If one differs from the expected value, stop and tell the Liaison (the trust policy must change, not the workflow).
4. Delete `.github/workflows/oidc-debug.yml` from main and close the PR.

Recorded subjects (fill in):

| Context | Actual `sub` | Right role assumed | Wrong role refused |
|---|---|---|---|
| push/dispatch on main | | | |
| pull_request | | | |
| environment prod | | | |

## 5. Fill the secrets needed now

Secrets Manager console → the secret → *Retrieve secret value* → *Edit* → *Key/value*. Phase 1 needs:

| Secret | Keys to fill now | Where the value comes from |
|---|---|---|
| `kcw/prod/web` | `auth_secret` | a random string of at least 32 characters (below) |
| | `owner_email` | the Google account allowed to sign in |
| | `google_client_id`, `google_client_secret` | Google Auth Platform → Clients (SETUP.md A5) |
| `kcw/prod/origin-verify` | `origin_verify` | a long random value (below). CloudFront sends it to the server Lambda, which refuses requests without it (D25). Fill it before step 6, or the prod plan fails |
| `kcw/ci` | `neon_api_key` | Neon → Settings → API keys, project-scoped to `kentcrosswise-ci` if offered |
| | `e2e_login` | a random string of at least 16 characters (below); the preview login token |

The other keys and secrets (`vapid_*`, `db_url*`, models, GitHub Apps, social) are filled in later phases; leave them empty.

A random value (48 characters), generated locally and copied straight to the clipboard (not printed). Use a fresh one each for `auth_secret`, `origin_verify` and `e2e_login`:

```powershell
node -e "process.stdout.write(require('node:crypto').randomBytes(36).toString('base64url'))" | Set-Clipboard
```

Google client: add the prod redirect URI after step 6, `https://<prod host>/api/auth/callback/google`. Google may refuse a `*.cloudfront.net` redirect URI because it is not an authorized domain you own (**verify**); if it does, Google sign-in waits for the domain, and everything else still works.

## 6. Apply `infra/prod` (P1-11)

Build the prod bundle first (Terraform zips and uploads it):

```powershell
Remove-Item Env:KCW_ENV -ErrorAction SilentlyContinue
pnpm build-web                 # prod build + output contract check + preview-provider check
cd infra/prod
terraform init -backend-config="bucket=$bucket"
terraform plan -out prod.tfplan            # add -var "domain_name=kentcrosswise.com" when the zone exists
terraform apply prod.tfplan
terraform output url
cd ../..
```

The plan refuses a build made with `KCW_ENV=preview` (it checks `apps/web/.open-next/kcw-build.json`), and the preview stack refuses a prod build. The first CloudFront deployment takes several minutes. Then check:

- `<url>/` shows the public home and `<url>/demo` the demo.
- `<url>/hub` redirects to `/api/auth/signin`, and "Sign in with Google" works with the owner account (a `POST` through CloudFront; D25 replaced OAC on the server origin for this).
- The server Function URL called directly (`terraform state show module.web.aws_lambda_function_url.server` shows it) answers `403 Forbidden`.
- To rotate `origin_verify`: change the secret, then re-run this step. Until the apply finishes, the site answers 403.
- Another Google account is refused.

## 7. Manual preview `pr-0` (P1-12, P1-13)

**Neon branch.** Either open a PR that touches `.github/actions/neon-preview/` (the `neon-preview-smoke` workflow creates and deletes `preview/pr-0`, which is the P1-12 live check), or for the P1-13 test create it by hand: Neon console → project `kentcrosswise-ci` → Branches → *New branch* `preview/pr-0` from `base` → copy the **pooled** connection string. If `base` has no schema yet:

```powershell
$env:DATABASE_URL = Read-Host -MaskInput "pooled URL of preview/pr-0"
pnpm migrate
pnpm seed
Remove-Item Env:DATABASE_URL
```

**Build and apply** (preview build: contains the preview login, reads `kcw/ci`):

```powershell
$env:KCW_ENV = "preview"; pnpm build-web; Remove-Item Env:KCW_ENV
cd infra/preview
terraform init -reconfigure -backend-config="bucket=$bucket" -backend-config="key=preview/pr-0.tfstate"
$env:TF_VAR_database_url = Read-Host -MaskInput "pooled URL of preview/pr-0"
terraform apply -var pr_number=0           # add -var "domain_name=kentcrosswise.com" if used in step 6
terraform output url
cd ../..
```

The URL is never written to state (write-only SSM value). **Test**:

```powershell
$env:BASE_URL = "<preview url>"
$env:KCW_E2E_LOGIN = Read-Host -MaskInput "e2e_login from kcw/ci"
pnpm --filter web e2e
Remove-Item Env:BASE_URL, Env:KCW_E2E_LOGIN
```

All 5 tests must pass (public home, demo, owner redirect, wrong token refused, preview login).

**Tear down and check:**

```powershell
cd infra/preview
terraform destroy -var pr_number=0         # same -var flags as the apply; TF_VAR_database_url still set
Remove-Item Env:TF_VAR_database_url
cd ../..
aws s3 rm "s3://$bucket/preview/pr-0.tfstate"
# Neon console: delete branch preview/pr-0 (or let it expire after 3 h if the smoke workflow made it)
$env:NEON_API_KEY = Read-Host -MaskInput "neon_api_key from kcw/ci"
pnpm check-preview-clean --pr 0 --bucket $bucket --neon-project "<kentcrosswise-ci project id>"
Remove-Item Env:NEON_API_KEY
```

`check-preview-clean` must print `pr-0 is clean`. Tagged resources can show up in the tagging API for a few minutes after deletion; wait and re-run before reporting a leak.

These manual steps use your admin profile. The `kcw-gh-ci` role's preview permissions are exercised for real in P1-15 (`ci.yml`).

## Known risks to watch on first apply

- **Origin header (D25).** The server Function URL is public; only the `x-kcw-origin` check keeps direct calls out. The value is in the CloudFront config and in Terraform state, which the PR plan role can read.
- `lambda:InvokeFunction` with `invoked_via_function_url` is granted next to `lambda:InvokeFunctionUrl` (to CloudFront for the image URL, to everyone for the public server URL); if the apply rejects it, report it.
- `kcw-gh-ci` limits CloudFront distribution changes by the tag `kcw:env=preview` (`aws:RequestTag` / `aws:ResourceTag`); whether CloudFront honors these keys for every action is unverified until P1-15.
