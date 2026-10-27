# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The owner uses a private personal hub. Logged-out visitors explore a public hub demonstration with deterministic synthetic personal data alongside a separately identified real sanitized agent event feed.

## Product Purpose

Kentcrosswise brings together contacts, thoughts, mood, social snapshots and projects. The approved product specification is [docs/hub/SPEC.md](docs/hub/SPEC.md); planned capabilities must not be presented as already delivered.

## Positioning

A personal hub built with a small team of AI agents, with a public demonstration visitors can explore. It is a personal project rather than a commercial SaaS offer.

## Operating Context

Visitors arrive on phones and desktop browsers. Their primary action is to understand the hub and explore the simulated demo; the agent office is secondary. Owner authentication and private data stay outside the public demonstration.

## Capabilities and Constraints

- Existing public routes: home, demo and the agent office. The demo contains synthetic contacts, mood and social snapshots. Current local changes show three real recent homepage events and an office replay of up to the latest 20 recorded events, clearly labeled Replay with original timestamps. The office now pairs its accessible text list with independent pixel-art event illustrations; no invented fallback fills an empty feed.
- This frontend pass covers the public home/demo and shared navigation, followed later by the owner console.
- Public pages use only `@kcw/demo-data` and the existing permitted public sources. Do not expose owner data, call paid models, enable workflows, or alter authentication/infrastructure.
- Keyboard access, mobile layouts, legible contrast and reduced-motion behavior are required.
- The private hub feature set, pixel-office characters for the full team and X-ray system are later product work. The locally integrated office retains the accessible list, play/pause/resume/next, a still reduced-motion default with explicit full-motion Play, and hidden/offscreen pause. A separate /office/preview remains a clearly fictional sample scene. Integration and temporary public review do not establish merge or production deployment.

## Brand Commitments

The owner selected composition 3, Hub window: an original retro-computer-and-landscape homepage inspired by [this video](https://x.com/alimdesigner_/status/2082449286642737341), with gentle day-to-night motion, a prominent Explore the demo entrance, related readable demo styling, and shared navigation. Preserve the reference's atmosphere while producing original artwork and layouts.

## Evidence on Hand

The existing repository, approved product specs, working public pages, and deterministic `@kcw/demo-data` fixtures are the factual source. Current rollout evidence is in [the handoff](docs/HANDOFF.md); outstanding delivery, decisions and later MVP work are in [the active backlog](docs/OPEN-POINTS.md). No biography, testimonials, customers, personal metrics or private screenshots were supplied for public use.

## Product Principles

- Label simulated hub data clearly; distinguish real sanitized agent activity and historical Replay with original timestamps.
- Give the homepage personality while keeping working views readable.
- Keep private data and owner controls separate from public exploration.
- Make motion optional and navigation obvious.

## Office preview — scoped local extension

The owner approved an original overhead woodland studio with small friendly robots and coarse actual pixels, with a watch-and-inspect interaction. The first sequence follows Developer → QA → filing cabinet, including changes requested, failed tests, waiting on the owner and terminal failure. Only merged work is filed.

The workflow is concept → interactive sample preview → real-feed integration. The owner accepted smooth one-native-pixel movement and explicitly requested integration. `/office/preview` retains its fictional samples and makes no public-event request. `/office` now illustrates individual sanitized events with the same artwork and accepted movement, robot/workstation inspection, live-arrival priority and bounded historical replay. The two characters illustrate supported Developer/QA stages, including events reported by the orchestrator; unrepresented agents/types stay neutral with their recorded text. Empty feeds show an idle room without papers or fabricated work. Full-team characters remain future work; the public contract cannot establish concurrent-task identity, so consecutive events never imply one shared task. Only an actual merge event files papers. Direction approval and temporary public review do not establish merge or production deployment. IAM access and the dependent live agent run remain held. See [the scoped brief](docs/office/PREVIEW.md).

The owner accepts the present room composition, layout and explanations, with wording refinement later. The connected full-team direction uses fixed core roles including the Orchestrator boss, expandable workers starting with four Developer seats plus overflow, and individual event illustrations grouped by actual task. Show sanitized task descriptions in logs and the clicked agent inspector; keep task identifiers internal and omit task hyperlinks. `/office/draft` now supplies a separate local fictional composition with 41 ordered events, a provisional 384×304 room and expandable 384×96 annex, plain task descriptions and task-filtered logs with All events. This is a visual review draft, not production task correlation. The [design draft](docs/office/CONNECTED-DRAFT.md) records the required future public-safe correlation/active-snapshot contract and remaining review. Current public copy remains the default. Release review proceeds as documentation cleanup, PR #44 finish, then the office extension.
