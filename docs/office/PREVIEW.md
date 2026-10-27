# Woodland office preview

## Confirmed direction and current scope

The accepted direction is an original overhead woodland studio with small friendly robots, coarse actual pixels and watch-and-inspect interaction. Developer → QA → filing cabinet is the first polished sequence, with changes requested, failed tests, owner waiting and terminal failure. The owner accepted smooth one-native-pixel movement and explicit full-motion autoplay (accepted source `5f689e8163f12c992036da962e91a3caf01b3bfc`) and requested feed integration.

Both steps are implemented locally: `/office/preview` provides fictional scenarios; `/office` illustrates independent real/replay events using the same artwork and movement. The owner accepts the current room composition, layout and explanations; wording refinement can follow later. Publication and production rollout remain separate. IAM access and the dependent live agent run remain held. The current public contract has no task correlation key; implemented vignettes do not imply a shared task or concurrent-task identity.

The next [connected-office design draft](CONNECTED-DRAFT.md) proposes the full core team, an Orchestrator boss, four Developer seats plus an expandable overflow annex, distinct illustrations bundled by actual task, and sanitized logs/agent inspection. Logs and the clicked agent inspector show sanitized task descriptions; task identifiers stay internal and task hyperlinks are omitted. That proposal requires a reviewed correlation/snapshot contract and is not implemented or a final production spec.

## Direction contract

- **THESIS:** Make a robot team's work understandable by watching a paper handoff across a small, readable office.
- **OWN-WORLD:** An overhead rectangular room with honey-colored wooden flooring, short sage walls, dusk windows, a teal Developer at the left desk, an amber QA robot at the right desk, a filing cabinet between them and an entry at the bottom. A few plants and a bookshelf warm the perimeter. Small sprites and broad clear floor space carry the composition. Navy, ivory, Rosarivo and apricot controls connect the surrounding interface to the existing public site.
- **STORY:** Coding becomes a visible paper delivery; QA checks the papers; requested changes return them to Developer; merged work reaches the cabinet. Failure and waiting remain legible states rather than continuous busy animation.
- **FIRST VIEWPORT:** Show the office and a clearly labeled sample-animation state immediately. Visitors can identify the two robots, select one, and find playback controls without deciphering a game interface. Inspection appears beside the room where space permits and below it on phones.
- **FORM:** Code-led native Canvas 2D rendering on a small integer pixel grid, with HTML inspection and controls. The approved concept establishes composition, proportions and detail level, not an obligation to ship a high-resolution illustration as a background. A concept-seed tournament is not used because the owner explicitly pinned this direction and approved the revised composition.

## Implementation boundary

Use a 320×256 logical canvas, a 16×16 tile vocabulary and approximately 16×24 robot sprites. These are implemented project dimensions, not claims about either reference game's assets. Render with a restrained palette, integer drawing coordinates and nearest-neighbor scaling; prefer integer display scales where the viewport permits. Use a fitting layout at narrower widths without horizontal page overflow. Furniture and moving robots must remain distinct rendering layers so they can occlude and animate correctly.

The preview lives at `/office/preview`, links back to the real `/office` and clearly labels its events as fictional samples. It makes no public-event request. The connected `/office` retains the existing public feed contract, latest-20 replay, original timestamps, live priority and accessible list. Unknown agents/types and empty feeds show a neutral room; only a real merged event files papers. No game engine or additional dependency is used.

## Behavior and states

Provide a successful sequence and alternative paths for changes requested, tests failed, waiting on the owner and terminal failure. Only a merged event files the work; approval alone does not. Robot movement, carried papers and work poses make event transitions visible. Manual stepping and reduced motion may show the destination pose directly.

Visitors can select either robot or workstation to inspect its role and sample state using pointer or keyboard. Keep text outside the pixel artwork, use labeled controls and targets of at least 44 CSS pixels, and retain a text equivalent of the current scene. Provide play/pause/resume, optional next and restart controls. Reduced motion supplies the initial still state, but an explicit Play animation choice enables full autoplay without changing the device preference. Scenario changes preserve playback intent and Restart starts fresh autoplay. Animate on browser frames, with each simulation update bounded so current paths advance at most one native pixel; hidden or offscreen views freeze without a catch-up jump.

## Verification and delivery

Verify scene transitions, alternate paths, filing only after merge, playback controls, keyboard inspection, reduced motion, hidden/offscreen suspension and cleanup. Inspect the rendered desktop and phone layouts, including a narrow 320px viewport. Run focused unit/browser tests, lint, typecheck and an appropriate production build. Keep implementation verification distinct from owner approval of the preview and from any deployment claim.

Reference research: [Stardew Valley media](https://www.stardewvalley.net/media/), [creator-published 16×16 interior tiles](https://opengameart.org/content/interior-spritesheet-16x16-tiles), and [Pokémon-inspired 16×16 tiles](https://opengameart.org/node/80656). These informed design signals; no third-party game assets are incorporated.
