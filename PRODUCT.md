# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The owner uses a private personal hub. Logged-out visitors explore a public hub demonstration with deterministic synthetic personal data alongside a separately identified real sanitized agent event feed.

## Product Purpose

Kentcrosswise's primary goal is autonomous development: durable tasks carried through implementation, independent review and delivery by disposable workers with approved permissions. The personal hub and private essay library are its demonstration workload. Reliability precedes further feature expansion. The accepted target is in [docs/DESIGN.md](docs/DESIGN.md); the demonstration requirements are [docs/hub/SPEC.md](docs/hub/SPEC.md) and [docs/essays/SPEC.md](docs/essays/SPEC.md). Planned capabilities must not be presented as already delivered.

## Positioning

An autonomous development system demonstrated by a personal hub and a public view of sanitized execution activity. It is a personal project rather than a commercial SaaS offer.

## Operating Context

Visitors arrive on phones and desktop browsers. They come to understand the project, watch the agent office and explore the simulated demo. Owner authentication and private data stay outside the public demonstration.

## Capabilities and Constraints

- Public routes: `/` (home), `/demo` (simulated hub in an app frame with Today, People, Mood, Following, Notes and Essays tabs; the Essays tab shows six public-domain essays from Project Gutenberg as link-only entries, with facts, a demo-written hook and the source link but no essay text, a recommended card from simulated ratings and a reader panel with a rating form that keeps its state until reload, all from `@kcw/demo-data`), `/office` (team board and Room tab over the sanitized public event feed, with Live and Replay states) and `/bot` (essay bot information and contact), `/terms` (terms of use) and `/privacy` (privacy notice). `/terms` and `/privacy` are static Paper reading pages linked from the footer. On `/`, `/demo`, `/office` and `/bot` a header toggle turns on the X-ray overlay, which labels the technology behind each part.
- Owner routes: capture and routing on the hub, Boss console with usage and a soft spend control, inbox, essay library, setup and reader. Each routed capture creates one derived record (CRM note, diary entry, todo or idea); agent requests stay a category.
- Contacts (`/contacts`): name, aliases, how known, birthday, notes and tags; filter by name, alias or tag. CRM notes link to contacts by name match; an ambiguous match waits for the owner's choice. Notes from captures are linked by name when the route is saved; an ambiguous match waits for the owner's choice.
- Connections (`/connections`) and notifications (`/notifications`): the owner connects or disconnects Google (Calendar events and read-only YouTube; the token is stored in the site's secret store), and enables web push on a device. Calendar suggestions from notes can be added to Google Calendar with one tap.
- Diary and mood: `/diary` (write and list entries, mood summary per entry), `/diary/[id]` (read, edit, delete with confirmation, mood scores, Score again) and `/mood` (overall sentiment and eight metrics over the last 90 days or all, per-metric checkboxes, text summary and data table). Scoring runs only where the model router is configured.
- Lists: `/todos`, `/ideas` and `/projects` (project tabs; the Essays tab summarises the library).
- Social: `/social` shows followers and views for YouTube, Instagram and TikTok accounts: totals of each account's latest known numbers for a source filter, the change against the previous known value, a followers trend, and manual entry of daily numbers. A daily job adds YouTube and Instagram snapshots for the connected accounts; TikTok stays manual.
- Public pages use only `@kcw/demo-data` and the permitted public sources. Do not expose owner data, call paid models, enable workflows, or alter authentication or infrastructure from a page change.
- Keyboard access, mobile layouts, legible contrast and reduced-motion behaviour are required.
- Not built yet: the TikTok API ingestion (optional, later) and the owner steps that connect the live accounts and enable push on a device. The accepted reliability and worker-contract changes also remain implementation work. See [docs/OPEN-POINTS.md](docs/OPEN-POINTS.md).

## Brand Commitments

The visual system is "Paper", recorded in [DESIGN.md](DESIGN.md): quiet neutral surfaces with automatic dark mode, Geist and Geist Mono, a reading layout for long text and a dense layout for owner tools. The office Room keeps its original pixel-art room.

## Evidence on Hand

The repository, approved product specs, working public pages and deterministic `@kcw/demo-data` fixtures are the factual source. Current state is in [the handoff](docs/HANDOFF.md); open work is in [the backlog](docs/OPEN-POINTS.md). No biography, testimonials, customers, personal metrics or private screenshots were supplied for public use.

## Product Principles

- Label simulated hub data clearly; keep real sanitized agent activity visibly separate, and mark Replay with original timestamps.
- Describe only what is delivered; say "planned" for the rest.
- Keep private data and owner controls separate from public exploration.
- Make motion optional and navigation obvious.
