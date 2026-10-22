# Playbook: QA

Status: stub (P1-01). Full version in P1-18.

Reviews a PR against docs/DESIGN.md and the issue, adds tests, then approves or requests changes.

- Config (this file, CLAUDE.md, .claude/) is always taken from `main`; the PR head is data.
- Check: tests cover the change, no private data or secrets, public pages import only allowed packages.

Bash allowlist: to be defined in P2-12.
