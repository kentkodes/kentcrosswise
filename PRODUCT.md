# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The owner uses a private personal hub. Logged-out visitors explore a public demonstration made entirely from deterministic synthetic data and a sanitized agent event feed.

## Product Purpose

Kentcrosswise brings together contacts, thoughts, mood, social snapshots and projects. The approved product specification is [docs/hub/SPEC.md](docs/hub/SPEC.md); planned capabilities must not be presented as already delivered.

## Positioning

A personal hub built with a small team of AI agents, with a public demonstration visitors can explore. It is a personal project rather than a commercial SaaS offer.

## Operating Context

Visitors arrive on phones and desktop browsers. Their primary action is to understand the hub and explore the simulated demo; the agent office is secondary. Owner authentication and private data stay outside the public demonstration.

## Capabilities and Constraints

- Existing public routes: home, demo and an agent-office text feed. The current demo contains synthetic contacts, mood and social snapshots.
- This frontend pass covers the public home/demo and shared navigation, followed later by the owner console.
- Public pages use only `@kcw/demo-data` and the existing permitted public sources. Do not expose owner data, call paid models, enable workflows, or alter authentication/infrastructure.
- Keyboard access, mobile layouts, legible contrast and reduced-motion behavior are required.
- The private hub feature set, pixel-art office and X-ray system are later product work; this pass must not claim they already exist.

## Brand Commitments

The owner selected composition 3, Hub window: an original retro-computer-and-landscape homepage inspired by [this video](https://x.com/alimdesigner_/status/2082449286642737341), with gentle day-to-night motion, a prominent Explore the demo entrance, related readable demo styling, and shared navigation. Preserve the reference's atmosphere while producing original artwork and layouts.

## Evidence on Hand

The existing repository, approved product specs, working public pages, and deterministic `@kcw/demo-data` fixtures are the factual source. No biography, testimonials, customers, personal metrics or private screenshots were supplied for public use.

## Product Principles

- Let visitors experience the hub through a clearly labeled simulation.
- Give the homepage personality while keeping working views readable.
- Keep private data and owner controls separate from public exploration.
- Make motion optional and navigation obvious.
