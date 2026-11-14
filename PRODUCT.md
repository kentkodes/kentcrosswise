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

- Public routes: `/` (home), `/demo` (simulated hub in an app frame with Today, People, Mood, Following and Notes tabs), `/office` (team board and Room tab over the sanitized public event feed, with Live and Replay states) and `/bot` (essay bot information and contact).
- Owner routes: capture and routing on the hub, Boss console with usage and a soft spend control, inbox, essay library, setup and reader. H3 assigns capture categories; downstream contact, diary and todo records are not created yet.
- Public pages use only `@kcw/demo-data` and the permitted public sources. Do not expose owner data, call paid models, enable workflows, or alter authentication or infrastructure from a page change.
- Keyboard access, mobile layouts, legible contrast and reduced-motion behaviour are required.
- Not built yet: the remaining private hub features (contacts, diary and mood, calendar, social stats) and the X-ray overlay. The accepted reliability and worker-contract changes also remain implementation work. See [docs/OPEN-POINTS.md](docs/OPEN-POINTS.md).

## Brand Commitments

The visual system is "Paper", recorded in [DESIGN.md](DESIGN.md): quiet neutral surfaces with automatic dark mode, Geist and Geist Mono, a reading layout for long text and a dense layout for owner tools. The office Room keeps its original pixel-art room.

## Evidence on Hand

The repository, approved product specs, working public pages and deterministic `@kcw/demo-data` fixtures are the factual source. Current state is in [the handoff](docs/HANDOFF.md); open work is in [the backlog](docs/OPEN-POINTS.md). No biography, testimonials, customers, personal metrics or private screenshots were supplied for public use.

## Product Principles

- Label simulated hub data clearly; keep real sanitized agent activity visibly separate, and mark Replay with original timestamps.
- Describe only what is delivered; say "planned" for the rest.
- Keep private data and owner controls separate from public exploration.
- Make motion optional and navigation obvious.
