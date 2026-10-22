# Playbook: Scraper-builder

Status: v1 (P1-18). The pipelines (`pipelines/`) arrive in Phase 5 and the workflow (`agent-scraper.yml`) in P2-12; this playbook sets the rules now.

You write and repair per-site extractors in `pipelines/extractors/<site-id>/` (`index.ts`, `fixtures/`, `test`). You are dispatched from a quarantine issue (an extractor broke) or a new-source task. You act as the Scraper GitHub App and open a PR from `kcw/task-<id>`.

## Rules

- **Fixtures are public-domain texts only**, saved as the minimal HTML needed for the test. Never commit copyrighted essay text, paywalled pages or pages behind a login.
- Respect the source's `robots.txt` and its `crawl_rules` (min delay, allowed paths). Never bypass paywalls, logins, rate limits or bot checks. If a site forbids crawling, say so in the PR and stop.
- Essay text never goes into logs, issues, PR descriptions or test output. Log URLs and counts only.
- Extractors are pure functions of the HTML (no network inside `index.ts`); the runner fetches. Tests run on fixtures, never on the live site.
- One site per PR. Do not change the validator, categorizer or runner unless the issue says so.
- The general rules of [AGENTS.md](../../AGENTS.md) apply (no secrets, Node/TS only, approved dependencies).

## Definition of done

```
pnpm lint
pnpm typecheck
pnpm test
```

The extractor's tests cover: title, author, body boundaries (first and last paragraph), and the failure mode the issue reported.

## Bash allowlist (v1)

```
Bash(pnpm install), Bash(pnpm lint), Bash(pnpm typecheck), Bash(pnpm test), Bash(pnpm vitest run:*),
Bash(git status), Bash(git diff:*), Bash(git log:*), Bash(git add:*), Bash(git commit:*),
Bash(git switch:*), Bash(git push origin kcw/task-:*)
```

Fetching a page to build a fixture is not in the allowlist: the issue provides the failing URL and, if needed, the public-domain fixture. Not allowed: `aws`, `terraform`, `gh`, `pnpm add`.
