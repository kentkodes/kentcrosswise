# Kentcrosswise: Account Setup Guide

For the owner. Researched 2026-10-22; every step is sourced in [research/infra.md](research/infra.md) and [research/apis.md](research/apis.md). Where a vendor's click path may have changed, the research notes mark it UNVERIFIED.

**Golden rule for secrets:** never paste a key, password or token into chat, a file, or a GitHub secret. Every secret goes straight into **AWS Secrets Manager** (console → Secrets Manager → the named secret → *Retrieve/Set secret value*). Terraform creates the empty secrets in Phase 1 (task P1-10); until then, only create accounts — don't generate keys you have nowhere to put.

Steps are grouped by when they're needed. Part A blocks Phase 1; Parts B and C can wait.

---

## Part 0 — Tools on your PC (10 min)

In PowerShell:

```bash
winget install Git.Git OpenJS.NodeJS.LTS pnpm.pnpm Amazon.AWSCLI Hashicorp.Terraform GitHub.cli
```

- [x] AWS CLI is 2.22 or newer (`aws --version`).
- [x] Terraform is 1.11 or newer (`terraform version`; winget currently gives 1.16.6, which is fine).
- [x] `gh auth login` done.

---

## Part A — Needed for Phase 1 (foundation)

### A1. AWS account hardening (20 min)

