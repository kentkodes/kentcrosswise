# Repository instructions

Read this guide, [CONTINUITY.md](CONTINUITY.md), and the current [project handoff](../HANDOFF.md) before starting or resuming work. These are the canonical repository instructions for every model and tool. Docs-keeper maintains them; root `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` are thin entrypoints only.

Product specs: [hub](../hub/SPEC.md), [essays](../essays/SPEC.md). Design and tasks: [DESIGN.md](../DESIGN.md). Read the relevant role playbook: [Developer](developer.md), [QA](qa.md), [Scraper-builder](scraper.md), or [Docs-keeper](docs.md). For any web change, every model must also read [apps/web/AGENTS.md](../../apps/web/AGENTS.md), including its generated Next.js block. Owner [runbooks](../runbooks/) describe live operations; they grant agents no permission to run them.

## Scope and runtime

Follow current user instructions and the assigned task's scope within the permission boundaries below. Role behavior is independent of model/provider. Cloud dispatch uses the GitHub App identities and Claude Code Action runtime selected in DESIGN §4.1; local sessions use their explicitly assigned role and authorization. Neutral instructions do not migrate runtime, authentication, Apps, tools, or permission policy.

The Bash allowlists in role playbooks describe the current Claude Code Action adapter (`--allowedTools`), not a universal tool API. Keep their restrictions when using another tool surface; tool availability is not permission. If a required operation is unavailable, report the missing capability and an explicit fallback for the Liaison/owner. No native agent universally discovers all three entrypoints; supply the canonical guide path explicitly when the tool does not load one.

Governance instructions, the trusted automation and configuration closure and every `pnpm-lock.yaml` edit are owner-critical (rule 10). Review instruction changes against pinned trusted configuration and preserve role boundaries; the [security cutover](../runbooks/agent-security-cutover.md) records the source boundary.

## Toolchain

- Node 24 (`.nvmrc`; `engines` requires >= 22.12 because Vitest 5 and Kysely 0.29 need it; `engine-strict` is on, so an older Node fails `pnpm install`).
- pnpm 12 (`packageManager` in `package.json`). Build scripts of dependencies are blocked unless listed under `allowBuilds` in `pnpm-workspace.yaml`.
- TypeScript 6.0 (strict). typescript-eslint does not support TypeScript 7 yet; do not upgrade past 6.0.x. ESLint 9.
- Workspace packages are consumed as TypeScript source (`exports` points at `src/*.ts`); there is no build step for them. Next.js transpiles them (`transpilePackages`), Vitest and `tsx` run them directly.
- Terraform 1.16 (CI pins 1.16.6). Providers are locked for linux, windows and darwin in each stack's `.terraform.lock.hcl`.
- Everything runs on Windows and Linux: CI is Ubuntu, local agents may be on Windows.

## Commands (from the repo root)

Everyday (no credentials needed):

