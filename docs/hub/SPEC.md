# Kentcrosswise Hub: Spec

Status: approved by the owner, 2026-10-22. Companion: [../essays/SPEC.md](../essays/SPEC.md).

## Purpose

A private hub for one person (the owner): capture thoughts from phone or computer, keep a light CRM and a diary with mood tracking, watch social metrics, and open personal projects. It is also "portfolio-but-not": logged-out visitors see a demo with simulated data, an X-ray mode that labels the technology under each part, and a live pixel-art office of the AI agents that build and maintain the site.

## Users

- **Owner**: the only account. Google sign-in, restricted to an allowlisted email.
- **Visitor**: logged out. Sees the demo, X-ray mode and the agent office. Never sees real data.

## Features (MVP)

1. **Capture box.** A phone-friendly text box behind login. Every entry is stored raw, then routed.
2. **Router.** Jev (Haiku 5.5 as fallback) classifies each entry as `crm_note`, `diary`, `todo`, `idea` or `agent_request`. The owner sees the result and can reassign it; corrections are stored. Low confidence puts the entry in the inbox for the owner to choose.
3. **CRM.** Contacts: name, how known, birthday, notes, tags. CRM notes link to contacts by name match (owner confirms when ambiguous). When a note implies a plan ("lunch with Sam next Tuesday"), the app suggests a Google Calendar event; the owner adds it with one tap. **Not included:** last-contact tracking and "you haven't talked to X" reminders.
4. **Diary and mood.** A diary page for long entries; diary items from the capture box land here too. Each entry is scored 0–1 on energy, stress, happiness, satisfaction, sadness, anger, anxiety and gratitude, plus an overall sentiment from -1 to 1 (Haiku 5.5). The mood board charts these over time, with a toggle per metric and the overall line on top.
5. **Social dashboard.** YouTube, Instagram and TikTok (all business/creator accounts). A daily snapshot of followers and views per source; totals plus a filter by source.
6. **Projects.** Tabs for personal projects. First tab: Essays (`/essays`, see the essays spec).
7. **Inbox and notifications.** One inbox for everything waiting on the owner: agent requests to approve, critical PRs, low-confidence routing, calendar suggestions. Web push notifications (iPhone, once the site is added to the Home Screen).
8. **Boss console.** The owner gives tasks to the orchestrator and follows their status. Includes a usage panel (model spend, GitHub Actions minutes) and a "pause all agents" switch. No spending caps for now.
9. **Public demo.** Logged-out versions of the dashboard, mood board and CRM filled with simulated data and fake people.
10. **X-ray mode.** A toggle that shows the site in cross-section: each component is labeled with the technology behind it, and hovering shows what it does and why it was chosen. Available to visitors.
11. **Agent office.** A top-down pixel-art office (Stardew Valley style). Each agent is a character at a desk. Live events drive animation: task assigned, coding, PR opened (the developer carries a stack of papers to the QA desk), CI running, tests failed, approved, merged (papers go into a filing cabinet), waiting on the owner. Public; shows sanitized task titles only.

## Agent system

The owner is the orchestrator's boss and owns the overall idea; agents do the rest of the software loop.

- **Orchestrator.** LangGraph (JS) on AWS Lambda, checkpoints in Neon. Takes tasks from the boss console, approved agent requests, GitHub events (via a signature-checked webhook relay) and schedules. Splits tasks, briefs the other agents, tracks them to merge. Writes a public, sanitized title for each task.
- **Developer.** Claude Code GitHub Action on Haiku 5.5. Implements an issue and opens a PR.
- **QA.** Reviews PRs against the design docs and the QA playbook; writes and runs tests.
- **Scraper-builder.** Writes and repairs per-site essay extractors.
- **Docs-keeper.** After each merge, updates `AGENTS.md`, the design docs and the agent playbooks in `docs/agents/` so they match the code.
- **Router / Categorizer.** Jev, with Haiku 5.5 as fallback. Routes capture entries and categorizes essays.

Each agent that acts on GitHub is its own GitHub App owned by the owner's account.

**PR loop.** Developer opens PR → CI: lint, unit tests, throwaway environment (Terraform + Neon branch), Playwright end-to-end tests, teardown → QA review → merge-rules check. A PR merges automatically when it matches the design docs, passes all tests and passes in the throwaway environment.

**Critical changes need the owner's approval** (the PR goes to the inbox):
- database migrations that drop or rename data
- authentication, secrets or permissions
- Terraform changes to production (not throwaway environments)
- anything that changes what a design doc says the product does
- new paid services or new dependencies
- anything that raises monthly cost

## Stack

TypeScript on Node.js, one public monorepo `kentcrosswise`. Next.js on AWS Lambda via OpenNext behind CloudFront; S3; SQS; EventBridge Scheduler; Secrets Manager (every secret; none in the repo); Route 53 (`kentcrosswise.com`); Neon Postgres (branch per PR); Terraform (state in S3). Models: Haiku 5.5 for agents and mood scoring, Jev for routing and categorizing.

## Rules

- Private data (entries, contacts, diary, mood, real metrics, essay text) never reaches a public endpoint or the git repo.
- The public agent feed carries only sanitized titles and event types.
- Usage is always visible; limits will be added by the owner later.

## Later (not MVP)

- Capture from iPhone via an Apple Shortcut; Google Voice → Gmail bridge for texting.
- Spending caps.
- Native mobile app.
