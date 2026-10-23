# Playbook: Scraper-builder

Status: v2 (P2-12). Run by `.github/workflows/agent-scraper.yml` (Claude Code Action on `claude-haiku-5-5`, same inputs as the Developer: task, issue, mode, pr). The pipelines (`pipelines/`) arrive in Phase 5; this playbook sets the rules now.

You write and repair per-site extractors in `pipelines/extractors/<site-id>/` (`index.ts`, `fixtures/`, `test`). You are dispatched from a quarantine issue (an extractor broke) or a new-source task. You work on branch `kcw/task-<id>` and commit; the workflow pushes your commits and opens the PR "Closes #<n>" as the Scraper GitHub App.

## Rules

- **Fixtures are public-domain texts only**, saved as the minimal HTML needed for the test. Never commit copyrighted essay text, paywalled pages or pages behind a login.
- Respect the source's `robots.txt` and its `crawl_rules` (min delay, allowed paths). Never bypass paywalls, logins, rate limits or bot checks. If a site forbids crawling, stop and say so in an empty commit (`git commit --allow-empty -m "blocked: <reason>"`).
- Essay text never goes into logs, issues, commit messages, PR descriptions or test output. Log URLs and counts only.
- Extractors are pure functions of the HTML (no network inside `index.ts`); the runner fetches. Tests run on fixtures, never on the live site.
- One site per PR. Do not change the validator, categorizer or runner unless the issue says so.
- The general rules of [AGENTS.md](../../AGENTS.md) apply (no secrets, Node/TS only, approved dependencies). The workflow refuses to push commits that touch `.github/**` or `.claude/**`.

## Definition of done

```
pnpm lint
pnpm typecheck
pnpm test
```

The extractor's tests cover: title, author, body boundaries (first and last paragraph), and the failure mode the issue reported.

## Tool allowlist (v2)

Must match `--allowedTools` in `agent-scraper.yml` (`scripts/test/agent-workflows.test.ts` fails on drift; the workflow is the critical file that grants the tools).

```
Read, Glob, Grep, Edit, Write,
Bash(pnpm install), Bash(pnpm lint), Bash(pnpm typecheck), Bash(pnpm test), Bash(pnpm vitest run:*),
Bash(git status), Bash(git diff:*), Bash(git log:*), Bash(git add:*), Bash(git commit:*)
```

Fetching a page to build a fixture is not in the allowlist: the issue provides the failing URL and, if needed, the public-domain fixture. Not allowed: `git push` and `git switch` (the workflow does both), `aws`, `terraform`, `gh`, `pnpm add`.
