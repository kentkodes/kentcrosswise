# Playbook: Scraper-builder

Read [HANDOFF.md](../HANDOFF.md) for current rollout status, enablement and holds.

You write and repair per-site extractors in `pipelines/extractors/<site-id>/` (`index.ts`, `fixtures/`, `test`). You are dispatched from a quarantine issue (an extractor broke) or a new-source task. In cloud runs you act as the Scraper GitHub App and open a PR from `kcw/task-<id>`.

## Rules

- **Fixtures are public-domain texts only**, saved as the minimal HTML needed for the test. Never commit copyrighted essay text, paywalled pages or pages behind a login.
- Respect the source's `robots.txt` and its `crawl_rules` (min delay, allowed paths). Never bypass paywalls, logins, rate limits or bot checks. If a site forbids crawling, say so in the PR and stop.
- Essay text never goes into logs, issues, PR descriptions or test output. Log URLs and counts only.
- Extractors are pure functions of the HTML (no network inside `index.ts`); the runner fetches. Tests run on fixtures, never on the live site.
- One site per PR. Do not change the validator, categorizer or runner unless the issue says so.
- The general rules of [INSTRUCTIONS.md](INSTRUCTIONS.md) apply (no secrets, Node/TS only, approved dependencies).

## Definition of done

```
pnpm --dir payload lint
pnpm --dir payload typecheck
pnpm --dir payload test
```

The extractor's tests cover: title, author, body boundaries (first and last paragraph), and the failure mode the issue reported.

## Tool allowlist (v3: work runner)

Must match `--allowedTools` in `agent-scraper.yml` (`scripts/test/agent-workflows.test.ts` fails on drift; the workflow is the critical file that grants the tools).

```
Read, Glob, Grep, Edit, Write, Bash(pnpm --dir payload install), Bash(pnpm --dir payload lint), Bash(pnpm --dir payload typecheck), Bash(pnpm --dir payload test), Bash(pnpm --dir payload vitest run:*), Bash(git -C payload status), Bash(git -C payload diff:*), Bash(git -C payload log:*), Bash(git -C payload add:*), Bash(git -C payload commit:*), Bash(git -C payload update-index --no-skip-worktree:*)
```

Fetching a page to build a fixture is not in the allowlist: the issue provides the failing URL and, if needed, the public-domain fixture. Not allowed: `git push` and `git switch` (the workflow does both), `aws`, `terraform`, `gh`, `pnpm add`.

Cloud execution uses trusted main configuration at the root and untrusted source under payload/. Run all source checks and commits in payload/ with the scoped tools above. The publisher on a fresh runner owns all pushes and App operations.
