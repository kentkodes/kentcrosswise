# Kentcrosswise Hub: Spec

Status: approved by the owner, 2026-10-22; project priority and lifecycle defaults amended 2026-11-14; product framing, public surface and social scope amended 2026-11-17 (owner direction, recorded in [../HANDOFF.md](../HANDOFF.md)). Companion: [../essays/SPEC.md](../essays/SPEC.md).

## Purpose

The owner's personal helper: capture thoughts from phone or computer, route them, keep a light CRM and a diary with mood tracking, and open personal projects. The helper is the product. The public site exists to show it working with real inputs, real routing and real evidence: logged-out visitors see a public log of the owner's real entries (sanitized), how each was routed and what happened, an X-ray mode that shows the technology and, per entry, the evidence behind it, and a live pixel-art office of the AI agents that build and maintain the site. The public log and the evidence X-ray are planned (features 9 and 10); today the public surface is a demo with simulated data, the component X-ray and the office.

The autonomous development system is how the site is built and maintained; inspectable engineering evidence is the helper's public proof. Reliability work precedes further hub, essay or office expansion. The accepted worker and task lifecycle is defined in [../DESIGN.md](../DESIGN.md), section 4.0, and the published-records target in section 4.6; implementation status and delivery order are in [../HANDOFF.md](../HANDOFF.md) and [../OPEN-POINTS.md](../OPEN-POINTS.md).

## Users

- **Owner**: the only account. Google sign-in, restricted to an allowlisted email.
- **Visitor**: logged out. Sees the public log, X-ray mode and the agent office. Never sees live private records: only the sanitized public projection, and never a withheld record's contents.

## Features (MVP)

