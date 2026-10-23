# Kentcrosswise: Design (v0.2, 2026-10-22)

Status: DRAFT. Implements [hub/SPEC.md](hub/SPEC.md) and [essays/SPEC.md](essays/SPEC.md) (both approved 2026-10-22). Vendor facts come from [research/infra.md](research/infra.md) and [research/apis.md](research/apis.md) (verified 2026-10-22); anything still unconfirmed is marked **verify** and tracked in section 10.

Changes vs v0.1: OIDC trust uses GitHub's immutable `sub` format (§5); Claude Code Action authenticates by Anthropic workload identity federation, with no Anthropic key for agents (D16, §4.1); Neon branches via `create-branch-action@v6` with a 10-branch budget and TTL (D12, §5); OpenNext v4 with our own Terraform module confirmed (D14); only the orchestrator App has a webhook (D17); App-approval counting is a live check with a fallback (P2-07); secrets grouped per reader into 14 fixed secrets, and the per-PR preview DB URL moved to an SSM SecureString (§6, D19, D21); spec conflicts C1, C3, Q2-Q4 resolved (§11); Phase 3 additions (§9); section 10 rewritten as resolved/open.

## 0. Decisions made here (beyond the fixed brief)

| # | Decision | Rejected | Why |
|---|---|---|---|
| D1 | pnpm workspaces; extra top-level `packages/` for shared libs (`core`, `db`, `secrets`, `essays`, `demo-data`, `xray`) | Turborepo, Nx | Fewest moving parts; `pnpm -r` is enough at this size. |
| D2 | Plain SQL migrations + tiny runner; typed queries with Kysely | Prisma, Drizzle migrations | DDL is the source of truth; merge-rules can grep SQL for DROP/RENAME. |
| D3 | Unit/DB tests on PGlite (embedded Postgres, no Docker) | Docker Postgres, Neon dev branch for unit tests | Our local sub-agents run on Windows without Docker; Neon is only used for preview/e2e. **verify** PGlite covers the SQL we use. |
| D4 | Preview DBs branch from a separate Neon project `kentcrosswise-ci` (schema + synthetic seed), never from prod | Branching prod | A branch of prod copies private data into an environment reachable from public CI logs and agent-written code. Accepted by the owner (C1). |
| D5 | All orchestrator inputs go through one SQS FIFO queue, `MessageGroupId = thread_id` | Direct Lambda invokes | Serializes work per LangGraph thread (no double resume); retries and DLQ for free; one entry point. |
| D6 | The orchestrator is the only dispatcher of agent workflows (`workflow_dispatch`); no agent workflow listens to issue comments or `@mentions` | Claude Code Action's comment trigger | The repo is public, so anyone can comment. Pause-all becomes one check in one place. |
| D7 | No agent GitHub App gets the `workflows` permission | | Agent PRs cannot edit `.github/workflows/**`. Workflow changes are owner work ("permissions" = critical). |
| D8 | Merge-rules is a deterministic pure function (diff paths, SQL patterns, prod `terraform plan` summary, lockfile diff) | LLM judgement | Critical-change detection must be predictable and testable. QA does the "matches design docs" judgement. Only `docs/**/SPEC.md` counts as "changes what the product does" (C3). |
| D9 | Lambdas read Secrets Manager at cold start (cached); env vars hold only secret **names** | Secrets in Lambda env vars | Keeps "all secrets in Secrets Manager" literally true. |
| D10 | Public pages import only `@kcw/demo-data`, enforced by an ESLint `no-restricted-imports` rule on `app/(public)/**`; the public agent feed reads one DB view through a role that can read nothing else | Runtime checks only | Private data cannot reach a public endpoint by accident. |
| D11 | Agent office feed = polling a CloudFront-cached JSON endpoint (5 s) | WebSockets / API Gateway | No extra service; good enough for a public animation. |
| D12 | Neon branches via `neondatabase/create-branch-action@v6` / `delete-branch-action` with the key from Secrets Manager; Neon projects created by hand, outside Terraform | Neon GitHub integration (writes a GitHub secret); Neon TF provider (`kislerdm/neon` archived, official one not in the registry); own API script | Official actions, no GitHub secret, nothing to maintain. |
| D13 | Orchestrator planner, public-title writer and essay hooks use Haiku 5.5 (configurable per node) | Sonnet/Opus for planning | Owner confirmed (Q3). |
| D14 | Pin `@opennextjs/aws` 4.1.x + Next 16; own thin Terraform module for the OpenNext v4 output | RJPearson module (v3 max), NHS module (v2), SST (second IaC tool next to the fixed Terraform), downgrading to OpenNext 3 | No maintained module supports v4. |
| D15 | Google refresh token (Calendar, YouTube) stored in Secrets Manager, written by the app at consent | DB column | It is a credential. |
| D16 | Agents call Anthropic through **workload identity federation** (GitHub OIDC to a Claude Console federation rule); no Anthropic API key exists for Actions | Key from Secrets Manager; Bedrock | No secret at all; IDs are repo variables. One service account per agent if the Console allows it (per-agent usage), **verify**. |
| D17 | Only the orchestrator App has an active webhook (to the relay); the other four Apps have webhooks inactive | Webhooks on every App | One event source, one secret; the other Apps are only driven by workflows. |
| D18 | Agent jobs: `timeout-minutes: 50`, `--max-turns` cap; no token re-mint | Refreshing the App token mid-job | App installation tokens last 1 h per job; a capped job is simpler and also caps spend. |
| D19 | Secrets grouped into one JSON secret per reader (IAM still per reader); GitHub App keys stay one secret per App so each agent workflow can read only its own key | One secret per value | Secrets Manager bills per secret (~$0.40/month each, **verify**): 14 fixed secrets (§6) instead of 25+. |
| D21 | The per-PR preview DB URL goes in an **SSM Parameter Store SecureString** `/kcw/preview/pr-<n>/database-url` (standard tier, AWS-managed KMS key), created and deleted by `infra/preview` | A Secrets Manager secret per PR; a Lambda env var | Standard parameters are believed free (**verify**: price and that the default `aws/ssm` key adds no cost); it is an ephemeral credential for a synthetic-data branch, still encrypted and IAM-scoped to that PR's Lambda. Only exception to "Secrets Manager only": confined to throwaway preview credentials. If SSM is ruled out, fall back to a per-PR secret (it lives ~1 h, so cost is negligible if billing is prorated, **verify**). |
| D20 | At most 4 agent PRs in flight (orchestrator limit); preview Neon branches have `expires_at` = now + 3 h | Unlimited | Neon Free allows 10 branches per project (§5). |
| D22 | The domain is optional in Terraform: `domain_name = ""` means no ACM certificate or Route 53 records, and prod and previews use their CloudFront `*.cloudfront.net` URLs. Setting the variable later adds the cert, aliases and DNS without recreating anything else. | Blocking Phase 1 on the domain | As of 2026-10-22 the owner can't register `kentcrosswise.com` on Route 53 yet (AWS support case open). If Route 53 keeps refusing, buy the domain at another registrar and point its name servers at a Route 53 hosted zone. |
| D24 | Accepted from P1 build (2026-10-22): Node 24 (`.nvmrc`, `engines >=22.12`, engine-strict); TypeScript pinned `~6.0` (typescript-eslint doesn't support 7); ESLint 9. `(public)/**` may import `@kcw/demo-data` **and** `@kcw/xray` (X-ray is public by spec; amends D10). DB roles in migrations are NOLOGIN group roles; Neon login users are created outside the repo (bootstrap runbook) and granted membership, so no DB passwords live in git. Jev is called with `fetch` through `jev-adapter.ts`. | | Recorded after Liaison verification. |
| D23 | AWS region `us-east-1` for every resource. The owner's IAM Identity Center lives in `us-east-2`; that only affects `aws sso login`. CLI profile `kc-admin`. GitHub repo `kentkodes/kentcrosswise` (public), owner id `107236483`, repo id `1430035147`, so the OIDC `sub` prefix is `repo:kentkodes@107236483/kentcrosswise@1430035147`. | | Recorded from the owner's setup. |
| D25 | The server Lambda Function URL uses **AuthType NONE**, guarded by a secret origin header: CloudFront adds `x-kcw-origin`, and the OpenNext server wrapper (`apps/web/src/server/origin-wrapper.ts`, wrapper override `kcw-origin-guard`) answers 403 to any request without the exact value (constant-time compare), before routing, the ISR cache, route handlers and server actions. Prod value: secret `kcw/prod/origin-verify`, key `origin_verify` (the owner fills a long random value). Preview value: Terraform `random_password` per preview, stored for the server in the SSM SecureString `/kcw/preview/pr-<n>/origin-verify`. The image-optimization Function URL keeps OAC + AWS_IAM (GET only); revalidation stays on SQS. | OAC + AWS_IAM on the server URL | AWS requires clients that PUT/POST through OAC to a Function URL to send `x-amz-content-sha256`; browsers don't, which breaks Auth.js forms and server actions (CloudFront Developer Guide, restricting access to a Lambda function URL origin). The prod value has its own secret rather than a key in `kcw/prod/web` because Terraform must read it to configure CloudFront: the PR plan role and the deploy role can read this one value without reading the auth secret and Google client secret. **Residual risk:** the value lives in the CloudFront config and in Terraform state (private, encrypted bucket); the PR plan role can read the prod state, so PR CI code could learn it and call the Function URL directly. That bypasses CloudFront, not Auth.js. Rotate by changing the secret and re-applying prod. |

## 1. Architecture

```
                      Visitors / Owner (browser, iPhone PWA)
                                   |
                         Route 53 kentcrosswise.com
                                   |
                              CloudFront ---- S3 assets (public build output)
                                   |
                     Next.js server Lambda (OpenNext v4) ---- Secrets Manager
                      |  public: demo, X-ray, office feed,       ^   (every secret)
                      |          /terms, /privacy                 |
                      |  owner: hub, /essays, boss console        |
   Neon prod (Postgres) <--------------------------------+        |
   hub, essays, agent tables, LangGraph checkpoints      |        |
          ^                ^                             |        |
   +------+------+   +-----+-----------------------------+--+     |
   | Pipelines   |   | Orchestrator Lambda (LangGraph JS)   |-----+--> Anthropic (Haiku 5.5), Jev
   | watcher λ   |   |  consumes SQS FIFO orchestrator-in   |         LangSmith (traces)
   | runner λ    |   +-----^------------------+-------------+
   +--^------+---+         |                  | GitHub API (orchestrator App):
      |      |       SQS FIFO orchestrator-in | issues, workflow_dispatch, merge, checks
 EventBridge |       ^     ^      ^           v
 Scheduler   |   console  webhook  EventBridge   GitHub repo kentcrosswise (public)
      |      v   (web)    relay λ  Scheduler     |  Actions: ci.yml, deploy.yml, preview-gc.yml,
      |   S3 essay-text      ^                   |  agent-developer/qa/scraper/docs.yml
      |   (private)          +-- webhooks (orchestrator App only)
      +--> SQS essay-urls + DLQ                  |  OIDC -> AWS role -> Secrets Manager
                                                 |  OIDC -> Anthropic federation (agents)
                                                 +--> per-PR preview: Terraform stack
                                                      + Neon branch in kentcrosswise-ci
```

Components:
- **Web** (`apps/web`): one Next.js 16 App Router app on Lambda via OpenNext v4. Route groups: `(public)` (demo, X-ray, office, `/terms`, `/privacy`) and `(owner)` (hub, boss console, inbox). `/essays` is mounted from `@kcw/essays`. Auth.js with Google, allowlisted owner email.
- **Orchestrator** (`agents/orchestrator`): Lambda with an SQS FIFO trigger, batch size 1. Each invocation loads the task's LangGraph thread from the Neon checkpointer, runs to the next `interrupt`, and returns. Target under 2 min per invocation; timeout 5 min. LangSmith env: `LANGSMITH_TRACING=true`, `LANGCHAIN_CALLBACKS_BACKGROUND=false` (flush before freeze).
- **Webhook relay** (`agents/webhook-relay`): Lambda Function URL. It verifies `X-Hub-Signature-256`, dedupes by `X-GitHub-Delivery`, drops events whose sender is not one of our Apps or the owner, normalizes them and enqueues to `orchestrator-in`.
- **Agent workflows** (`.github/workflows/agent-*.yml`): Claude Code Action on Haiku 5.5 with the agent's playbook. Each authenticates to GitHub as its own App and to Anthropic by federation. It reports events and usage by sending messages to `orchestrator-in`.
- **CI/deploy workflows**: `ci.yml` (per PR), `deploy.yml` (push to main), `preview-gc.yml` (PR closed + nightly dispatch by the sweeper; no GitHub `schedule`, because public repos disable schedules after 60 inactive days).
- **Pipelines** (`pipelines/`): watcher Lambda (EventBridge) and a runner Lambda (SQS `essay-urls`) that chains extract, validate and categorize. All plain code except the categorizer call.
- **Scheduler**: EventBridge schedules for the orchestrator sweeper (15 min), nightly source health + preview GC dispatch, weekly quality report, daily social snapshot, Instagram token refresh (every 30 days), and the watcher.
- **Model providers** (`packages/core/models`): `classify(input, labels) -> {label, confidence, model}` and `complete/score`. Implementations:
  - `JevProvider`: `@typesafe-ai/sdk`, `POST https://api.typesafe.ai/v1/systemone`, `choice` questions. The model is pinned in config to `jev-1.13.0` rather than `jev-latest`; it is upgraded deliberately after replaying stored `route_corrections`.
  - `AnthropicProvider`: `claude-haiku-5-5`. Runtime prompts are kept under 100K tokens (price cliff above that).
  - `FakeProvider`.
  - `withFallback(threshold)`: Haiku when Jev's confidence is below the threshold or Jev returns an error (429/529 retried with backoff first).
  - Every call writes a `usage_events` row.

## 2. Repo layout

```
kentcrosswise/
  AGENTS.md                      # canonical agent guide (kept current by Docs-keeper)
  CLAUDE.md                      # points to AGENTS.md and docs/agents/*.md
  package.json  pnpm-workspace.yaml  tsconfig.base.json  eslint.config.js
  .claude/settings.json  .claude/skills/<skill>/SKILL.md
  .github/workflows/  ci.yml deploy.yml preview-gc.yml
                      agent-developer.yml agent-qa.yml agent-scraper.yml agent-docs.yml
  .github/actions/    aws-auth/ neon-preview/          # composite actions
  apps/web/
    src/app/(public)/   src/app/(owner)/   src/app/api/   src/app/essays/ (thin mount)
    e2e/                # Playwright
  packages/
    core/        # types, model providers, sanitizer, event types
    db/          # migrations/*.sql, runner, Kysely types, seeds (synthetic only)
    secrets/     # getSecret(name) with cache + fake
    essays/      # essays UI + server logic (@kcw/essays)
    demo-data/   # deterministic simulated people, metrics, mood
    xray/        # component -> {tech, what, why} registry + overlay
  agents/
    orchestrator/   # LangGraph graph, Lambda handler, GitHub client
    webhook-relay/
    merge-rules/    # pure critical-change detector
    report/         # kcw-report CLI used by workflows (events, usage)
  pipelines/
    watcher/  validator/  categorizer/  runner/
    extractors/<site-id>/  (index.ts, fixtures/ public-domain only, test)
  infra/
    bootstrap/  prod/  preview/
    modules/  web/ orchestrator/ pipelines/ scheduler/ secrets/ github-oidc/
  scripts/        # check-repo-settings.ts, migrate.ts, check-preview-clean.ts
  docs/
    hub/SPEC.md  essays/SPEC.md  DESIGN.md  research/
    agents/ developer.md qa.md scraper.md docs.md
    runbooks/ bootstrap.md github-apps.md prod-db.md
```

## 3. Data model (Postgres, Neon)

Schemas: `public` (app) and `lg` (LangGraph checkpointer tables, created by the library; **verify** the schema option). All timestamps are `timestamptz`. Only synthetic seed data lives in `packages/db/seeds`.

### 3.1 Hub
| Table | Key columns |
|---|---|
| `entries` | id, created_at, source (`web`,`shortcut`), raw_text, route_kind (`crm_note`,`diary`,`todo`,`idea`,`agent_request`, null=pending), route_confidence, route_model, routed_by (`model`,`owner`), status (`routed`,`needs_owner`) |
| `route_corrections` | id, entry_id, from_kind, to_kind, created_at |
| `contacts` | id, name, aliases text[], how_known, birthday date, notes, tags text[] |
| `crm_notes` | id, entry_id, contact_id null, body, link_status (`linked`,`ambiguous`,`none`) |
| `calendar_suggestions` | id, entry_id, title, start_at, end_at, status (`pending`,`added`,`dismissed`), google_event_id |
| `diary_entries` | id, entry_id null, body, written_at |
| `mood_scores` | diary_entry_id PK, energy, stress, happiness, satisfaction, sadness, anger, anxiety, gratitude (numeric 0..1 CHECK), sentiment (-1..1 CHECK), model, scored_at |
| `todos` / `ideas` | id, entry_id, body, done/status, created_at |
| `social_accounts` | id, platform (`youtube`,`instagram`,`tiktok`), handle, ingest (`api`,`manual`) |
| `social_snapshots` | account_id, day date, followers, views, followers_exact bool; UNIQUE(account_id, day) |
| `projects` | slug, title, sort |
| `inbox_items` | id, kind (`approval`,`routing`,`calendar`,`contact_match`), ref_table, ref_id, title, status (`open`,`done`), created_at, resolved_at |
| `push_subscriptions` | id, endpoint UNIQUE, keys jsonb, created_at |

### 3.2 Agent system
| Table | Key columns |
|---|---|
| `tasks` | id, parent_id, source (`console`,`agent_request`,`schedule`,`github`,`pipeline`), owner_text (private), public_title, is_private bool, status (`queued`,`planning`,`in_progress`,`waiting`,`merged`,`done`,`failed`,`cancelled`), waiting_on (`dev`,`ci`,`qa`,`owner`,`deploy`, null), thread_id UNIQUE, agent, github_issue, pr_number, branch, head_sha, attempts, created_at, updated_at |
| `agent_events` | id, ts, task_id, agent (`orchestrator`,`developer`,`qa`,`scraper`,`docs`,`router`), event_type (section 4.4), detail jsonb (private) |
| `approvals` | id, task_id, kind (`critical_pr`,`agent_request`,`seed_list`,`issue_text`), reasons text[], status (`pending`,`approved`,`rejected`), decided_at, note |
| `usage_events` | id, ts, kind (`model`,`actions_minutes`), agent, provider, model, input_tokens, output_tokens, minutes, cost_usd, task_id, dedupe_key UNIQUE (0004; `github:workflow_run:<run id>:<attempt>` for relay-recorded Actions minutes) |
| `model_prices` | provider, model, usd_per_mtok_in, usd_per_mtok_out, effective_from (filled from the vendor price pages, never hardcoded) |
| `inbound_events` | delivery_id PK, source, received_at (dedupe) |
| `system_flags` | key PK, value jsonb (`agents_paused`, `pipelines_paused`), updated_at |
| view `v_public_agent_events` | id, ts, agent, event_type, task_no, title = CASE WHEN is_private OR public_title IS NULL THEN 'Private task' ELSE public_title END |

### 3.3 Essays
| Table | Key columns |
|---|---|
| `essay_prefs` | id=1, types text[], lengths text[] |
| `sources` | id, name, base_url, feed_url, sitemap_url, archive_url, extractor_id, crawl_rules jsonb (min_delay_ms, allow_paths, robots_cached_at), health (`ok`,`degraded`,`broken`), last_checked_at, last_ok_at |
| `essay_urls` | url PK, source_id, first_seen_at, status (`new`,`fetched`,`quarantined`,`link_only`,`failed`), attempts |
| `seed_items` | id, title, author, year, suggested_url, list_refs text[], status (`draft`,`approved`,`rejected`), essay_id |
| `essays` | id, kind (`full`,`link`), title, author, year, source_id, source_url, word_count, length_band (generated), reading_minutes, hook, text_s3_key, text_hash UNIQUE, minhash int[], language, status (`active`,`quarantined`,`pending_category`), seed_item_id |
| `essay_categories` | essay_id, type, confidence, model, PRIMARY KEY(essay_id, type) |
| `quarantine` | id, essay_url, essay_id null, reasons jsonb, github_issue, created_at, resolved_at |
| `ratings` | essay_id PK, stars 1..5, worked text[], length_felt (`too_long`,`right`,`too_short`), rated_at |
| `reading_progress` | essay_id PK, pct, updated_at |
| `quality_reports` | week date PK, counts jsonb |

### 3.4 DB roles
- `web_rw`: web Lambda, all app tables.
- `web_public`: SELECT on `v_public_agent_events` only; used by public API routes.
- `orch_rw`: agent tables, the `lg` schema, read on `contacts.name`/`aliases` for the sanitizer, and INSERT (only) on `inbox_items` for approvals (0003).
- `pipeline_rw`: essays tables, plus insert on `tasks` and `agent_events`.
- `migrator`: DDL; deploy only.

Login users are made outside migrations, one per runtime (`migrator_app` owns the prod database; `web_app`, `web_public_app`, `orch_app`, `relay_app` are members of one group role each): [runbooks/prod-db.md](runbooks/prod-db.md).

The CI project has the same roles with synthetic data.

## 4. Agent system

### 4.1 Agents
| Agent | Runs | Trigger | Input | Output | Model | GitHub App permissions (single repo) |
|---|---|---|---|---|---|---|
| Orchestrator | Lambda | SQS `orchestrator-in` | task / event | issues, dispatches, merges, events, inbox items | Haiku 5.5 | Contents RW (merge), Pull requests RW, Issues RW, Actions RW (dispatch/cancel), Checks RW (post `kcw/merge-rules`), Commit statuses R, Metadata R. **Webhook active** → relay; events: issues, pull_request, pull_request_review, workflow_run, push |
| Developer | Actions `agent-developer.yml` | `workflow_dispatch` {task_id, issue, mode=`implement`/`fix`, pr} | issue body + `docs/agents/developer.md` | branch `kcw/task-<id>`, PR "Closes #n" | `claude-haiku-5-5` | Contents RW, Pull requests RW, Issues RW, Metadata R. **No Workflows.** Webhook inactive |
| QA | Actions `agent-qa.yml` | dispatch {task_id, pr} after CI is green | PR diff, DESIGN.md, `docs/agents/qa.md` | test commits on the PR branch, then a review (approve / request changes) | Haiku 5.5 | Contents RW, Pull requests RW, Checks R, Metadata R. Webhook inactive |
| Scraper-builder | Actions `agent-scraper.yml` | dispatch from a quarantine issue or new-source task | source record, failing URL, public-domain fixtures | PR with `pipelines/extractors/<site>/` | Haiku 5.5 | Contents RW, Pull requests RW, Issues RW, Metadata R. Webhook inactive |
| Docs-keeper | Actions `agent-docs.yml` | dispatch after each merge (not for its own PRs) | merged diff, AGENTS.md, docs | PR updating AGENTS.md, DESIGN.md, `docs/agents/*` | Haiku 5.5 | Contents RW, Pull requests RW, Metadata R. Webhook inactive |
| Router / Categorizer | web / pipeline Lambdas | new entry / new essay | text | label + confidence | Jev, Haiku 5.5 fallback | none |

**Ruleset `main-protection`** (owner applies it from `docs/runbooks/github-apps.md`; `scripts/check-repo-settings.ts` fails CI on drift):
- PR required; 1 approval; dismiss stale approvals on.
- Required checks: `ci/required` (expected source: GitHub Actions) and `kcw/merge-rules` (expected source: orchestrator App).
- Squash only; block force pushes and deletions; empty bypass list.
- "Require approval of the most recent reviewable push" stays **off**, because QA pushes tests and then approves.

The PR author (Developer App) can never approve its own PR. Whether a GitHub App's approval counts toward required reviews is unconfirmed in GitHub's docs; P2-07 tests it live and has a fallback.

**Workflow auth pattern** (every agent workflow, job-level `permissions: id-token: write, contents: read`):
1. `aws-actions/configure-aws-credentials@v6` assumes role `kcw-gh-agent` (OIDC).
2. `aws-actions/aws-secretsmanager-get-secrets@v3` reads only that agent's App secret (values masked).
3. `actions/create-github-app-token@v3` with `client-id` (repo variable) and the private key mints the agent's App token (1 h, this job only).
4. `actions/checkout`: trusted config from `main` (see below), plus the PR head when needed.
5. `anthropics/claude-code-action@v1` with these inputs:
   - `github_token`: the App token, plus `bot_id`/`bot_name`.
   - `anthropic_federation_rule_id` and `anthropic_organization_id` (+ optional `anthropic_service_account_id`) from repo variables. No `anthropic_api_key`.
   - `claude_args: --model claude-haiku-5-5 --max-turns <n> --allowedTools "Bash(pnpm:*),Bash(git:*),..."`. Bash is off by default; the per-agent allowlist lives in its playbook.
   - `plugins` / `plugin_marketplaces` for plugins (repo `.claude/settings.json` and `.claude/skills/` load automatically).
   - `allowed_bots`: the orchestrator App's bot login (the only dispatcher).
   - `show_full_output: false`.
6. `kcw-report` posts events and usage to SQS.

`timeout-minutes: 50` (D18).

**Trusted config:** on PR events the action restores `.claude/`, `CLAUDE.md` and `.mcp.json` from the base branch. Our agents run on `workflow_dispatch`, so we do the equivalent ourselves:
- QA and Docs-keeper always run with `CLAUDE.md`, `.claude/` and `docs/agents/*` from `main`, and read the PR head as data.
- Consequence: a change to a skill, playbook or CLAUDE.md takes effect only after it merges. A PR can never change how it is itself reviewed.
- The Developer works on its own branch; changes it makes to `.claude/**` are flagged by merge-rules as critical (they change agent permissions and behavior).

### 4.2 PR loop (one subtask)
1. The owner creates a task in the boss console. This writes a `tasks` row and sends the SQS message `{type: task.created}`.
2. Orchestrator:
   - Checks `agents_paused` and the 4-in-flight limit (D20).
   - Plans: splits the task into subtasks, each a child `tasks` row.
   - Writes the public title and runs the sanitizer (4.5).
   - Creates the GitHub issue with sanitized text only. If the sanitizer fails, it creates `approvals(kind=issue_text)` and interrupts with `wait=owner`.
   - Dispatches `agent-developer.yml`, records event `task_assigned`, then `interrupt(wait=dev)`.
3. The Developer workflow opens PR `kcw/task-<id>`. Webhook `pull_request.opened` → relay → resume. Events `pr_opened` and `ci_running`, then `interrupt(wait=ci)`.
4. `ci.yml` (same-repo PRs only):
   - lint + unit + build;
   - Neon branch `preview/pr-<n>` (CI project, TTL) + migrations + seed;
   - `terraform apply infra/preview`;
   - Playwright against `https://pr-<n>.preview.kentcrosswise.com`;
   - teardown (`if: always()`);
   - prod `terraform plan` with the read-only role;
   - summary artifact for merge-rules;
   - `ci/required` check.
5. `workflow_run.completed` → resume.
   - Failed: event `tests_failed`. If attempts < 3, dispatch the Developer with `mode=fix` and go back to step 3; otherwise send an approval to the owner (`failed`).
   - Passed: dispatch QA, then `interrupt(wait=qa)`.
6. QA pushes tests (CI reruns; the orchestrator records those results but does not act on them while waiting on QA) and submits a review. `pull_request_review.submitted` → resume. Changes requested → Developer `fix` (counts toward attempts). Approved → step 7.
7. Merge-rules runs on the latest head SHA (diff + plan summary).
   - Critical: `kcw/merge-rules` stays pending; create `approvals(kind=critical_pr, reasons)`; inbox item + push notification; event `waiting_on_owner`; `interrupt(wait=owner)`.
   - Not critical, or owner approved: check success → squash merge → event `merged`.
8. Push to main → `deploy.yml` (environment `prod`): migrate, `terraform apply infra/prod`, upload the OpenNext build, report `deployed`. The orchestrator then dispatches Docs-keeper, whose PR goes through steps 3-7. The parent task is `done` when all children are merged.

### 4.3 Resuming from interrupts
- **Threads:** each task is one LangGraph thread (`thread_id = task-<id>`), checkpointed in Neon (`lg` schema; **verify** the JS checkpointer package and the `interrupt()` / `Command({ resume })` API).
- **Routing events to a thread:** the relay and workflow reports resolve the task from `branch`, `pr_number` or the `task_id` input. They enqueue `{thread_id, resume: {event, head_sha, payload}}` with `MessageGroupId = thread_id` and `MessageDeduplicationId = delivery id`.
- **Stale events:** on resume the graph checks that the event matches `tasks.waiting_on` and `head_sha`. Stale or unexpected events are recorded and the thread re-interrupts unchanged.
- **Owner decisions:** the inbox enqueues `{type: "owner.decision", task_id, thread_id, resume: {approval_id, decision}}`. The graph applies it only if the thread waits on that approval and `approvals.status` already holds that decision; otherwise it is stale.
- **Sweep message** (P2-10 contract for P2-17): `{type: "sweep", task_id, thread_id}` per waiting or queued task. The graph decides itself whether a wait has timed out, retries a queued start (pause, in-flight limit) or an incomplete merge step, and runs inputs deferred while paused.
- **Sweeper** (EventBridge, every 15 min):
  - Tasks waiting longer than their limit (dev 60 min, ci 90, qa 60, owner never) get a `timeout` resume. The graph redispatches once, then fails the task to the inbox.
  - Cancels running agent workflows when `agents_paused` is set.
  - Dispatches `preview-gc.yml` nightly.
- **Pause-all** (`agents_paused`): no new dispatches, and in-flight agent runs are cancelled. Resumes queue up and are processed on unpause. `pipelines_paused` is a separate switch (Q2).

### 4.4 Event types (office animations)
`task_assigned`, `coding`, `pr_opened`, `ci_running`, `tests_failed`, `ci_passed`, `qa_reviewing`, `changes_requested`, `approved`, `merged`, `deployed`, `waiting_on_owner`, `failed`. Defined once in `@kcw/core/events`.

### 4.5 Public sanitization
There are two public surfaces: the office feed **and GitHub itself** (issues, PRs and CI logs are public).
1. The planner writes `public_title` from the task: product-level, no people, no personal facts, max 60 chars.
2. A deterministic check (`@kcw/core/sanitize`):
   - ASCII printable only, length <= 60;
   - rejects emails, phone numbers, URLs, digit runs > 4 and @handles;
   - rejects any token matching a contact name or alias (case-insensitive);
   - rejects a configurable blocklist.
3. On failure: the feed shows `Private task`, and GitHub issue text goes to an `issue_text` approval.
4. `is_private` defaults to true for every task, including capture-box `agent_request` entries (Q4) and console tasks (Q9). The owner can toggle it.
5. The feed endpoint `/api/public/agent-events?since=` uses the `web_public` role; CloudFront TTL is 5 s.
6. Workflows never print secrets or essay text, and `show_full_output` stays false. Extractor tests use public-domain fixtures only.

## 5. Terraform

Terraform >= 1.11 (S3 native locking `use_lockfile = true`, no DynamoDB). ACM certificates come from an `aws` provider alias `us_east_1`. The Route 53 hosted zone created by domain registration is **imported**, not recreated.

```
infra/bootstrap/   applied once by the owner locally (local state, then migrated to S3)
  - S3 state bucket kentcrosswise-tfstate-<account> (versioned, encrypted, public access blocked)
  - GitHub OIDC provider (audience sts.amazonaws.com, no thumbprint)
  - IAM roles (trust table below)
  - Secrets Manager secret containers (no values; the owner fills them)
  - ACM cert (us-east-1): kentcrosswise.com, *.kentcrosswise.com, *.preview.kentcrosswise.com; DNS validation
infra/modules/
  web/           own module for OpenNext v4 output: assets bucket, server Lambda + public Function URL
                 guarded by the x-kcw-origin header (D25), image-optimization Lambda + Function URL (OAC),
                 revalidation SQS, CloudFront, Route 53 alias
  orchestrator/  orchestrator Lambda, SQS FIFO + DLQ, relay Lambda + Function URL, IAM
  pipelines/     watcher, runner Lambda, SQS essay-urls + DLQ, private essay-text bucket
  scheduler/     EventBridge schedules
  secrets/       data lookups + IAM read policies per consumer
infra/prod/      composition of all modules; backend key prod.tfstate
infra/preview/   web module only + SSM SecureString for the DB URL (D21); var pr_number; backend key preview/pr-<n>.tfstate
```

OIDC role trust. The repo is new, so the immutable `sub` applies. Prefix `P` = `repo:<OWNER>@<OWNER_ID>/kentcrosswise@<REPO_ID>`, and every role also requires `aud = sts.amazonaws.com`.

| Role | `sub` (StringEquals) | Permissions |
|---|---|---|
| `kcw-gh-ci` | `P:pull_request`, `P:environment:preview-gc` (the `preview-gc.yml` sweep job, which runs on main for dispatch/schedule; an environment keeps agent workflows on main out) | create/destroy resources tagged `kcw:env=preview` with name prefix `kcw-pr-*`; put/delete SSM parameters under `/kcw/preview/*`; read secret `kcw/ci`; preview state keys |
| `kcw-gh-plan` | `P:pull_request` | read-only on prod resources + read prod state (for the prod plan) |
| `kcw-gh-deploy` | `P:environment:prod` | full prod apply; read `kcw/prod/migrator` |
| `kcw-gh-agent` | `P:ref:refs/heads/main` (agent workflows are dispatched on main without an environment) | read `kcw/github/*-app` (one statement per App secret); `sqs:SendMessage` on `orchestrator-in` |

The `pull_request` and `environment` immutable forms are **verify**; P1-10 checks them live. The Anthropic federation rule uses the same prefix `P`.

Preview lifecycle (`ci.yml`, composite action `.github/actions/neon-preview`):
1. `neondatabase/create-branch-action@v6`:
   - project = `vars.NEON_CI_PROJECT_ID`, parent `base`, `branch_name: preview/pr-<n>`;
   - `api_key` from Secrets Manager (`kcw/ci`);
   - `expires_at` = now + 3 h.
   - Output `db_url_pooled` is masked explicitly with `::add-mask::` (auto-masking unverified).
2. `migrate` + `seed`.
3. `terraform -chdir=infra/preview init -backend-config=key=preview/pr-<n>.tfstate`, then `apply -var pr_number=<n> -var database_url=...`. The module stores the URL in the SecureString parameter `/kcw/preview/pr-<n>/database-url` (D21). Only that PR's server Lambda role can read it, and it is deleted on destroy.
4. Playwright.
5. Teardown (`if: always()`): `terraform destroy`, `neondatabase/delete-branch-action`, and deletion of the state object.
6. `preview-gc.yml` (on PR closed + nightly dispatch) destroys any `kcw-pr-*` resources and `preview/*` branches without a running CI job.

**Branch budget (Neon Free, 10 per project):**
- The CI project uses `base` plus one spare, which leaves **8 concurrent previews at most**.
- Previews live only for the length of a CI run, and `ci.yml` uses `concurrency: pr-<n>` with cancel-in-progress.
- The orchestrator keeps at most 4 agent PRs in flight (D20), which leaves room for owner PRs.

**Owner-only e2e login:** preview builds enable a credentials provider keyed by `kcw/ci` (`e2e_login`), compiled in only when `KCW_ENV=preview`. `deploy.yml` asserts that the prod bundle does not contain it.

## 6. Secrets (Secrets Manager, one JSON secret per consumer, D19)

| Name | Keys | Read by |
|---|---|---|
| `kcw/prod/web` | auth_secret, google_client_id, google_client_secret, owner_email, vapid_public, vapid_private, db_url, db_url_public | web Lambda |
| `kcw/prod/models` | anthropic_api_key, typesafe_api_key, langsmith_api_key | web, orchestrator, pipeline Lambdas (runtime only; agents use federation) |
| `kcw/prod/orchestrator` | db_url, github_app_client_id, github_app_installation_id, github_app_private_key | orchestrator Lambda |
| `kcw/prod/relay` | db_url | webhook relay Lambda (delivery dedupe, task lookup; its own secret so the relay cannot read the orchestrator App key) |
| `kcw/prod/pipeline` | db_url | pipeline Lambdas |
| `kcw/prod/migrator` | db_url | `deploy.yml` |
| `kcw/prod/origin-verify` | origin_verify (D25) | web Lambda; prod Terraform (`kcw-gh-plan`, `kcw-gh-deploy`) to configure CloudFront |
| `kcw/prod/google-owner-token` | refresh_token (written by web at consent) | web (Calendar), social Lambda (YouTube) |
| `kcw/prod/social/instagram` | app_id, app_secret, long_lived_token (rewritten on each refresh) | social Lambda (read + write) |
| `kcw/prod/social/tiktok` | client_key, client_secret, refresh_token (rewritten; may rotate) | social Lambda (read + write) |
| `kcw/github/webhook-secret` | secret | relay Lambda |
| `kcw/github/developer-app`, `qa-app`, `scraper-app`, `docs-app` | private_key | the matching `agent-*.yml` only (App client ids are repo variables) |
| `kcw/ci` | neon_api_key (project-scoped to `kentcrosswise-ci` if available), e2e_login | `ci.yml`, `preview-gc.yml`; e2e_login also in the preview web Lambda |
That is 16 fixed secrets (the 14 of D19 plus `kcw/prod/origin-verify`, D25, and `kcw/prod/relay`, P2-05/P2-06). There is no Anthropic key for agents: they use federation (D16). The per-PR preview DB URL is not a Secrets Manager secret: it is the SSM SecureString `/kcw/preview/pr-<n>/database-url`, read only by that preview's web Lambda (D21).

When the owner pastes a value, it goes into the named secret under the listed key (console "Key/value" view). `docs/SETUP.md` uses these names.

**Bootstrap exceptions (explicit):**
1. The owner's own AWS credentials (an SSO profile, or an IAM user with MFA if the account stays on the Free plan, Q5) apply `infra/bootstrap` once. They are never stored anywhere.
2. The owner types the secret values in by hand: App private keys, API keys, OAuth clients.
3. The owner configures the Claude Console federation (issuer, service account(s), rule).
4. Non-secret IDs are GitHub repo **variables**: AWS account and role ARNs, App client ids, Anthropic org/rule/service-account ids, Neon CI project id.

No GitHub Actions secrets exist.

## 7. Phase 1: foundation (local sub-agents)

Conventions for every task:
- TypeScript strict; tests with Vitest.
- Scripts are Node/TS (`tsx`), not bash.
- No real secrets or private data in fixtures.
- Workflows pass `actionlint`.
- "Live DoD" steps need the owner's accounts and are done by the Liaison with the owner.

| ID | Task | Files/areas | Depends | Definition of done |
|---|---|---|---|---|
| P1-00 | OWNER setup checklist, following research/infra.md §1-§8 and research/apis.md: AWS account hardening + admin identity (Q5), domain in Route 53, budget alert, Neon projects `kentcrosswise` + `kentcrosswise-ci` (with branch `base`), GitHub repo, Anthropic org + credits, Jev and LangSmith accounts | `docs/runbooks/bootstrap.md` (written by developer, links research, no restating) | - | Runbook exists; owner ticks each item; repo owner/repo numeric IDs recorded as repo variables |
| P1-01 | Monorepo skeleton | root configs, `packages/*` empty pkgs, `AGENTS.md`, `CLAUDE.md`, `docs/agents/*.md` stubs, `.claude/settings.json` | - | `pnpm i && pnpm lint && pnpm typecheck && pnpm test` pass with one sample test per package |
| P1-02 | `@kcw/secrets` | `packages/secrets` | 01 | `getSecret(name, key?)` caches per process and parses JSON; names starting with `/` are read as SSM SecureString parameters (preview DB URL, D21); can write (for token rotation); fake for tests; unit tests for cache, missing key, error |
| P1-03 | `@kcw/core` model providers | `packages/core/models` | 01 | Interface + `AnthropicProvider`, `JevProvider` (`@typesafe-ai/sdk`, model from config, default `jev-1.13.0`; request built from api.typesafe.ai/openapi.json), `FakeProvider`, `withFallback(threshold)`; tests: fallback on low confidence, on error, after 429/529 retries, usage callback called with returned model id |
| P1-04 | DB runner + 0001 hub/essays tables + roles | `packages/db/migrations/0001_*.sql`, `runner.ts`, `scripts/migrate.ts` | 01 | Runs on PGlite in tests; idempotent; constraint tests (mood ranges, unique snapshot day, text_hash unique) |
| P1-05 | Synthetic seed + `@kcw/demo-data` | `packages/db/seeds`, `packages/demo-data` | 04 | Deterministic seeded generator (fake contacts, entries, mood series, social metrics); test: same seed = same output; grep test: no real-looking emails |
| P1-06 | Next.js 16 app skeleton + route groups | `apps/web` | 01 | `pnpm --filter web build` passes; `(public)` home and `/demo` placeholder render; ESLint rule blocks `@kcw/db` imports under `(public)` (rule test with a fixture file) |
| P1-07 | Auth | `apps/web/src/auth` | 02, 06 | Google provider (sign-in scopes only; Calendar/YouTube added later by incremental consent with `access_type=offline`); allowlist from secret; JWT session; `(owner)` layout redirects; preview-only credentials provider; unit tests for allowlist and the build flag; script asserting the prod bundle lacks the preview provider |
| P1-08 | OpenNext v4 build | `apps/web/open-next.config.ts`, `scripts/build-web.ts` | 06 | `@opennextjs/aws` pinned to 4.1.x; `open-next build` output produced locally; output layout (server, image, revalidation, assets paths) written into AGENTS.md as the contract for P1-09 |
| P1-09 | `infra/modules/web` (own module, D14) | `infra/modules/web` | 08 | Consumes the P1-08 layout: assets S3, server Lambda + Function URL with OAC, image Lambda, revalidation SQS, CloudFront behaviours, Route 53 alias; `terraform validate` + `fmt -check` pass; inputs: name prefix, domain, cert arn, artifact dir, secret names |
| P1-10 | `infra/bootstrap` | `infra/bootstrap` | 01 | validate/fmt pass; roles use the immutable `sub` table of §5 with owner/repo IDs as variables, plus `aud`; **live:** owner applies and migrates state to S3; a throwaway debug workflow on main, on a PR and in environment `prod` assumes each role (and fails for the wrong one); the actual `sub` strings are recorded in the runbook |
| P1-11 | `infra/prod` (web only for now) | `infra/prod`, `modules/secrets` | 09, 10 | validate passes; hosted zone imported; **live:** owner applies; `https://kentcrosswise.com` serves the public home |
| P1-12 | Neon preview composite action | `.github/actions/neon-preview` | 10 | Wraps get-secret + `create-branch-action@v6` (TTL, mask) and `delete-branch-action`; actionlint passes; **live:** a manual run creates and deletes `preview/pr-0` |
| P1-13 | `infra/preview` | `infra/preview`, `scripts/check-preview-clean.ts` | 09, 12 | validate passes; **live:** a manual run for `pr-0` serves the app against its Neon branch; after destroy, the script finds no `kcw-pr-0` tagged resources, no `/kcw/preview/pr-0/*` parameter, no state object and no branch |
| P1-14 | Playwright skeleton | `apps/web/e2e`, `playwright.config.ts` | 06, 07 | Runs against `BASE_URL`; tests: public home, demo page, owner route redirects when logged out, preview login works; passes locally against `next dev` |
| P1-15 | `ci.yml` | `.github/workflows/ci.yml`, `.github/actions/aws-auth` | 11-14 | Same-repo guard; `concurrency: pr-<n>`; jobs per §4.2 step 4; teardown `if: always()`; **live:** a test PR is green and the clean-check passes |
| P1-16 | `deploy.yml` + `preview-gc.yml` | `.github/workflows` | 15 | Deploy runs migrate, then apply, then upload, in environment `prod`; GC (PR closed + `workflow_dispatch`) has a dry-run mode; **live:** merging a trivial change updates prod |
| P1-17 | Repo settings checker | `scripts/check-repo-settings.ts`, `docs/runbooks/github-apps.md` | 15 | Reads the `main` ruleset via the API and compares it to the expected JSON (§4.1); unit test against fixtures; CI step (non-blocking until Phase 2) |
| P1-18 | AGENTS.md and playbooks v1 | `AGENTS.md`, `docs/agents/*.md`, `CLAUDE.md` | 01-17 | Layout, commands, rules (no private data, no secrets, Windows-safe scripts, per-agent Bash allowlist); QA reviewer confirms each command in AGENTS.md runs |

## 8. Phase 2: agent system (local sub-agents)

| ID | Task | Files/areas | Depends | Definition of done |
|---|---|---|---|---|
| P2-01 | Migration 0002: agent tables, flags, view, roles | `packages/db/migrations/0002_*.sql` | P1-04 | Tables per §3.2; test that `web_public` can select the view and nothing else; the view returns `Private task` for private/null titles |
| P2-02 | Sanitizer | `packages/core/sanitize` | P2-01 | Rules per §4.5; table-driven tests incl. contact names, aliases, emails, URLs, phone numbers, non-ASCII |
| P2-03 | Event types + `kcw-report` CLI | `packages/core/events`, `agents/report` | P1-01 | The CLI sends `{task_id, agent, event_type, usage}` to SQS; dry-run prints JSON; tests with a fake SQS client |
| P2-04 | Merge-rules | `agents/merge-rules` | P1-01 | Pure `evaluate({files, patches, planSummary, lockDiff, author}) -> {critical, reasons[]}`. One test per spec bullet: drop/rename in SQL; auth/secrets/IAM/`.github/**`/`.claude/**` paths; prod plan non-empty; any `docs/**/SPEC.md` change; new dependency not in `approved-deps.json`, or any edit to that file; new service; cost (any prod plan create). Non-critical cases: DESIGN.md, AGENTS.md, `docs/agents/*` |
| P2-05 | Webhook relay | `agents/webhook-relay` | P2-03 | Signature verification (valid/invalid/missing), delivery dedupe via `inbound_events`, sender allowlist, normalization of the 5 event types, task resolution from branch/pr; tests with synthetic fixtures |
| P2-06 | `infra/modules/orchestrator` | `infra/modules/orchestrator`, `infra/prod` | P1-11 | FIFO queue + DLQ, relay Function URL, Lambda roles reading only their secrets, LangSmith env incl. `LANGCHAIN_CALLBACKS_BACKGROUND=false`; validate passes; **live:** applied by owner |
| P2-07 | GitHub Apps + ruleset + Anthropic federation | `docs/runbooks/github-apps.md` | P1-17, P1-10 | Runbook with permissions per §4.1 (orchestrator webhook active → relay; others inactive). **Live:** (a) owner creates 5 Apps, installs them on the repo, stores keys and sets repo variables; (b) owner creates the Claude Console federation rule(s) for prefix `P`; (c) **approval test:** on a throwaway PR opened by the Developer App, a QA App approval satisfies the ruleset's 1-approval rule. If it does not count: set required approvals = 0 and make `kcw/qa` a required check posted by the QA App (approve = success, changes requested = failure), with `kcw/merge-rules` still required; record the result in DESIGN.md. (d) checker passes |
| P2-08 | Orchestrator skeleton | `agents/orchestrator` | P2-01, P2-03 | SQS handler → graph with Postgres checkpointer; a two-node graph that interrupts and resumes; test: resume works from a fresh process (new graph instance) against Postgres (PGlite if compatible, else a Neon dev branch in the CI project) |
| P2-09 | GitHub client | `agents/orchestrator/github` | P2-08 | Interface (createIssue, dispatchWorkflow, merge, postCheck, cancelRun, getDiff, getArtifact) + Octokit impl with App auth + fake; tests on the fake and request shapes |
| P2-10 | Task graph | `agents/orchestrator/graph` | P2-02, P2-04, P2-09 | Full state machine of §4.2/§4.3 on fakes: happy path, CI fail + fix, 3 failures → owner, QA changes requested, critical → owner approve/reject, stale event ignored, timeout, paused, in-flight limit of 4 |
| P2-11 | Planner + public-title nodes | `agents/orchestrator/nodes` | P2-10, P1-03 | Haiku via the provider; output schema validated; sanitizer applied; tests with FakeProvider, incl. a title containing a contact name → `Private task` |
| P2-12 | Agent workflows | `.github/workflows/agent-*.yml`, `.claude/skills/*`, `.claude/settings.json` | P2-03, P2-07 | Auth pattern of §4.1: federation (no Anthropic key), `claude_args --model claude-haiku-5-5 --max-turns --allowedTools <per-agent list>`, `plugins`/`plugin_marketplaces` inputs, `allowed_bots` = orchestrator bot, `timeout-minutes: 50`, trusted config from main for QA/Docs. Inputs task_id/issue/pr/mode. **Live:** manual dispatch on a toy issue gives a PR authored by the Developer App; QA dispatch gives a review by the QA App; the run log shows no secret values |
| P2-13 | CI hooks for merge-rules | `ci.yml` | P2-04, P1-15 | Prod plan summary + lockfile diff uploaded as an artifact; the orchestrator fetches it; **live:** artifact visible on a PR |
| P2-14 | Boss console + inbox + pause switches | `apps/web/src/app/(owner)/console`, `/inbox` | P2-01, P2-06 | Create task (private toggle), list tasks with status/events, approve/reject approvals (enqueues resume), `agents_paused` and `pipelines_paused` toggles; Playwright tests in preview |
| P2-15 | Usage panel | `apps/web/.../console/usage`, relay | P2-14 | Sums `usage_events` by agent/model/day with `model_prices`; Actions minutes from `workflow_run` durations (reported, $0 on public standard runners); tests on the aggregation SQL |
| P2-16 | Public event feed (text list) | `apps/web/src/app/api/public/agent-events`, `(public)/office` | P2-01 | Uses `web_public` only; cache headers; e2e: the feed shows only id/ts/agent/type/title |
| P2-17 | Schedules: sweeper | `infra/modules/scheduler`, orchestrator | P2-10 | 15-min sweeper per §4.3 incl. nightly GC dispatch; unit tests for timeout selection |
| P2-18 | **E2E smoke** | whole system | all | The owner enters "Add a /healthz page that returns ok" in the console. Observed in order: issue created by the orchestrator App; PR by the Developer App; CI green with the preview created and destroyed; QA App approval; merge-rules success; auto-merge; deploy; `https://kentcrosswise.com/healthz` returns ok; Docs-keeper PR merged; office feed shows the sanitized events; usage panel shows the spend. Variant: a task touching `infra/prod` lands in the inbox and merges only after approval. The Liaison verifies each step by URL or PR link |

## 9. Phases 3-6 (epics; issues for the cloud orchestrator)

**Phase 3: Hub MVP**
- Public `/terms` and `/privacy` pages (needed for TikTok domain-verified URLs; also used by Google/Meta app settings).
- Capture box (phone layout) storing raw `entries`.
- Router with Jev + Haiku fallback; inbox for low confidence; reassign + `route_corrections`.
- Contacts CRUD; linking CRM notes to contacts, with an inbox item for ambiguous matches.
- Google OAuth app **published "In production" (unverified, personal use)** so refresh tokens do not expire after 7 days; incremental consent for `calendar.events.owned`, `youtube.readonly`, `yt-analytics.readonly`; re-consent after publishing.
- Calendar suggestion extraction; one-tap add via the Calendar API.
- Diary page; mood scoring (Haiku) on save; mood board with per-metric toggles and an overall line.
- Todos and ideas lists.
- Social, YouTube: daily snapshot from `channels?part=statistics&mine=true`. `subscriberCount` is rounded (`followers_exact=false`); exact daily gains come from YouTube Analytics.
- Social, Instagram (Instagram Login, `followers_count` field, `views` insights, 48 h delay) + **scheduled long-lived token refresh every ~30 days**, writing the new token back to Secrets Manager.
- Social, TikTok **sandbox spike first** (does sandbox grant `user.info.stats` and return real numbers?). If not: manual-entry form (`ingest=manual`). Refresh-token rotation is written back to Secrets Manager.
- Social dashboard with totals and a source filter.
- Projects tabs shell.
- Web push (VAPID, manifest `display: standalone`, service worker, permission request on a tap; iOS 16.4+ Home Screen only).
- Public demo versions of the dashboard, mood board and CRM from `@kcw/demo-data`.

**Phase 4: Office + X-ray**
- X-ray registry for every component; overlay toggle with hover cards (tech, what, why).
- Pixel-art office: tile map, sprites (licensed asset pack; check the license), Canvas 2D renderer.
- Event → animation mapping for all event types.
- Feed polling, replay of the last N events on load, idle behavior, reduced-motion mode.

**Phase 5: Essays MVP**
- Preferences page; feed with infinite scroll; reader with a progress bar; link-only cards.
- Ratings form; rule-based recommender (type, author, era, worked tags) with tests.
- Seed list drafting task (~300) → `seed_items` → owner approval in the inbox.
- Source registry + watcher Lambda (robots.txt, per-site rate limit).
- Validator: exact hash, MinHash near-dup, fuzzy metadata dup, quality checks; quarantine + an issue for the Scraper-builder.
- Categorizer (Jev, Haiku fallback) and hook writer (Haiku).
- Extractors per seeded source (one issue per site, Scraper-builder).
- Nightly source health check; weekly quality report.
- Public demo with a handful of public-domain essays.

**Phase 6: Continuous expansion**
- Owner-driven feature tasks via the console; `agent_request` entries → approvals → tasks.
- Embedding-based recommendations; EPUB/PDF import; Apple Shortcut capture; spending caps; Google Voice bridge.
- Periodic dependency/security update tasks (critical by rule, so owner-approved).
- Re-evaluate the Jev model pin when `jev-latest` moves.

## 10. Unverified items: status

| ID | Item | Status |
|---|---|---|
| U1 | Jev API | **Resolved:** `POST https://api.typesafe.ai/v1/systemone`, SDK `@typesafe-ai/sdk`, choice answers carry `confidence` + `probabilities`, `jev-latest` = 1.13.0, $0.042/M input, output free (research/apis.md §5). **Open:** self-serve access ("early access"), numeric rate limits, exact field names (take them from the OpenAPI spec in P1-03) |
| U2 | Claude Code Action | **Resolved:** custom App token via `github_token`; model via `claude_args`; repo `.claude/` + CLAUDE.md load; plugins via inputs; `allowed_bots`; Bash off by default; base-branch config on PR events; federation auth (research/infra.md §6). **Open:** whether the action reports token usage/cost (R6); one federation service account per agent |
| U3 | OpenNext + Terraform | **Resolved:** `@opennextjs/aws` 4.1.12 with Next 16; no maintained Terraform module supports v4 (research/infra.md §8), hence D14 |
| U4 | LangGraph JS checkpointer and `interrupt`/`Command` API; Lambda bundle size | **Open** (P2-08). LangSmith on Lambda needs `LANGCHAIN_CALLBACKS_BACKGROUND=false` (research/apis.md §6) |
| U5 | OIDC `sub` formats | **Resolved:** immutable `repo:OWNER@ID/REPO@ID:...` for a new repo (research/infra.md §3). `pull_request`, `environment:prod` and `ref:refs/heads/main` forms confirmed live 2026-10-22, with wrong roles refused (runbooks/bootstrap.md §4). **Open:** whether fork PRs get an id-token (assume no; same-repo guard anyway) |
| U6 | Actions minutes | **Resolved:** free and unlimited on standard runners for public repos; 20 concurrent jobs; 6 h per job; schedules disabled after 60 inactive days (research/infra.md §5) |
| U7 | Neon limits | **Resolved:** Free = 10 branches per project, 100 CU-h/month per project, 1 GB, scale-to-zero after 5 min; project-scoped keys exist for org admins (research/infra.md §7). **Open:** whether a personal account has an org for a project-scoped key; v5→v6 action changes; auto-masking of `db_url` |
| U8 | Terraform S3 locking | **Resolved:** `use_lockfile` GA since 1.11; DynamoDB locking deprecated (research/infra.md §8) |
| U9 | Google OAuth token expiry | **Resolved:** Testing mode expires refresh tokens after 7 days for Calendar/YouTube scopes; publish "In production" unverified for personal use (research/apis.md §1). **Open:** exact warning flow; whether re-consent is needed after publishing |
| U10 | Social APIs | **Resolved:** YouTube (rounded `subscriberCount`), Instagram via Instagram Login (60-day token, refresh) (research/apis.md §1-§2). **Open:** Instagram development mode without App Review end-to-end; TikTok sandbox stats and production review ("must not be for private or personal use"), see R7 |
| U11 | App-triggered workflows | **Resolved:** App-token pushes, PRs and dispatches trigger workflows (research/infra.md §4) |
| U12 | AWS free tiers / costs | **Partly resolved:** `.com` $16/yr, hosted zone $0.50/month, ACM free (research/infra.md §2). **Open:** Secrets Manager price (believed $0.40/secret/month, D19) and whether it is prorated; SSM Parameter Store standard-tier SecureString pricing (believed free, D21); Lambda/CloudFront free tier |
| U13 | App approval counting toward required reviews | **Open:** not stated in GitHub's docs; tested live in P2-07, with a fallback |
| U14 | Neon Terraform provider | **Resolved, avoided:** `kislerdm/neon` archived, official provider not in the registry (research/infra.md §7); Neon stays outside Terraform (D12) |

Risks:
- R1: Creating and destroying a CloudFront distribution per PR may take many minutes. Fallback: one shared preview distribution routing `pr-<n>.preview` hosts to per-PR origins.
- R2: Public repo means prompt injection via issues/comments or via scraped pages. Mitigations: dispatch-only triggers (D6), `allowed_bots` limited to the orchestrator, no Workflows permission (D7), relay sender allowlist, scoped IAM per role, trusted config from main.
- R3: Private text could leak into GitHub issues or CI logs. Mitigations: sanitizer, issue-text approval, no DB dumps in logs, Playwright traces only on synthetic data.
- R4: Haiku 5.5 as developer may produce low-quality PRs; 3-attempt cap, then the owner.
- R5: Migrations are tested only on synthetic data (D4).
- R6: Cost visibility depends on recording every model call; Claude Code Action usage may not be reportable (federated usage is visible in the Claude Console).
- R7: TikTok production review will likely reject a personal app; sandbox may not return real stats. Manual entry is the fallback.
- R8: Enabling IAM Identity Center creates an AWS Organization, which ends Free-plan credits (Q5).
- R9: The Neon 10-branch cap; D20 and the TTL keep usage at 8 or fewer, and GC catches leaks.

## 11. Spec conflicts and open questions

Resolved by the owner (via the Liaison):
- **C1:** previews branch from the separate CI project, not prod. Accepted.
- **C2:** GitHub is a public surface. Handled by §4.5.
- **C3:** `docs/**/SPEC.md` is the product definition, and changing it is critical. Docs-keeper may update DESIGN.md, AGENTS.md and `docs/agents/*` freely.
- **Q2:** separate `agents_paused` and `pipelines_paused` switches.
- **Q3:** Haiku 5.5 for planner and hooks.
- **Q4:** capture-box agent requests are private by default.
- **Q5 (resolved 2026-10-22):** Interim `main` ruleset. Apply the `interim` profile (PR + `ci/required`, 0 approvals, same other protections) at the start of Phase 2; switch to the §4.1 `final` profile in P2-07 (`docs/runbooks/github-apps.md`). Reason: the owner cannot approve their own PRs before the QA and orchestrator Apps exist.
- **Q6 (resolved 2026-10-22):** For P2-04, "prod plan non-empty" means the `infra` list of `prod-plan-summary` is non-empty (any `infra` create also counts as cost). `artifact` changes (Lambda code, `OPEN_NEXT_BUILD_ID`, uploaded assets) are never critical. Every PR changes the web build, so the raw prod plan is never empty.
- **Q7 (resolved 2026-10-22):** Merge-rules also treats these as critical: (1) edits to its own code and data (`agents/merge-rules/**`, which includes `approved-deps.json`) and to `scripts/lib/plan-summary.ts`, which decides what counts as infra, so a PR cannot weaken the rules that judge it; (2) any change to `pnpm-workspace.yaml` (its `allowBuilds` decides which dependency install scripts run); (3) `TRUNCATE` in SQL diffs, and any migration in `packages/db/migrations/` that is modified, deleted or renamed (status modified/removed/renamed; added migrations stay non-critical unless another rule applies). Migration 0002 grants `pipeline_rw` `SELECT (id)` on `tasks`, so the pipeline can use `INSERT ... RETURNING id` to link its events; every other column stays unreadable.
- **Q8 (resolved 2026-10-22):** Defaults from P2-05, P2-06 and P2-08, accepted by the owner:
  (1) The webhook relay reads its DB URL from its own secret `kcw/prod/relay` (key `db_url`), so it cannot read the orchestrator's App key in `kcw/prod/orchestrator`.
  (2) The relay's sender allowlist (`KCW_RELAY_ALLOWED_SENDER_IDS`) holds numeric GitHub account ids, not logins, because ids never change.
  (3) A webhook delivery that the relay fails to enqueue is accepted as lost for now; the P2-17 sweeper will redeliver failed deliveries.
  (4) Issue bodies written by the orchestrator get the sanitizer's content rules (§4.5) without the 60-character limit (P2-10/P2-11).
  (5) The relay Function URL is public (AuthType NONE), because GitHub cannot sign requests with SigV4; every request is authenticated by the `X-Hub-Signature-256` check before anything else runs.
  (6) `@langchain/core`, the required peer of the LangGraph packages, is a pinned direct dependency of `agents/orchestrator` and is on `approved-deps.json`.
  (7) `esbuild` is approved for bundling the Lambda packages (dev dependency, added with the bundling task).
- **Q9 (resolved 2026-10-23):** Console tasks are private by default: the console's Private box starts checked, and only an explicit uncheck makes a task public (§4.5(4)). The column comment in migration 0002 ("console tasks set false explicitly") is stale; it stays as it is, because editing an applied migration changes its checksum.
- **Q10 (resolved 2026-10-23):** `@octokit/rest` and `@octokit/auth-app` are approved (exact names, on `approved-deps.json`) as dependencies of `agents/orchestrator` for the P2-09 GitHub client.
- **Q11 (resolved 2026-10-23):** (1) The orchestrator's installation token is scoped to this repository and to the permissions its calls need (actions, checks, contents, issues write; pull_requests, metadata read), a subset of §4.1. (2) Merge-rules never runs on partial data: an incomplete file list, a missing `merge-rules-input` artifact (`no_run`/`no_artifact`) or CI not finished on the head makes the merge step wait (retried on the next CI event or sweep); after `INCOMPLETE_INPUT_TIMEOUT_MINUTES` (90, the CI limit) the PR is critical with the reason, which creates an approval and an inbox item.
- **Q13 (P2-15 defaults, 2026-10-23):** Usage panel (`/console/usage`, aggregation SQL in `apps/web/src/server/usage.ts`).
  (1) Cost of a model usage row: a stored `usage_events.cost_usd` wins; otherwise tokens × the `model_prices` row of the same provider+model with the latest `effective_from` on or before the event's UTC day; otherwise "no price" (counted, never shown as $0). Writers leave `cost_usd` null today (orchestrator `addUsage`), so prices entered later apply retroactively.
  (2) Actions minutes are recorded by the webhook relay for every `workflow_run.completed` from an allowlisted sender, with or without a task (deploys count too): one row per run attempt, `minutes` = wall-clock `run_started_at` → `updated_at` (not GitHub's per-job billable minutes), `cost_usd = 0`, deduped by `dedupe_key`. Agent = the workflow file (`agent-developer.yml` → developer, `agent-qa.yml` → qa, `agent-scraper.yml` → scraper, `agent-docs.yml` → docs), anything else → orchestrator. Agent workflows should not also send `kcw-report --minutes`, or the panel counts those minutes twice.
  (3) Days and ranges are UTC; default range is the last 30 days, at most 366.

Open:
- **Q12 (proposed in P2-11, 2026-10-23; owner to confirm):** Subtasks (§4.2 step 2). (1) The planner (Haiku, `@kcw/orchestrator/nodes`) splits a top-level task into 1 to 5 subtasks; a subtask is never split again. (2) One subtask: the task runs the PR loop itself, with no child row. (3) Two or more: one child `tasks` row each (`parent_id`, source and `is_private` copied, the subtask text as its private `owner_text`, thread `task-<id>`); the orchestrator starts each child's thread right after the split, and each child runs the public-title node and the PR loop on its own branch `kcw/task-<child id>`. (4) A parent with children holds no in-flight slot (D20 counts only tasks without children), so a split cannot deadlock the limit. (5) The parent waits with status `waiting`, `waiting_on` null; the next sweep after every child has ended sets it `done` (all merged) or `failed` (any child failed or was cancelled), so the parent can lag its last child by up to one sweep interval. (6) Model output is validated by hand (no schema library); an invalid answer is retried once with the error, then the task goes to the owner as a failure (`critical_pr` approval: approve plans again, reject fails the task). Provider errors fail the step and SQS redelivers the message.
- **Prod migrations skipped until the prod DB is wired (2026-10-22, temporary).** `kcw/prod/migrator` has no `db_url` yet, so `deploy.yml` runs `pnpm migrate --secret kcw/prod/migrator --skip-if-unset`: a missing secret value, key or non-`postgres://` value logs a notice ("Migrations skipped") and the deploy continues; access errors still fail. Remove `--skip-if-unset` once the owner fills `kcw/prod/migrator` (and `db_url` in `kcw/prod/web`).
- **Nightly preview GC before the sweeper.** `preview-gc.yml` has an interim nightly `schedule` until P2-17's sweeper dispatches it; drop the schedule then.
- **C4 / Q1 (resolved 2026-10-22):** Owner chose an allowlist. `agents/merge-rules/approved-deps.json` lists pre-approved npm packages (exact names or scopes like `@aws-sdk/*`), seeded in P1-01 with the stack's libraries. A new dependency on the list is not critical; one off the list is critical. Editing the list itself is critical (owner-approved).
- **Q5:** Admin identity: IAM Identity Center (ends Free-plan credits) or an IAM user with MFA?
- **Relay DB role (2026-10-23).** No group role from 0001-0003 matches the relay exactly (it needs INSERT, DELETE, SELECT (delivery_id) on `inbound_events` and SELECT (id, pr_number, github_issue) on `tasks`). Until the owner approves a migration adding `relay_rw` with just those grants, `relay_app` is a member of `orch_rw` ([runbooks/prod-db.md](runbooks/prod-db.md) §3.3).