| Command | What it does |
|---|---|
| `pnpm install` | Install everything (CI: `pnpm install --frozen-lockfile`) |
| `pnpm lint` | ESLint over the whole repo (one flat config: `eslint.config.js`) |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm test` | Vitest, every workspace package is a project (`vitest.config.ts`) |
| `pnpm vitest run --project @kcw/db` | One package's tests (project = package name; the app is `web`, repo scripts are `@kcw/scripts`) |
| `pnpm --filter web build` | Production build of the Next.js app |
| `pnpm --filter web dev` | Local dev server (`http://localhost:3000`) |
| `pnpm migrate --pglite .pglite/dev` | Apply migrations to a local PGlite directory (`pnpm migrate --help`: also `--secret <name>`, `DATABASE_URL`, `--dry-run`, `--skip-if-unset`) |
| `pnpm seed --pglite .pglite/dev` | Insert the synthetic seed |
| `pnpm build-web` | OpenNext v4 build of `apps/web` into `apps/web/.open-next` + contract check (see below). Prod by default (also fails if the preview login is in the bundle); `KCW_ENV=preview pnpm build-web` for previews |
| `pnpm build-lambdas` | esbuild bundles of the orchestrator, webhook relay and sweeper Lambdas into `agents/orchestrator/dist`, `agents/webhook-relay/dist` and `agents/orchestrator/dist-sweeper` (`index.mjs`, ESM, node24, AWS SDK bundled), then imports each in a clean Node process to check it loads. infra/prod deploys these directories: run it before a prod plan/apply |
| `pnpm check-prod-bundle` | Fails if the built web app (`.next`, `.open-next`) contains the preview login provider; run after every prod build |
| `pnpm --filter web e2e` | Playwright (`apps/web/e2e/*.e2e.ts`). No `BASE_URL`: starts `next dev` as a preview build with a fixed local login token. `PW_SERVER=start`: uses `next start` (run `KCW_ENV=preview pnpm --filter web build` first). `BASE_URL=https://...`: targets a deployed site; add `KCW_E2E_LOGIN` for a preview (CI does). First time: `pnpm --filter web exec playwright install chromium` |
| `pnpm plan-summary --plan-json <file> --out <file>` | Summarizes `terraform show -json` output into infra vs build-artifact changes (the trusted `prod-plan` job of `preview-trusted.yml` feeds it to `merge-input`) |
| `pnpm merge-input --pr <n> --head-sha <sha> --plan-summary <file> --base-lock <file> --head-lock <file> --out <file>` | Writes `merge-rules-input.json` (format 2; needs `GITHUB_TOKEN`, `GITHUB_REPOSITORY`): PR and head, the plan summary, the PR's `infra/` and `.github/` paths from the files API (`uncoveredPaths`) plus the lockfile diff (direct dependencies added per workspace package, from the `importers` of the base vs head `pnpm-lock.yaml`; npm aliases count as the aliased package, git/URL/file sources never match the allowlist). The trusted `prod-plan` job of `preview-trusted.yml` uploads it as artifact `merge-rules-input`; name, shape and parser are in `@kcw/core/merge-input` |
| `pnpm restore-rehearsal --isolated [--secret <name>]` | Owner: verifies a restored, isolated database (migrations recorded with matching checksums and none pending; row counts of hub, essays and agent tables; counts only; refuses without `--isolated` and for `prod` secret names; exits 1 on failure) |
| `pnpm exec tsx scripts/vapid-keys.ts --secret <name> [--rotate]` | Gated secret write (owner-approved, AWS credentials): generates the Web Push VAPID keys and stores them in the web secret (`vapid_public`, `vapid_private`); prints one fixed line, refuses to overwrite existing keys without `--rotate` (rotating invalidates every push subscription). `--help` prints the usage only |
| `pnpm smoke-check --url https://<host> [--build-file apps/web/.open-next/kcw-build.json]` | `/`, `/demo`, `/office` and `/bot` return 200 (with `--build-file`, also carry that build id), `/hub` redirects to sign-in (retries for CloudFront) |
| `pnpm check-repo-settings --profile interim` | Compares the `main` ruleset on GitHub with `scripts/repo-settings/` (exit 1 on drift, e.g. while no ruleset exists) |
| `terraform fmt -check -recursive infra` | Terraform formatting |
| `terraform -chdir=infra/prod init -backend=false` then `terraform -chdir=infra/prod validate` | Validate a stack (`prod`, `preview`, `bootstrap`). Needs a prior `pnpm build-web` (the web module reads `apps/web/.open-next`). If `init -backend=false` fails with "No valid credential sources found" (the directory was initialised with the S3 backend, e.g. in the owner's checkout), set `TF_DATA_DIR` to a scratch directory for both commands |
| `actionlint` | Lint workflows and composite actions (download the release binary; it is not a dependency; run from the repo root so local actions are checked) |

CI and owner only (need AWS or GitHub admin credentials; locally use `--help`):

| Command | What it does |
|---|---|
| `pnpm check-preview-clean --pr <n>` | After a preview teardown: fails if any `kcw-pr-<n>` resource, `/kcw/preview/pr-<n>/` parameter, state/lock object or Neon branch is left. Tagged ARNs are confirmed with a get/describe call per type (`scripts/lib/tagged-resource.ts`): a confirmed not-found is ignored (the tagging index lags deletes), anything else counts, with its reason (`--retries`, `--retry-delay` to wait for deletes in progress; `--skip-neon`) |
| `pnpm preview-gc find` / `delete-neon --pr <n>` | Preview leftovers per PR and which to clean (closed, or older than 24 h); delete a preview Neon branch |
| `pnpm apply-repo-settings --profile interim --dry-run` | Owner only: create/update the `main` ruleset ([docs/runbooks/github-apps.md](../../docs/runbooks/github-apps.md)) |

PGlite DB tests take ~2 s per fresh database; reuse one per `describe` where possible.

## CI/CD (`.github/workflows`)

| Workflow | Trigger | What | AWS role (OIDC) |
|---|---|---|---|
| `ci.yml` | every PR | `checks` (lint, typecheck, test, Next build, terraform fmt, repo-settings check non-blocking); same-repo PRs also `candidate-build` and `candidate-prod-build` (credential-free, AR1 slices 2 and 3); `ci/required` aggregates them and is the required check | none: no `pull_request` job can assume an AWS role (the prod plan runs only in `preview-trusted.yml`) |
| `preview-trusted.yml` | `workflow_run` of `ci` (AR1 slice 2; definition from `main`) | `verify` (artifact and PR checks, no credentials), `provision` (restore dump, extract build as data, apply `infra/preview` for the PR number), `prod-plan` (AR1 slice 3: main's `infra/prod` planned with the verified prod build as data; writes the merge-rules input), `e2e` (candidate tests, environment `preview-e2e`, no AWS), `teardown`, `result` (status `kcw/trusted-preview`, informational; merges verify the run itself) | `kcw-gh-ci` through environment `preview-gc` (provision, teardown); `kcw-gh-plan` through environment `prod-plan` (prod-plan) |
| `deploy.yml` | push to `main` (environment `prod`) | prod `build-web` and `build-lambdas` (before anything credentialed), strict prod migrate using `kcw/prod/migrator` (missing or invalid configuration fails deployment), `terraform apply infra/prod` (uploads the builds), CloudFront invalidation of `/*`, build-id smoke check | `kcw-gh-deploy` |
| `preview-gc.yml` | `pull_request_target` closed (default-branch definition and checkout, same-repo PRs); nightly; manual (`dry_run`, default true) | removes preview leftovers of closed PRs or older than 24 h, then `check-preview-clean` | `kcw-gh-ci` (both jobs run in environment `preview-gc`) |
| `essay-ingest.yml` | manual, `main` only (environment `essay-ingest`) | rsync Gutenberg books, extract, validate, store text in the private bucket; optional `reextract`, `categorize` and `hooks` (paid model calls, DeepSeek); `acceptance` runs only the read-only MVP report (no book ids) | `kcw-gh-essay-ingest` |
| `agent-{developer,qa,scraper,docs}.yml` | orchestrator dispatch; inert while `KCW_AGENT_WORKFLOWS_ENABLED` is not `true` | prepare, model work, publish and report jobs (see "Isolated cloud workflow boundary" below) | `kcw-gh-agent-model`, `kcw-gh-agent-{role}` |

Preview lifecycle (only `preview-trusted.yml`, one per PR, names `kcw-pr-<n>`; behaviour in DESIGN section 5): `provision` pre-cleans a stale preview of the same PR, creates Neon branch `preview/pr-<n>` from `base` in the CI project (`.github/actions/neon-preview`, 3 h TTL), restores the candidate's dump, extracts the candidate build, applies `infra/preview` (state key `preview/pr-<n>.tfstate`, DB URL in SSM `/kcw/preview/pr-<n>/database-url`), smoke checks; `e2e` runs Playwright with the synthetic login; `teardown` (always) destroys, deletes the state object and the Neon branch and runs `check-preview-clean --retries 5`. A newer push cancels the running run; its teardown still runs unless a newer head owns the preview, and the next run or `preview-gc` removes anything a cut-off teardown left.

Trusted preview (AR1 slice 2; behaviour in DESIGN section 5): `candidate-build` in `ci.yml` has no credentials; it migrates and seeds a Postgres service, dumps it (`pg_dump --inserts`), builds the preview and uploads artifact `candidate-preview` (SQL dump, pax tar of `.open-next`, manifest bound to repository, PR, head SHA and run). `preview-trusted.yml` verifies it from `main` (limits and checks in `scripts/lib/candidate-artifact.ts`), restores it with `pnpm restore-preview-db` and extracts it with `pnpm verify-candidate extract`, so the credentialed jobs never execute candidate code; only its `e2e` job does, with the synthetic login. `candidate-prod-build` likewise uploads `candidate-prod` (the Terraform inputs of `infra/prod` as a tar, `PROD_ROOTS` in the same file); the trusted `prod-plan` job plans main's infra with it and uploads `merge-rules-input` (format 2 with the PR's uncovered `infra/` and `.github/` paths). The shared check `@kcw/core/trusted-run` (also `pnpm verify-trusted-preview --pr <n> --sha <sha>`) decides which run is trusted; the orchestrator reads the input only from it.

No Playwright report or trace is uploaded: a trace would contain the typed preview login token. The prod plan JSON contains sensitive values in clear text; CI keeps only the summary.

`ci.yml` runs no prod plan. The trusted `prod-plan` job of `preview-trusted.yml` uploads `merge-rules-input` (summary, lockfile diff of the PR base vs head read as text, uncovered paths) and nothing else.

Repo variables (non-secret): `AWS_ACCOUNT_ID`, `AWS_ROLE_CI_ARN`, `AWS_ROLE_PLAN_ARN`, `AWS_ROLE_DEPLOY_ARN`, `AWS_ROLE_AGENT_DEVELOPER_ARN`, `AWS_ROLE_AGENT_QA_ARN`, `AWS_ROLE_AGENT_SCRAPER_ARN`, `AWS_ROLE_AGENT_DOCS_ARN`, `AWS_ROLE_AGENT_MODEL_ARN`, `AWS_ROLE_ESSAY_INGEST_ARN`, `KCW_AGENT_WORKFLOWS_ENABLED`, `TF_STATE_BUCKET`, `NEON_CI_PROJECT_ID`; optional `KCW_DOMAIN_NAME` (empty: CloudFront URLs, D22), `KCW_RULESET_PROFILE`, `KCW_ORCHESTRATOR_APP_ID`. There are no GitHub Actions secrets.

Every change to `main` is a squash-merged PR with `ci/required` green.

## Layout

```
apps/web/            Next.js 16 App Router app. src/app/(public) = visitor pages, src/app/(owner) = owner pages
                     The (owner) layout redirects to /api/auth/signin unless the session is the allowlisted owner.
apps/web/src/auth/   Auth.js v5 (next-auth beta): Google (prod, scopes openid email profile) + allowlist from
                     kcw/prod/web owner_email; preview builds (KCW_ENV=preview at build time) get a credentials
                     provider keyed by kcw/ci/e2e-login e2e_login instead (preview-login.ts, never in a prod bundle).
apps/web/src/server/ server-only code; origin-wrapper.ts = the x-kcw-origin guard (D25)
apps/web/e2e/        Playwright tests (public pages, owner redirect, preview login)
packages/core/       shared types; src/models = model providers (Anthropic, DeepSeek, Fake, withFallback);
                     src/merge-input = the merge-rules CI artifact contract (name, shape, parser)
packages/db/         migrations/*.sql, runner, synthetic seed (seeds/)
packages/secrets/    getSecret/putSecret (Secrets Manager; names starting with "/" are SSM SecureString)
packages/demo-data/  deterministic simulated data for public pages
packages/essays/     essays pipeline: discovery, crawl, fetch, extract (gutenberg-txt), match, validate, registry, db
packages/xray/       X-ray registry (stub)
agents/merge-rules/  approved-deps.json (dependency allowlist) and the merge-rules evaluator
agents/report/       kcw-report: the last step of every agent workflow sends usage and events to the orchestrator queue
agents/orchestrator/ SQS handler -> LangGraph graph, Postgres checkpointer in schema lg (thread = task-<id>);
                     Lambda entry src/lambda.ts. Tests run node-postgres against PGlite served over the
                     wire protocol (test/pg-socket.ts), connected as orch_rw. src/github
                     (`@kcw/orchestrator/github`) = GitHubClient interface, Octokit impl as the
                     orchestrator App (keys from kcw/prod/orchestrator; token scoped to this repo and
                     TOKEN_PERMISSIONS), FakeGitHubClient for graph tests. src/graph
                     (`@kcw/orchestrator/graph`) = the task graph (PR loop of DESIGN §4.2-§4.3:
                     machine.ts state machine, store.ts DB as orch_rw, messages.ts queue parsing).
scripts/             repo scripts (Node/TS via tsx), lib/ (logic), test/ (Vitest), repo-settings/ (expected ruleset)
infra/bootstrap/     owner-applied once: state bucket, GitHub OIDC roles, empty secrets, certificate
infra/prod/          prod composition (web + orchestrator); infra/preview/ = one per-PR web stack (D21)
infra/modules/       web (OpenNext v4, see contract below), secrets (lookups + read policy),
                     orchestrator (SQS FIFO orchestrator-in + DLQ, orchestrator Lambda on the queue,
                     webhook relay Lambda + public Function URL; code = a directory with index.mjs
                     exporting handler, passed as orchestrator_package_dir / relay_package_dir;
                     infra/prod passes the pnpm build-lambdas output; null = the stubs in stub/)
.github/workflows/   ci.yml, preview-trusted.yml, deploy.yml, preview-gc.yml, essay-ingest.yml (manual Gutenberg ingest, role kcw-gh-essay-ingest)
.github/actions/     setup (Node, pnpm, install, Terraform), neon-preview (Neon branch with the key from
                     Secrets Manager), preview-gc (find and remove preview leftovers)
docs/                specs, design, research, agent playbooks, runbooks (owner)
```

## Rules

1. **No private data in the repo, fixtures, logs or public endpoints.** Seeds and fixtures are synthetic (`@kcw/demo-data`); essay fixtures are public domain only. Use reserved domains (`example.com`, `.invalid`) if an email-shaped string is ever needed. The repo, issues, PRs and CI logs are public.
2. **No secrets anywhere in the repo or in output.** Read them at runtime with `@kcw/secrets` (`getSecret(name, key)`); environment variables hold secret *names* only (D9). Never print a secret value, a database URL, or an error message that might contain one (`scripts/lib/main.ts` prints messages only, no stack or objects). In workflows, secrets come from Secrets Manager through OIDC (`aws-actions/aws-secretsmanager-get-secrets`, masked) and outputs that hold credentials are masked explicitly.
3. **Secrets Manager vs SSM:** fixed secrets are in Secrets Manager (`kcw/...`, one JSON secret per reader, DESIGN §6). The only SSM SecureStrings are per-preview: `/kcw/preview/pr-<n>/database-url` and `/kcw/preview/pr-<n>/origin-verify`, created and deleted by `infra/preview`.
4. **Origin guard (D25):** the server Lambda answers 403 unless the request carries the `x-kcw-origin` header CloudFront adds. Do not remove `apps/web/src/server/origin-wrapper.ts` or the `kcw-origin-guard` wrapper in `open-next.config.ts`.
5. **The preview login exists only in preview builds** (`KCW_ENV=preview` at build time, dead-code-eliminated otherwise). Prod builds are checked (`build-web`, `check-prod-bundle`); Terraform refuses a build made for the other environment.
6. **Public pages import only `@kcw/demo-data` and `@kcw/xray`** from the workspace. ESLint enforces this for `apps/web/src/app/(public)/**` (`no-restricted-imports`); private server code goes in `apps/web/src/server/`.
7. **Scripts use Node: JavaScript runs with `node`, TypeScript with `tsx`**, never bash or PowerShell, so they work on Windows and Linux. Use `node:path`, no shell-specific syntax, no symlinks. Workflow `run:` steps are bash on Ubuntu and stay short; logic belongs in `scripts/`.
8. **Tests use fakes, not cloud services.** DB tests run on PGlite (in-memory Postgres); AWS clients, `fetch` and model providers are injected and faked.
9. **Dependencies:** a new dependency must be on [agents/merge-rules/approved-deps.json](../../agents/merge-rules/approved-deps.json) (exact names or scope globs such as `@aws-sdk/*`), otherwise the PR is critical and needs the owner. **Editing `approved-deps.json` itself is a critical change.** The owner-accepted Q15 policy also gates every `pnpm-lock.yaml` edit, including version/integrity changes for preapproved names. A new `package.json` must be added to `PACKAGE_FILES` in `scripts/test/approved-deps.test.ts`.
10. **Critical changes (owner approval):** SQL that drops, renames, truncates, changes a column type, sets NOT NULL or adds a NOT NULL column without a default; auth, secrets or IAM; `.github/**`; `.claude/**`; prod Terraform (`infra/prod`, `infra/modules/**`, `infra/bootstrap`) and any infrastructure change in the prod plan summary; any `docs/**/SPEC.md`; new dependencies off the allowlist or edits to it; new services; anything that raises cost. Governance instructions and the trusted import/configuration/tooling closure are also owner-critical, including root `tsconfig.json`, `tsconfig.base.json` and all lockfile edits; routine design status and factual `docs/HANDOFF.md` updates are not. This grants no role permission to edit owner-only paths.
11. Migrations are append-only: never edit an applied file (the runner checks checksums); add `NNNN_name.sql`.
12. Never run `terraform apply`/`destroy`, never change GitHub settings, never call AWS with real credentials outside CI. Only the owner (runbooks) and the workflows do that.

## Conventions

- Terraform: region `us-east-1` everywhere; the domain is optional (`domain_name = ""`, D22); `terraform fmt` before committing.
- Workflows: actions pinned to the versions in [docs/research/infra.md](../../docs/research/infra.md) or newer tags; top-level `permissions: {}` and per-job grants; `persist-credentials: false` on checkout; values from expressions go through `env:`, not inline into `run:`. Must pass `actionlint`.
- ESM everywhere (`"type": "module"`); extensionless relative imports (bundler resolution).
- `import type` for type-only imports (lint rule).
- One sample test per package at least; tests live in `<package>/test/*.test.ts`; script fixtures in `scripts/test/fixtures/` (synthetic only).
- Model ids: Anthropic `claude-haiku-5-5`; DeepSeek `deepseek-flash` (alias).
- `next dev` writes `apps/web/AGENTS.md` (Next.js agent rules); it is committed.

## OpenNext output contract (P1-08 → `infra/modules/web`)

`pnpm build-web` (`scripts/build-web.ts`) runs `open-next build` (`@opennextjs/aws` 4.1.12, config `apps/web/open-next.config.ts`) and fails if the output drifts from this layout (`scripts/lib/open-next-output.ts`). Set `KCW_ENV=preview` for a preview build; prod builds also run the preview-provider bundle check. Output in `apps/web/.open-next/` (gitignored):

| Path | What | Terraform (`infra/modules/web`) |
|---|---|---|
| `server-functions/default/` | Next server, handler `index.handler` (`index.mjs`), wrapper `kcw-origin-guard` (OpenNext's aws-lambda wrapper behind the `x-kcw-origin` check, D25), converter `aws-apigw-v2` (Function URL payload v2). Its traced `node_modules` has no symlinks: build-web replaces pnpm links with copies, hoists `.pnpm/node_modules/*` to the root and drops `.pnpm`, because a zip cannot keep the links | Lambda arm64 + public Function URL; CloudFront adds `x-kcw-origin`; default behaviour `*` |
| `image-optimization-function/` | `next/image` optimizer, handler `index.handler`, `node_modules/sharp` for linux arm64 | Lambda arm64 + Function URL (OAC) = behaviour `_next/image*` |
| `revalidation-function/` | ISR revalidation consumer, handler `index.handler` | Lambda triggered by the SQS FIFO revalidation queue |
| `assets/` | `BUILD_ID`, `_next/static/**` (hashed), plus files from `public/` | Uploaded to the assets bucket under `_assets/`; CloudFront S3 origin path `/_assets`; behaviours `_next/*`, `BUILD_ID` and one per top-level public file/dir |
| `cache/<BUILD_ID>/**` | Prerendered pages (ISR cache seed) | Uploaded under `_cache/`; server env `CACHE_BUCKET_KEY_PREFIX=_cache`, `OPEN_NEXT_BUILD_ID=<BUILD_ID>` |
| `kcw-build.json` | Written by build-web: `{kcw_env, build_id}` | The module input `kcw_env` must match, so prod never ships a preview build |
| `open-next.output.json` | OpenNext's own manifest of the above | Checked by build-web, not read by Terraform |
| `warmer-function/`, `.build/` | Not deployed | |

Server function env (set by the module): `KCW_ORIGIN_VERIFY_SECRET` (+ `KCW_ORIGIN_VERIFY_KEY`), `CACHE_BUCKET_NAME`, `CACHE_BUCKET_REGION`, `CACHE_BUCKET_KEY_PREFIX`, `OPEN_NEXT_BUILD_ID`, `REVALIDATION_QUEUE_URL`, `REVALIDATION_QUEUE_REGION`, plus secret *names* (D9). Image function env: `BUCKET_NAME`, `BUCKET_KEY_PREFIX=_assets`. Overrides in use: incremental cache `s3-lite`, queue `sqs-lite`, tag cache `dummy` (so `revalidateTag`/`revalidatePath` do nothing yet; adding them needs a DynamoDB tag cache in the module). Function splitting or edge functions would change the layout and need a module change; build-web rejects them.

Scheduled web jobs: the origin wrapper (`apps/web/src/server/origin-wrapper.ts`, the `wrapper` override in `apps/web/open-next.config.ts`) and the job registry (`apps/web/src/server/jobs/**`) are bundled into the server function, and `scripts/build-web.ts` imports the same config, so job code is also type-checked with the `scripts` package. Anything a scheduled job imports therefore must not import `next`, `next-auth`, the `@/` alias or `apps/web/src/auth/index.ts`, and must not need a request (no `next/headers`, no `server-only`). Check with `pnpm typecheck` and `pnpm build-web`; after a prod build, `pnpm check-prod-bundle`. The server function accepts non-HTTP job events (DESIGN section 1).

Windows: OpenNext 4.1.12 fails to install sharp on Windows (it splits the output path on `/`); build-web installs `sharp` for linux/arm64 itself. On Linux CI OpenNext does it.

## Isolated cloud workflow boundary

Cloud workflows remain disabled unless the owner sets KCW_AGENT_WORKFLOWS_ENABLED to true after completing the cutover runbook. Each dispatch pins trusted configuration, controller code and dependencies to its workflow commit (github.sha on main). Frozen installation disables lifecycle scripts and caches; owner review also gates the lockfile and executable import/configuration closure.

The prepare runner validates the dispatch and captures the exact baseline. For Developer and QA the prepare runner also validates the task contract input against the task, the issue and the baseline (every contract commit must be contained in the run base), writes it to `context/contract.json` (the context artifact holds `context.json`, `task.md` and, for a run with a contract, `contract.json`, all built from the contract and public GitHub data) and binds its SHA-256 in `context.json`; the publisher re-checks that hash and that the live task PR still closes the contract issue before any write, and the report carries the hash. The QA workflow's `contract` input is required for a task PR and empty for a Docs-keeper PR. The Developer, Scraper-builder and Docs-keeper work runners have read-only GitHub access, environment `agent-model` (main only) and AWS trust only for `kcw-gh-agent-model`, which reads only the DeepSeek key; they have no publisher environment, App identity or other AWS role. The QA work and review runners have read-only GitHub access and GitHub OIDC for Anthropic federation only: no `agent-model` environment and no AWS role. Work in payload/ below the trusted configuration root. Untrusted native instruction discovery is stripped at every depth. Only the required root entrypoints, `docs/agents/*.md` and `apps/web/AGENTS.md` are then restored from the pinned trusted checkout, so payload tests and web guidance read trusted configuration rather than PR instructions. Tracked copies retain skip-worktree; copies absent from the PR index are locally excluded from broad staging without changing its history. Missing handoff and security-cutover link targets on older task heads are filled from pinned trusted source; existing factual copies remain task data. Other native settings/discovery remain removed. A scoped instruction edit must use the trusted copy and explicitly clear its payload skip-worktree bit before staging.

Start, publisher and report jobs use separate fresh runners in agent-publish-{developer,qa,scraper,docs}. Before assuming their separate kcw-gh-agent-{role} AWS roles, a read-only API guard requires exactly a main branch deployment rule on the matching environment. A missing permission or incomplete owner cutover fails closed. No shared-role fallback exists. The Developer, Scraper-builder and Docs-keeper work model runtime is Claude Code Action on `deepseek-flash` through DeepSeek's Anthropic-compatible endpoint. The QA work and review model runtime is Claude Code Action on `claude-haiku-5-5` through Anthropic workload identity federation.

Artifacts are untrusted data. Consumers validate immutable numeric artifact IDs, run/workflow SHA and purpose before downloading. Candidate data has only a bounded Git bundle and bounded advisory usage JSON. Publishers derive authority from the prepare artifact and live repository APIs, inspect every introduced commit and path, reject merges, links, unexpected files and forbidden changes even if later reverted, and push without force. They never check out or execute candidate code.

QA runs test work separately from a fresh review model. The review model reads source and diff only; it executes no PR packages or tests and returns a decision bound to the exact PR SHA. New QA test commits are published but defer approval until new CI and a new review. The publisher checks live task PR identity and successful ci/required for that SHA immediately before submitting a review. Model review remains advisory to existing owner gates.

A fresh start job reports coding/qa_reviewing before work. Reports run from trusted source on fresh runners. Work and independent QA usage numbers are bounded advisory data; malformed or missing usage is discarded while trusted failure status is still reported. Raw execution logs are never uploaded. Legacy agent-context and agent-publish entrypoints are disabled; workflows invoke the explicit-tsconfig agent-pipeline controller.
