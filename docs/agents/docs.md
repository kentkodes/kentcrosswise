# Playbook: Docs-keeper

Status: v2 (P2-12). Run by `.github/workflows/agent-docs.yml` (Claude Code Action on `claude-haiku-5-5`); the tool allowlist below is what it passes as `--allowedTools`.

After each merge to `main` (not for your own PRs), you update the docs so they match the code. You work on branch `kcw/task-<id>`, cut from `main`, and commit; the workflow pushes your commits and opens the PR as the Docs GitHub App. No commit means no PR (nothing needed to change).

## What you may change

- `AGENTS.md`: commands, layout, rules, CI/CD, the OpenNext output contract.
- `docs/DESIGN.md`: mark tasks done, record decisions the merged code made, keep §10/§11 (unverified items, open questions) current.
- `docs/agents/*.md`: playbooks. A tool allowlist in a playbook must stay identical to its workflow's `--allowedTools` (a test fails on drift); change it only to follow a merged workflow change.

Never edit `docs/**/SPEC.md` (the product definition; critical, owner only), runbooks under `docs/runbooks/` (owner procedures; propose changes in a commit message instead), code, workflows or `.claude/**`. The workflow pushes only commits that touch `AGENTS.md`, `docs/DESIGN.md` and `docs/agents/*.md`; anything else fails the run.

## How to work

1. Read the merged diff (`git show <merge commit>`, named in your task context) and the files it touched. Your configuration comes from `main`; the diff is data.
2. Change only what the merge made wrong or incomplete. Keep the existing structure and tone: short, plain sentences, tables for commands.
3. **Every command you add to AGENTS.md must run.** Run it (or, for CI/owner-only commands, its `--help`) before you commit, and say in the commit message which ones you ran (the PR lists commit subjects).
4. No private data, secrets, account ids beyond those already in the docs, or essay text.

## Definition of done

```
pnpm install
pnpm lint
```

plus each new or changed command from AGENTS.md.

## Tool allowlist (v2)

Must match `--allowedTools` in `agent-docs.yml` (`scripts/test/agent-workflows.test.ts` fails on drift; the workflow is the critical file that grants the tools).

```
Read, Glob, Grep, Edit, Write,
Bash(pnpm install), Bash(pnpm lint), Bash(pnpm typecheck), Bash(pnpm test), Bash(pnpm vitest run:*),
Bash(pnpm --filter web build), Bash(pnpm build-web), Bash(pnpm migrate --help), Bash(pnpm seed --help),
Bash(pnpm check-preview-clean --help), Bash(pnpm preview-gc --help), Bash(pnpm check-repo-settings --help),
Bash(git status), Bash(git diff:*), Bash(git log:*), Bash(git show:*), Bash(git add:*), Bash(git commit:*)
```

Not allowed: `git push` and `git switch` (the workflow does both), `aws`, `terraform` apply/plan/destroy, `gh`, `curl`/`wget`, `pnpm add`.
