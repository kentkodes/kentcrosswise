# Woodland office preview

## Confirmed direction

The owner approved a watch-and-inspect woodland studio with small friendly robots, beginning with one polished Developer → QA → filing-cabinet sequence. The first illustration was rejected for its room composition. The revised direction is an overhead, coarse-pixel room inspired by the spatial clarity of Pokémon interiors and the warmth of Stardew Valley. The owner approved that revised direction on 2026-10-25.

The agreed workflow is concept → interactive sample preview → public-feed integration. This document covers the middle step. IAM access and the dependent live agent run remain on hold. Preview acceptance and public-feed integration are subsequent steps.

## Direction contract

- **THESIS:** Make a robot team's work understandable by watching a paper handoff across a small, readable office.
- **OWN-WORLD:** An overhead rectangular room with honey-colored wooden flooring, short sage walls, dusk windows, a teal Developer at the left desk, an amber QA robot at the right desk, a filing cabinet between them and an entry at the bottom. A few plants and a bookshelf warm the perimeter. Small sprites and broad clear floor space carry the composition. Navy, ivory, Rosarivo and apricot controls connect the surrounding interface to the existing public site.
- **STORY:** Coding becomes a visible paper delivery; QA checks the papers; requested changes return them to Developer; merged work reaches the cabinet. Failure and waiting remain legible states rather than continuous busy animation.
- **FIRST VIEWPORT:** Show the office and a clearly labeled sample-animation state immediately. Visitors can identify the two robots, select one, and find playback controls without deciphering a game interface. Inspection appears beside the room where space permits and below it on phones.
- **FORM:** Code-led native Canvas 2D rendering on a small integer pixel grid, with HTML inspection and controls. The approved concept establishes composition, proportions and detail level, not an obligation to ship a high-resolution illustration as a background. A concept-seed tournament is not used because the owner explicitly pinned this direction and approved the revised composition.

## Implementation boundary

Use a 320×256 logical canvas, a 16×16 tile vocabulary and approximately 16×24 robot sprites. These are production proposals, not claims about either reference game's asset dimensions. Render with a restrained palette, integer drawing coordinates and nearest-neighbor scaling; prefer integer display scales where the viewport permits. Use a fitting layout at narrower widths without horizontal page overflow. Furniture and moving robots must remain distinct rendering layers so they can occlude and animate correctly.

The preview lives at `/office/preview`, links back to the real `/office` and clearly labels its events as fictional samples. It makes no public-event request and changes neither the existing feed contract nor the real/replay page. No additional game engine or dependency is needed. Public-feed integration follows preview review; the existing public feed has no task correlation key, so it must not be used to invent concurrent-task identity.

## Behavior and states

Provide a successful sequence and alternative paths for changes requested, tests failed, waiting on the owner and terminal failure. Only a merged event files the work; approval alone does not. Robot movement, carried papers and work poses make event transitions visible. Manual stepping and reduced motion may show the destination pose directly.

Visitors can select either robot or workstation to inspect its role and sample state using pointer or keyboard. Keep text outside the pixel artwork, use labeled controls and targets of at least 44 CSS pixels, and retain a text equivalent of the current scene. Provide pause/resume, next and restart controls. Respect reduced motion with manual progression, and freeze the simulation while hidden or offscreen without a catch-up jump.

## Verification and delivery

Verify scene transitions, alternate paths, filing only after merge, playback controls, keyboard inspection, reduced motion, hidden/offscreen suspension and cleanup. Inspect the rendered desktop and phone layouts, including a narrow 320px viewport. Run focused unit/browser tests, lint, typecheck and an appropriate production build. Keep implementation verification distinct from owner approval of the preview and from any deployment claim.

Reference research: [Stardew Valley media](https://www.stardewvalley.net/media/), [creator-published 16×16 interior tiles](https://opengameart.org/content/interior-spritesheet-16x16-tiles), and [Pokémon-inspired 16×16 tiles](https://opengameart.org/node/80656). These informed design signals; no third-party game assets are incorporated.
