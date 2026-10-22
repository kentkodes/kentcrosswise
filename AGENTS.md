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
| `pnpm migrate -- --pglite .pglite/dev` | Apply migrations to a local PGlite directory (see `scripts/migrate.ts --help`) |
| `pnpm seed -- --pglite .pglite/dev` | Insert the synthetic seed |

Run one package's tests: `pnpm vitest run --project @kcw/db`.

## Layout

```
apps/web/            Next.js 16 App Router app. src/app/(public) = visitor pages, src/app/(owner) = owner pages.
packages/core/       shared types; src/models = model providers (Anthropic, Jev, Fake, withFallback)
packages/db/         migrations/*.sql, runner, synthetic seed (seeds/)
packages/secrets/    getSecret/putSecret (Secrets Manager; names starting with "/" are SSM SecureString)
packages/demo-data/  deterministic simulated data for public pages
packages/essays/     essays feature (stub)
packages/xray/       X-ray registry (stub)
agents/merge-rules/  approved-deps.json (dependency allowlist); detector arrives in P2-04
scripts/             repo scripts (Node/TS via tsx): migrate.ts, seed.ts
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

- ESM everywhere (`"type": "module"`); extensionless relative imports (bundler resolution).
- `import type` for type-only imports (lint rule).
- One sample test per package at least; tests live in `<package>/test/*.test.ts`.
- Model ids: Anthropic `claude-haiku-5-5`; Jev pinned to `jev-1.13.0`.
