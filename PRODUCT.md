# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The owner uses the private personal helper (the hub). Logged-out visitors see that helper working. Target (owner direction 2026-11-17, planned, not built): the public surface is a feed of sanitized real task records, each with its evidence in the X-ray, published automatically after sanitization with some records withheld for privacy or security. Today visitors get a simulated hub demo (`/demo`) and a separately identified real sanitized agent event feed (`/office` and the home page).

## Product Purpose

Kentcrosswise is the owner's personal helper: it captures inputs, routes them and acts on them. The public site exists to show that helper working, with real inputs, real routing and real evidence: the helper is the product, and inspectable engineering evidence is its public proof. The autonomous development system (durable tasks carried through implementation, independent review and delivery by disposable workers with approved permissions) is how the site is built and maintained. Reliability precedes further feature expansion. The accepted targets are in [docs/DESIGN.md](docs/DESIGN.md) (sections 4.0 and 4.6); the requirements are [docs/hub/SPEC.md](docs/hub/SPEC.md) and [docs/essays/SPEC.md](docs/essays/SPEC.md). Planned capabilities must not be presented as already delivered.

## Positioning

A personal helper with a public, sanitized record of its real work and the evidence behind each task. It is a personal project rather than a commercial SaaS offer, and the public surface is a demonstration of the real thing, nothing more: no social or playground features (owner direction 2026-11-17).

## Operating Context

Visitors arrive on phones and desktop browsers. They come to understand the project and see what the helper actually did: today through the agent office and the simulated demo, later through published task records. Owner authentication, live private records and owner controls stay outside the public surface; the public reads only a sanitized projection.

## Capabilities and Constraints

- Public routes: `/` (home), `/demo` (simulated hub in an app frame with Today, People, Mood, Following, Notes and Essays tabs; the Essays tab shows six public-domain essays from Project Gutenberg as link-only entries, with facts, a demo-written hook and the source link but no essay text, a recommended card from simulated ratings and a reader panel with a rating form that keeps its state until reload, all from `@kcw/demo-data`), `/office` (team board and Room tab over the sanitized public event feed, with Live and Replay states) and `/bot` (essay bot information and contact), `/terms` (terms of use) and `/privacy` (privacy notice). `/terms` and `/privacy` are static Paper reading pages linked from the footer. On `/`, `/demo`, `/office` and `/bot` a header toggle turns on the X-ray overlay, which labels the technology behind each part.
- Owner routes: capture and routing on the hub, Boss console with usage and a soft spend control, inbox, essay library, setup and reader. Each routed capture creates one derived record (CRM note, diary entry, todo or idea); agent requests stay a category.
- Contacts (`/contacts`): name, aliases, how known, birthday, notes and tags; filter by name, alias or tag. CRM notes, including those created from captures, link to contacts by name match; an ambiguous match waits for the owner's choice.
- Connections (`/connections`) and notifications (`/notifications`): the owner connects or disconnects Google (Calendar events and read-only YouTube; the token is stored in the site's secret store), and enables web push on a device. Calendar suggestions from notes can be added to Google Calendar with one tap.
- Diary and mood: `/diary` (write and list entries, mood summary per entry), `/diary/[id]` (read, edit, delete with confirmation, mood scores, Score again) and `/mood` (overall sentiment and eight metrics over the last 90 days or all, per-metric checkboxes, text summary and data table). Scoring runs only where the model router is configured.
- Lists: `/todos`, `/ideas` and `/projects` (project tabs; the Essays tab summarises the library).
- Social: `/social` shows followers and views for YouTube, Instagram and TikTok accounts: totals of each account's latest known numbers for a source filter, the change against the previous known value, a followers trend, and manual entry of daily numbers. A daily job adds YouTube and Instagram snapshots for the one account per platform that the owner marks for it when adding the account; no account is marked yet (owner step in OPEN-POINTS). TikTok stays manual.
- Social: dropped for now (owner direction 2026-11-17). No further social work; whether the owner `/social` page and its daily job are parked too, or only the public and demo social surfaces, is an open point in OPEN-POINTS.
- Published task records (planned, owner direction 2026-11-17; design target in DESIGN section 4.6, not built): every routed input gets a private execution record; publication is automatic after sanitization with no per-record approval, fails closed, and never includes credentials or access links, other people's sensitive information or unsanitized raw tool payloads. The feed is labelled "Tasks published automatically after sanitization; some records withheld for privacy/security" with a withheld count and no withheld contents. A record carries pass/fail checks for that run, not an accuracy percentage; accuracy claims belong to versioned aggregates over a labelled set. The feed is not a complete reliability record.
- Public pages use only `@kcw/demo-data`, `@kcw/xray` and the permitted public sources (public API routes reading sanitized views through the `web_public` role). Do not expose owner data or live private records, call paid models, enable workflows, or alter authentication or infrastructure from a page change.
- Keyboard access, mobile layouts, legible contrast and reduced-motion behaviour are required.
- Not built: the published task records feed and the per-task evidence X-ray (planned). Not set up yet: the live Google and Instagram connections and push on a device (owner steps in OPEN-POINTS). The accepted reliability and worker-contract changes also remain implementation work. See [docs/OPEN-POINTS.md](docs/OPEN-POINTS.md).

## Brand Commitments

The visual system is "Paper", recorded in [DESIGN.md](DESIGN.md): quiet neutral surfaces with automatic dark mode, Geist and Geist Mono, a reading layout for long text and a dense layout for owner tools. The office Room keeps its original pixel-art room.

## Evidence on Hand

The repository, approved product specs, working public pages and deterministic `@kcw/demo-data` fixtures are the factual source. Current state is in [the handoff](docs/HANDOFF.md); open work is in [the backlog](docs/OPEN-POINTS.md). No biography, testimonials, customers, personal metrics or private screenshots were supplied for public use.

## Product Principles

- Show the real helper: public records come from real inputs and real routing, through a sanitized projection, never from live private records.
- Publish automatically, fail closed: when sanitization cannot establish that a record is safe, it stays private, and the feed says how many were withheld.
- Show actions, evidence and concise explanations, never raw model reasoning. "Completed, checks passed, no recovery needed" is a complete record; do not invent a failure story.
- Evaluate honestly: per-record checks are pass/fail facts about that run; accuracy is a versioned aggregate over a labelled set; the feed is never presented as a complete reliability record.
- Label simulated hub data clearly; keep real sanitized agent activity visibly separate, and mark Replay with original timestamps.
- Describe only what is delivered; say "planned" for the rest.
- Keep private data and owner controls separate from public exploration.
- Make motion optional and navigation obvious.