1. [x] **Root MFA** (now mandatory). Sign in as root → account name (top right) → *Security credentials* → *Assign MFA device* → **Passkey or security key**. Check the account email and phone are current first; they are your recovery path.
   - Keep the root email on Gmail, **not** an `@kentcrosswise.com` address (if the account were suspended, you'd lose the domain and the email that recovers it).
2. [x] **Decide: are you on the AWS Free plan with credits you want to keep?** (Billing console shows it.)
   - **No / don't care →** use IAM Identity Center (step 3). Recommended.
   - **Yes →** enabling Identity Center creates an AWS Organization, which ends Free-plan credits immediately. Tell me, and we'll use an IAM user with MFA instead.
3. [x] **IAM Identity Center** (in `us-east-1`; the Region can't be changed later): console → IAM Identity Center → *Enable* → **Single-Region instance** → *Enable with AWS Organizations*.
   - *Users → Add user* (your username is permanent) → create group `Admins` → add yourself.
   - *AWS accounts* → tick your account → *Assign users or groups* → `Admins` → *Create permission set* → predefined **AdministratorAccess** → *Submit*.
   - Accept the email invite, set a password, register MFA. **Save the "AWS access portal URL"** from that email.
4. [x] **CLI login.** Run `aws configure sso` and answer: session name `kentcrosswise`, start URL = the portal URL, SSO region `us-east-1`, scopes `sso:account:access`. In the browser pick your account and AdministratorAccess. Then: default region `us-east-1`, output `json`, profile name `kc-admin`.
   - Check: `aws sts get-caller-identity --profile kc-admin` prints your account.
   - Day to day: `aws sso login --profile kc-admin`.
5. [ ] *(Optional, not a cap)* **Budget alert**: Billing and Cost Management → *Budgets* → *Create budget* → template **Monthly cost budget** → amount (e.g. $20) + your email. It only emails you; it never stops anything.

### A2. Domain (10 min, $16/year)

1. [x] Route 53 → *Domains → Registered domains → Register domains* → `kentcrosswise.com` → *Proceed to checkout*.
2. [x] 1 year, **auto-renew on**, privacy protection on, your legal name as contact → *Submit*.
3. [ ] **Click the verification link** in the email from Route 53 within the deadline, or the domain gets suspended.
4. [ ] Leave the hosted zone Route 53 creates automatically (Terraform will import it; don't create a second one). It costs $0.50/month.

### A3. GitHub repo (5 min)

1. [x] Create a **public** repo `kentcrosswise` (empty: no README, no license yet).
2. [x] Tell me when it exists. I'll read its owner and repo IDs myself — the AWS trust policies need them because new repos use GitHub's new ID-based OIDC format.

Do **not** create GitHub Apps yet (Part B).

### A4. Neon (10 min, free)

1. [x] Sign up at neon.com (sign in with GitHub is easiest).
2. [x] Create two projects, both in **AWS us-east-1**:
   - `kentcrosswise` — production data.
   - `kentcrosswise-ci` — test copies for PRs; never holds your real data.
3. [x] **Don't** turn on Neon's GitHub integration (it writes a GitHub secret, which breaks our "all secrets in AWS" rule).
4. [ ] Later, when I say the secret exists: Settings → API keys → **Project-scoped** key for `kentcrosswise-ci` → paste straight into secret `kcw/ci`, key `neon_api_key`, in Secrets Manager. The key is shown only once.

### A5. Google Cloud — sign-in only for now (20 min, free)

1. [x] console.cloud.google.com → create project `kentcrosswise`.
2. [x] *Google Auth Platform* → get started:
   - **Branding:** app name `kentcrosswise`, your support email, authorized domain `kentcrosswise.com`.
   - **Audience:** **External** (a personal Gmail can't use Internal).
   - **Data access:** scopes `openid`, `email`, `profile` only for now. Calendar and YouTube get added in Phase 3.
3. [x] **Publish the app ("In production")**, unverified. This is allowed for personal use and avoids the 7-day login expiry you'd get in Testing once Calendar/YouTube scopes are added. You'll see a "Google hasn't verified this app" screen once; click *Advanced → Go to kentcrosswise*.
4. [x] *Clients → Create client → Web application*:
   - Authorized JavaScript origin: `https://kentcrosswise.com`
   - Redirect URIs: `https://kentcrosswise.com/api/auth/callback/google` and `http://localhost:3000/api/auth/callback/google`
5. [ ] The client secret is shown once. Wait until secret `kcw/prod/web` exists, then paste the client ID under key `google_client_id` and the secret under key `google_client_secret`. (If you create the client earlier, you can download the JSON and delete it right after pasting.)

### A6. Anthropic Console (10 min)

1. [x] Sign up at platform.claude.com.
2. [x] Settings → Billing → **Buy credits** (credits expire after 1 year; turn auto-reload on or off as you like).
3. [ ] Later, into secret `kcw/prod/models`, key `anthropic_api_key`: one API key for the app itself (mood scoring, router fallback). The GitHub agents won't need a key — they'll authenticate through workload identity federation (Part B).

Haiku 5.5 (`claude-haiku-5-5`) costs $0.10 in / $0.50 out per million tokens for prompts under 100K tokens; prompts over 100K cost 5× more, so the agents keep prompts small.

---

## Part B — Needed for Phase 2 (agent system)

Detailed, permission-by-permission steps will be in `docs/runbooks/github-apps.md` (task P2-07). Overview:

1. [ ] **Five GitHub Apps**, all under *Settings → Developer settings → GitHub Apps → New GitHub App*, each "Only on this account", installed on `kentcrosswise` only:
   `kentcrosswise-orchestrator`, `kentcrosswise-dev`, `kentcrosswise-qa`, `kentcrosswise-scraper`, `kentcrosswise-docs`.
   - Only the orchestrator gets an active webhook (pointing at our relay). The others have webhooks off.
   - Each App's private key (`.pem`) goes into Secrets Manager, then you delete the downloaded file: the orchestrator's into `kcw/prod/orchestrator` (key `github_app_private_key`, plus its client ID and installation ID); the others into `kcw/github/developer-app`, `kcw/github/qa-app`, `kcw/github/scraper-app`, `kcw/github/docs-app` (key `private_key`). The webhook secret goes into `kcw/github/webhook-secret`.
2. [ ] **Anthropic workload identity federation** (Console → Settings → Workload identity): register GitHub as an issuer and create one rule for our repo. Then the agents use Claude without any stored key. The IDs it gives you aren't secrets.
3. [ ] **Branch ruleset** on `main` (Settings → Rules → Rulesets): require PR, 1 approval, dismiss stale approvals, required status checks, squash only, block force pushes. We'll test on a dummy PR whether the QA App's approval counts.
4. [ ] **LangSmith** (free Developer plan: 1 seat, 5,000 traces/month) → Settings → API keys → paste into secret `kcw/prod/models`, key `langsmith_api_key`.

---

## Part C — Needed for Phase 3 (hub features)

1. [ ] **Google Calendar + YouTube:** enable *Google Calendar API*, *YouTube Data API v3*, *YouTube Analytics API*; add scopes `calendar.events.owned`, `youtube.readonly`, `yt-analytics.readonly`; sign in again once to grant them.
2. [ ] **Instagram** (no Facebook Page needed): developers.facebook.com → *Create App* → use case *Other*, type *Business* → add the Instagram product → *API setup with Instagram login* → add your Instagram account as a tester (account must be public) → set redirect `https://kentcrosswise.com/api/instagram/callback`. Note the **Instagram** App ID and secret (they differ from the Meta app ID). Development mode with you as tester should not need App Review, but we'll confirm by testing.
3. [ ] **TikTok:** developers.tiktok.com → create app (Web) → Login Kit + Display API → scopes `user.info.basic`, `user.info.stats`, `video.list` → switch to **Sandbox** → add your own TikTok account as a target user. TikTok's review won't approve personal-use apps, so we stay in Sandbox; the first TikTok task tests whether Sandbox returns your real numbers. The site's `/terms` and `/privacy` pages must be live first (domain verification).
4. [ ] **Jev:** sign up at console.typesafe.ai (early access) → Keys → paste into secret `kcw/prod/models`, key `typesafe_api_key`.
5. [ ] **iPhone notifications:** open kentcrosswise.com in Safari → Share → **Add to Home Screen** (needs iOS 16.4+), then allow notifications from inside the app.

---

## What this costs (known so far)

| Item | Cost |
|---|---|
| Domain | $16/year |
| Route 53 hosted zone | $0.50/month |
| Secrets Manager | ~$0.40 per secret per month (unverified); we'll group secrets to keep the count low |
| Lambda, S3, SQS, CloudFront, ACM certificate | expected within free tier at personal volume |
| Neon, LangSmith, GitHub Actions (public repo) | free tiers |
| Anthropic, Jev | pay per use |
