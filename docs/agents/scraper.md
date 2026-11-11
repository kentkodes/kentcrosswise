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

## Clean essay text

The extractor returns only what the author wrote: the essay's title, its body and the author's own footnotes. The reader shows this text as it is, so strip everything else in the extractor:

- **Placeholders for images and media:** `[Illustration]`, `[Illustration: caption]`, `[image]`, `[Picture]`, `[Figure 3]` and alt-text residue.
- **Copyright, licence and source notices:** "Copyright …", "All rights reserved", Creative Commons and Project Gutenberg licence text, "Produced by …", "Transcribed from …", scan and digitizer credits, publisher and printer imprints, "Reprinted by permission".
- **Editorial apparatus that is not the author's:** transcriber's and editor's notes, "[Sidenote: …]", tables of contents, running heads, chapter and section indexes, page numbers and page markers (`[Pg 12]`, `{12}`, `[p. 12]`, `- 12 -`).
- **Site furniture:** navigation, menus, breadcrumbs, share and print links, "Read more", ads, cookie notices, comments and related-article lists.
- **Stray characters and markup:** plain-text emphasis marks (`_word_` becomes `word`, `=word=` becomes `word`), leftover HTML tags and entities, soft hyphens, zero-width characters, replacement characters (U+FFFD), mojibake such as `â€™`, and decorative rows of `*`, `-`, `=` or `~`. Keep a deliberate section break as one blank-line paragraph break.

Keep the author's own words, including epigraphs, quotations, dedications and the author's footnotes. Footnote markers stay, and the footnote text goes at the end. If you cannot tell whether a line belongs to the essay, keep it and say so in the PR.

Each of these patterns that occurs on the source gets a fixture line in the tests, with an assertion that the extracted text no longer contains it.

## Definition of done

```
pnpm --dir payload lint
pnpm --dir payload typecheck
pnpm --dir payload test
```

The extractor's tests cover: title, author, body boundaries (first and last paragraph), the cleaning rules above that apply to the source, and the failure mode the issue reported.

## Tool allowlist (v3: work runner)

Must match `--allowedTools` in `agent-scraper.yml` (`scripts/test/agent-workflows.test.ts` fails on drift; the workflow is the critical file that grants the tools).

```
Read, Glob, Grep, Edit, Write, Bash(pnpm --dir payload install), Bash(pnpm --dir payload lint), Bash(pnpm --dir payload typecheck), Bash(pnpm --dir payload test), Bash(pnpm --dir payload vitest run:*), Bash(git -C payload status), Bash(git -C payload diff:*), Bash(git -C payload log:*), Bash(git -C payload add:*), Bash(git -C payload commit:*), Bash(git -C payload update-index --no-skip-worktree:*)
```

Fetching a page to build a fixture is not in the allowlist: the issue provides the failing URL and, if needed, the public-domain fixture. Not allowed: `git push` and `git switch` (the workflow does both), `aws`, `terraform`, `gh`, `pnpm add`.

Cloud execution uses trusted main configuration at the root and untrusted source under payload/. Run all source checks and commits in payload/ with the scoped tools above. The publisher on a fresh runner owns all pushes and App operations.
