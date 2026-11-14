# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The owner uses a private personal hub. Logged-out visitors explore a public hub demonstration with deterministic synthetic personal data alongside a separately identified real sanitized agent event feed.

## Product Purpose

Kentcrosswise brings together contacts, thoughts, mood, social snapshots, projects and a private essay library. The approved product specifications are [docs/hub/SPEC.md](docs/hub/SPEC.md) and [docs/essays/SPEC.md](docs/essays/SPEC.md); planned capabilities must not be presented as already delivered.

## Positioning

A personal hub built with a small team of AI agents, with a public demonstration visitors can explore. It is a personal project rather than a commercial SaaS offer.

## Operating Context

Visitors arrive on phones and desktop browsers. They come to understand the project, watch the agent office and explore the simulated demo. Owner authentication and private data stay outside the public demonstration.

## Capabilities and Constraints

- Public routes: `/` (home), `/demo` (simulated hub in an app frame with Today, People, Mood, Following and Notes tabs), `/office` (team board and Room tab over the sanitized public event feed, with Live and Replay states) and `/bot` (essay bot information and contact).
- Owner routes: hub links, Boss console with usage and spend cap, inbox, essay library, setup and reader.
- Public pages use only `@kcw/demo-data` and the permitted public sources. Do not expose owner data, call paid models, enable workflows, or alter authentication or infrastructure from a page change.
- Keyboard access, mobile layouts, legible contrast and reduced-motion behaviour are required.
- Not built yet: the private hub feature set (contacts, diary and mood, calendar, social stats), routing and the X-ray overlay. See [docs/OPEN-POINTS.md](docs/OPEN-POINTS.md).

## Brand Commitments

The visual system is "Paper", recorded in [DESIGN.md](DESIGN.md): quiet neutral surfaces with automatic dark mode, Geist and Geist Mono, a reading layout for long text and a dense layout for owner tools. The office Room keeps its original pixel-art room.

## Evidence on Hand

The repository, approved product specs, working public pages and deterministic `@kcw/demo-data` fixtures are the factual source. Current state is in [the handoff](docs/HANDOFF.md); open work is in [the backlog](docs/OPEN-POINTS.md). No biography, testimonials, customers, personal metrics or private screenshots were supplied for public use.

## Product Principles

- Label simulated hub data clearly; keep real sanitized agent activity visibly separate, and mark Replay with original timestamps.
- Describe only what is delivered; say "planned" for the rest.
- Keep private data and owner controls separate from public exploration.
- Make motion optional and navigation obvious.