1. **Capture box.** A phone-friendly text box behind login. Every entry is stored raw, then routed.
2. **Router.** A bounded model call classifies each entry as `crm_note`, `diary`, `todo`, `idea` or `agent_request`. The owner sees the result and can reassign it; corrections are stored. Low confidence (below 0.6, provisional until a small labelled sample sets it) puts the entry in the inbox for the owner to choose. When an entry gets its route (model at or above the threshold, or the owner's choice) one derived row is created in the same transaction (`crm_note` to CRM notes, `diary` to diary entries, `todo` to todos, `idea` to ideas; `agent_request` stays a category). A Needs-you entry gets none until the owner chooses. Reclassification moves the current body of the old row (owner edits kept) to a new row of the new kind and deletes the old one, except that moving to `agent_request` discards it because agent requests have no destination yet; saving the same kind again changes nothing; `entries.raw_text` never changes; retries create no duplicates. `/hub` lists every pending, failed, capped or Needs-you entry in an Unresolved region, oldest first, independent of the latest-ten Recent list. This is capture classification, distinct from retrying or replanning an agent task (DESIGN section 4.0).
3. **CRM.** Contacts: name, how known, birthday, notes, tags. CRM notes link to contacts by name match (owner confirms when ambiguous). When a note implies a plan ("lunch with Sam next Tuesday"), the app suggests a Google Calendar event; the owner adds it with one tap or dismisses it. The browser's time zone is stored with each capture; without one, no suggestion is made. **Not included:** last-contact tracking and "you haven't talked to X" reminders.
4. **Diary and mood.** A diary page for long entries; diary items from the capture box land here too. Each entry is scored 0-1 on energy, stress, happiness, satisfaction, sadness, anger, anxiety and gratitude, plus an overall sentiment from -1 to 1. The mood board charts these over time, with a toggle per metric and the overall line on top. Model selection belongs in DESIGN rather than this product requirement. Entries written on the diary page are scored on save and on edit; where scoring is not configured (preview, local) an entry is saved and shown as not scored. A diary item created by a capture is scored after its route commits; a timeout or failure leaves it not scored, and the owner can score it again. Scoring never changes the capture's notice.
5. **Social dashboard.** Removed (owner direction 2026-11-17): no social page, daily job or demo tab, and no social or playground features on the public surface.
6. **Projects.** Tabs for personal projects. First tab: Essays (`/essays`, see the essays spec).
7. **Inbox and notifications.** One inbox for everything waiting on the owner: agent requests to approve, critical PRs, low-confidence routing, calendar suggestions. The owner can enable web push on a device from `/notifications` and receives one generic notification when new inbox items exist; the notification never contains item text. On iPhone the site must be added to the Home Screen first.
8. **Boss console.** The owner gives tasks to the orchestrator and follows their status. Includes a usage panel (model spend, GitHub Actions minutes), a "pause all agents" switch and the existing soft $50 monthly model-spend control. Delayed or missing usage, unpriced rows and incomplete caller accounting prevent a hard-dollar guarantee today; closing those gaps precedes expansion. The unknown-price policy remains an implementation decision, and this amendment does not change the budget.
9. **Public log (owner direction 2026-11-17; replaced the synthetic demo at `/demo`).** The main public product: the owner's entries from the day it ships (no backfill), each with its routing, the trace of its steps, the result, its checks, corrections and recovery. A record is published once the owner has reviewed its route (one tap: Correct, or a reassignment), with no further approval step, and publication fails closed (DESIGN section 4.6). The review is a verdict on correctness, not a privacy approval: it cannot publish a record that sanitization withholds. The log shows how many entries await review.
   - Every route kind shows its sanitized text. People are replaced by bracketed filler names (`[Person 1]`), specific places, workplaces and addresses by `[place]`, and emails, phone numbers, links and handles by bracketed placeholders. A bounded model call finds names the contact list does not know; the deterministic sanitizer applies and re-checks, and a failed call withholds the record. A record about another person's health, money, legal or relationship matters is withheld. The review screen shows the exact public text, and the owner can tap a word to replace it too (only adding replacements). Credentials, access links, raw tool payloads and raw model reasoning are never published. A record that sanitization cannot establish as safe stays private; the log is labelled "Tasks published automatically after sanitization; some records withheld for privacy/security" and shows the withheld count, never withheld contents. Timestamps are rounded to the hour.
   - Corrections and recovery are shown in detail: the model's label and the owner's correction; for a failed step, its error code, each attempt, the recovery path and anything still unresolved.
   - Each record carries checks: pass/fail facts read back from stored state after each step, which can fail, never an accuracy percentage. It also carries the owner's verdict per step: the route confirmed or corrected, a contact link chosen, a calendar suggestion added or dismissed, or "not reviewed" for a step the owner has not acted on. Accuracy is a versioned aggregate per step (route accuracy, contact-link precision, calendar acceptance) over those verdicts, shown with its sample size. The log is never presented as a complete reliability record.
   - It includes a Google Calendar of a separate dummy Google account, kept fresh from the published CRM notes' calendar suggestions (sanitized titles); never the owner's calendar.
   - The public-domain Essays tab stays; the home page leads with the log. The public reads a separate sanitized view, never the live private records.

   Built today: `/demo` has the Log tab (the counts, the label and each published record with its evidence: step lines, corrections, recovery and read-back checks; route accuracy, contact-link precision and calendar acceptance over the published records) and the Essays tab, and the home page leads with the log. On `/hub`, "Correct" on a contact note also confirms its automatic contact link, and "Change contact" marks the link wrong. Planned: the dummy calendar.
10. **X-ray mode.** A toggle that shows the site in cross-section. Built: each component is labeled with the technology behind it, and hovering shows what it does and why it was chosen; it describes only what is built. Owner direction 2026-11-17: for a published entry a visitor can open its evidence (built on `/demo`): the sanitized input and intended outcome; the actual steps and resulting changes; the checks that passed or failed; the recovery, if any, and anything still unresolved. "Completed, checks passed, no recovery needed" is a valid record; no failure story is forced onto a task. It shows actions, evidence and concise explanations, never raw model reasoning. Available to visitors.
11. **Agent office.** A top-down pixel-art office (Stardew Valley style). Each agent is a character at a desk. Live events drive animation: task assigned, coding, PR opened (the developer carries a stack of papers to the QA desk), CI running, tests failed, approved, merged (papers go into a filing cabinet), waiting on the owner. Public; shows sanitized task titles only.

## Agent system

The owner is the orchestrator's boss and owns the overall idea; agents do the rest of the software loop.

Disposable executions use reusable skills and approved permission profiles; task state and evidence persist outside workers. Workflow retries and explicit replanning follow DESIGN section 4.0. Fresh workers already exist; structured task contracts, separate attempt records and the stronger recovery semantics remain planned. Current model/provider choices and GitHub identities are recorded in DESIGN section 4.1; this amendment migrates none of them.

- **Orchestrator.** LangGraph (JS) on AWS Lambda, checkpoints in Neon. Takes tasks from the boss console, approved agent requests, GitHub events (via a signature-checked webhook relay) and schedules. Splits tasks, briefs the other agents, tracks them to merge. Writes a public, sanitized title for each task.
- **Developer.** Implements an issue and opens a PR using the approved worker runtime and permission profile.
- **QA.** Reviews PRs against the design docs and the QA playbook; writes and runs tests.
- **Scraper-builder.** Writes and repairs per-site essay extractors.
- **Docs-keeper.** After task PRs merged by the orchestrator (not its own docs PRs), updates permitted documentation and checks consistency within its approved publishing scope. Behavioral documentation belongs in the feature PR. Docs-keeper does not edit product SPEC files; governance changes retain the owner-critical gate. Current rollout holds remain in HANDOFF.
- **Router / Categorizer.** Bounded model calls inside ordinary application workflows route capture entries and categorize essays.

Each current GitHub permission profile has its own GitHub App owned by the owner's account; disposable executions reuse the approved profile rather than creating an App per worker.

**PR loop.** Developer opens PR → CI: lint, unit tests, throwaway environment (Terraform + Neon branch), Playwright end-to-end tests, teardown → QA review → merge-rules check. A PR merges automatically when it matches the design docs, passes all tests and passes in the throwaway environment.

**Critical changes need the owner's approval** (the PR goes to the inbox):
- database migrations that drop or rename data
- authentication, secrets or permissions
- Terraform changes to production (not throwaway environments)
- anything that changes what a design doc says the product does
- new paid services or new dependencies
- anything that raises monthly cost

## Stack

TypeScript on Node.js, one public monorepo `kentcrosswise`. Next.js on AWS Lambda via OpenNext behind CloudFront; S3; SQS; EventBridge Scheduler; Secrets Manager (every secret; none in the repo); Route 53 (`kentcrosswise.com`); Neon Postgres (branch per PR); Terraform (state in S3). Runtime model/provider choices live in [../DESIGN.md](../DESIGN.md), sections 0 and 4.1.

## Rules

- Live private records (entries, contacts, diary, mood, real metrics, essay text, execution records and raw tool payloads) never reach a public endpoint or the git repo. Only the sanitized public projection does, read through the restricted `web_public` role.
- Publication into the projection is automatic and fails closed: a record that sanitization cannot establish as safe stays private and is only counted as withheld. Credentials, access links and other people's sensitive information are never published.
- Today the public feeds carry only sanitized titles and event types (the agent event feed) and the sanitized office projection, and the public log (feature 9) its sanitized records and counts.
- Never publish raw model reasoning; publish actions, evidence and concise explanations.
- Planned capabilities are described as planned.
- Model calls must be accounted for in the shared usage ledger. Current accounting and soft-limit gaps are tracked in OPEN-POINTS; they are not guarantees already met by every caller.

## Later (not MVP)

- Capture from iPhone via an Apple Shortcut; Google Voice → Gmail bridge for texting.
- Native mobile app.
