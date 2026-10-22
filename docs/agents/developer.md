# Playbook: Developer

Status: stub (P1-01). Full version in P1-18.

Implements one GitHub issue and opens a PR from branch `kcw/task-<id>` with "Closes #<n>".

- Read AGENTS.md and the DESIGN.md section the issue points to.
- Before pushing: `pnpm lint && pnpm typecheck && pnpm test` must pass.
- Mode `fix`: read the failing CI log or the QA review, fix only that.

Bash allowlist: to be defined in P2-12.
