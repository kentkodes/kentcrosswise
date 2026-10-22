# AGENTS.md

Canonical guide for every agent (and human) working in this repo. Docs-keeper keeps it current.
Product specs: [docs/hub/SPEC.md](docs/hub/SPEC.md), [docs/essays/SPEC.md](docs/essays/SPEC.md). Design and task list: [docs/DESIGN.md](docs/DESIGN.md).
Per-agent playbooks: [docs/agents/](docs/agents/).

## Toolchain

- Node 24 (`.nvmrc`; `engines` requires >= 22.12 because Vitest 5, Kysely 0.29 and the Jev SDK need it).
- pnpm 12 (`packageManager` in `package.json`). Build scripts of dependencies are blocked unless listed under `allowBuilds` in `pnpm-workspace.yaml`.
- TypeScript 6.0 (strict). typescript-eslint does not support TypeScript 7 yet; do not upgrade past 6.0.x.
- Workspace packages are consumed as TypeScript source (`exports` points at `src/*.ts`); there is no build step for them. Next.js transpiles them (`transpilePackages`), Vitest and `tsx` run them directly.

## Commands (from the repo root)

| Command | What it does |
|---|---|
| `pnpm install` | Install everything |
| `pnpm lint` | ESLint over the whole repo (one flat config: `eslint.config.js`) |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm test` | Vitest, every workspace package is a project (`vitest.config.ts`) |
| `pnpm --filter web build` | Production build of the Next.js app |
| `pnpm --filter web dev` | Local dev server |
| `pnpm migrate --pglite .pglite/dev` | Apply migrations to a local PGlite directory (`pnpm migrate --help`: also `--secret <name>`, `DATABASE_URL`, `--dry-run`) |
| `pnpm seed --pglite .pglite/dev` | Insert the synthetic seed |
| `pnpm build-web` | OpenNext v4 build of `apps/web` into `apps/web/.open-next` + contract check (see below); `KCW_ENV=preview` for previews |
| `pnpm --filter web e2e` | Playwright (`apps/web/e2e/*.e2e.ts`). No `BASE_URL`: starts `next dev` as a preview build with a fixed local login token; `PW_SERVER=start` uses `next start` (build with `KCW_ENV=preview` first); `BASE_URL=... KCW_E2E_LOGIN=...` targets a deployed preview. First time: `pnpm --filter web exec playwright install chromium` |
| `pnpm check-preview-clean --pr <n>` | After a preview teardown: fails if any `kcw-pr-<n>` resource, `/kcw/preview/pr-<n>/` parameter, state/lock object or Neon branch is left (needs AWS credentials; `--skip-neon` without a Neon key) |
| `pnpm check-prod-bundle` | Fails if the built web app (`.next`, `.open-next`) contains the preview login provider; run after every prod build |

Run one package's tests: `pnpm vitest run --project @kcw/db` (project = package name; the app is `web`).
PGlite DB tests take ~2 s per fresh database; reuse one per `describe` where possible.

## Layout

```
apps/web/            Next.js 16 App Router app. src/app/(public) = visitor pages, src/app/(owner) = owner pages
                     The (owner) layout redirects to /api/auth/signin unless the session is the allowlisted owner.
apps/web/src/auth/   Auth.js v5 (next-auth beta): Google (prod, scopes openid email profile) + allowlist from
                     kcw/prod/web owner_email; preview builds (KCW_ENV=preview at build time) get a credentials
                     provider keyed by kcw/ci e2e_login instead (preview-login.ts, never in a prod bundle).
packages/core/       shared types; src/models = model providers (Anthropic, Jev, Fake, withFallback)
packages/db/         migrations/*.sql, runner, synthetic seed (seeds/)
packages/secrets/    getSecret/putSecret (Secrets Manager; names starting with "/" are SSM SecureString)
packages/demo-data/  deterministic simulated data for public pages
packages/essays/     essays feature (stub)
packages/xray/       X-ray registry (stub)
agents/merge-rules/  approved-deps.json (dependency allowlist); detector arrives in P2-04
scripts/             repo scripts (Node/TS via tsx): migrate, seed, build-web, check-prod-bundle, check-preview-clean
infra/bootstrap/     owner-applied once: state bucket, GitHub OIDC roles, empty secrets, certificate (local state, then S3)
infra/prod/          prod composition (web only so far); infra/preview/ = one per-PR web stack (D21)
infra/modules/       web (OpenNext v4, see contract below), secrets (lookups + read policy)
.github/actions/     neon-preview (Neon branch preview/pr-<n> with the key from Secrets Manager)
docs/                specs, design, research, agent playbooks, runbooks
```

## Rules

1. **No private data in the repo, fixtures, logs or public endpoints.** Seeds and fixtures are synthetic (`@kcw/demo-data`); essay fixtures are public domain only. Use reserved domains (`example.com`, `.invalid`) if an email-shaped string is ever needed.
2. **No secrets anywhere in the repo or in output.** Read them at runtime with `@kcw/secrets`; never print a secret value, a database URL or an error message that might contain one.
3. **Public pages import only `@kcw/demo-data` and `@kcw/xray`** from the workspace. ESLint enforces this for `apps/web/src/app/(public)/**` (`no-restricted-imports`); private server code goes in `apps/web/src/server/`.
4. **Scripts are Node/TS run with `tsx`**, never bash or PowerShell, so they work on Windows and Linux. Use `node:path` for paths.
5. **Tests use fakes, not cloud services.** DB tests run on PGlite (in-memory Postgres); AWS clients and model providers are injected and faked.
6. **Dependencies:** a new dependency must be on [agents/merge-rules/approved-deps.json](agents/merge-rules/approved-deps.json) (exact names or scope globs such as `@aws-sdk/*`), otherwise the PR is critical and needs the owner. **Editing `approved-deps.json` itself is a critical change** (owner approval).
7. Critical changes (owner approval): SQL that drops or renames, auth/secrets/IAM, `.github/**`, `.claude/**`, prod Terraform, any `docs/**/SPEC.md`, new dependencies off the allowlist, anything that raises cost.
8. Migrations are append-only: never edit an applied file (the runner checks checksums); add `NNNN_name.sql`.

## Conventions

- Terraform: `terraform fmt -check -recursive infra`; `terraform -chdir=infra/<stack> init -backend=false && terraform -chdir=infra/<stack> validate` (validate reads `apps/web/.open-next`, so run `pnpm build-web` first). Only the owner applies (`docs/runbooks/bootstrap.md`). Region `us-east-1` everywhere; the domain is optional (`domain_name = ""`, D22).
- Workflows and composite actions must pass `actionlint` (download the release binary; it is not a dependency).

- ESM everywhere (`"type": "module"`); extensionless relative imports (bundler resolution).
- `import type` for type-only imports (lint rule).
- One sample test per package at least; tests live in `<package>/test/*.test.ts`.
- Model ids: Anthropic `claude-haiku-5-5`; Jev pinned to `jev-1.13.0`.

## OpenNext output contract (P1-08 → `infra/modules/web`)

`pnpm build-web` (`scripts/build-web.ts`) runs `open-next build` (`@opennextjs/aws` 4.1.12, config `apps/web/open-next.config.ts`) and fails if the output drifts from this layout (`scripts/lib/open-next-output.ts`). Set `KCW_ENV=preview` for a preview build; prod builds also run the preview-provider bundle check. Output in `apps/web/.open-next/` (gitignored):

| Path | What | Terraform (`infra/modules/web`) |
|---|---|---|
| `server-functions/default/` | Next server, handler `index.handler` (`index.mjs`), wrapper `aws-lambda`, converter `aws-apigw-v2` (Function URL payload v2). Contains its own traced `node_modules` (pnpm symlinks) | Lambda arm64 + Function URL (OAC) = CloudFront default behaviour `*` |
| `image-optimization-function/` | `next/image` optimizer, handler `index.handler`, `node_modules/sharp` for linux arm64 | Lambda arm64 + Function URL (OAC) = behaviour `_next/image*` |
| `revalidation-function/` | ISR revalidation consumer, handler `index.handler` | Lambda triggered by the SQS FIFO revalidation queue |
| `assets/` | `BUILD_ID`, `_next/static/**` (hashed), plus files from `public/` | Uploaded to the assets bucket under `_assets/`; CloudFront S3 origin path `/_assets`; behaviours `_next/*`, `BUILD_ID` and one per top-level public file/dir |
| `cache/<BUILD_ID>/**` | Prerendered pages (ISR cache seed) | Uploaded under `_cache/`; server env `CACHE_BUCKET_KEY_PREFIX=_cache`, `OPEN_NEXT_BUILD_ID=<BUILD_ID>` |
| `kcw-build.json` | Written by build-web: `{kcw_env, build_id}` | The module input `kcw_env` must match, so prod never ships a preview build |
| `open-next.output.json` | OpenNext's own manifest of the above | Checked by build-web, not read by Terraform |
| `warmer-function/`, `.build/` | Not deployed | |

Server function env (set by the module): `CACHE_BUCKET_NAME`, `CACHE_BUCKET_REGION`, `CACHE_BUCKET_KEY_PREFIX`, `OPEN_NEXT_BUILD_ID`, `REVALIDATION_QUEUE_URL`, `REVALIDATION_QUEUE_REGION`, plus secret *names* (D9). Image function env: `BUCKET_NAME`, `BUCKET_KEY_PREFIX=_assets`. Overrides in use: incremental cache `s3-lite`, queue `sqs-lite`, tag cache `dummy` (so `revalidateTag`/`revalidatePath` do nothing yet; adding them needs a DynamoDB tag cache in the module). Function splitting or edge functions would change the layout and need a module change; build-web rejects them.

Windows: OpenNext 4.1.12 fails to install sharp on Windows (it splits the output path on `/`); build-web installs `sharp` for linux/arm64 itself. On Linux CI OpenNext does it.
