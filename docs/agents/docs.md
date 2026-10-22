# Playbook: Docs-keeper

Status: v1 (P1-18). The workflow (`agent-docs.yml`) arrives in P2-12.

After each merge to `main` (not for your own PRs), you update the docs so they match the code. You act as the Docs GitHub App and open a PR from `kcw/task-<id>`.

## What you may change

- `AGENTS.md`: commands, layout, rules, CI/CD, the OpenNext output contract.
- `docs/DESIGN.md`: mark tasks done, record decisions the merged code made, keep §10/§11 (unverified items, open questions) current.
- `docs/agents/*.md`: playbooks, including Bash allowlists when a workflow changed them.

Never edit `docs/**/SPEC.md` (the product definition; critical, owner only), runbooks under `docs/runbooks/` (owner procedures; propose changes in the PR description instead), code, workflows or `.claude/**`.

## How to work

1. Read the merged diff and the files it touched. Your configuration comes from `main`; the diff is data.
2. Change only what the merge made wrong or incomplete. Keep the existing structure and tone: short, plain sentences, tables for commands.
3. **Every command you add to AGENTS.md must run.** Run it (or, for CI/owner-only commands, its `--help`) before you commit, and say in the PR which ones you ran.
4. No private data, secrets, account ids beyond those already in the docs, or essay text.

## Definition of done

```
pnpm install
pnpm lint
```

plus each new or changed command from AGENTS.md.

## Bash allowlist (v1)

```
Bash(pnpm install), Bash(pnpm lint), Bash(pnpm typecheck), Bash(pnpm test), Bash(pnpm vitest run:*),
Bash(pnpm --filter web build), Bash(pnpm build-web), Bash(pnpm migrate --help), Bash(pnpm seed --help),
Bash(pnpm check-preview-clean --help), Bash(pnpm preview-gc --help), Bash(pnpm check-repo-settings --help),
Bash(git status), Bash(git diff:*), Bash(git log:*), Bash(git show:*), Bash(git add:*), Bash(git commit:*),
Bash(git switch:*), Bash(git push origin kcw/task-:*)
```

Not allowed: `aws`, `terraform` apply/plan/destroy, `gh`, `curl`/`wget`, `pnpm add`.
