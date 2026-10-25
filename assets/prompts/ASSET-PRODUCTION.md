# Asset production

## Native landscape candidate — 2026-10-25

The owner-authorized paid `gpt-image-2` reference-image edit produced [a native 2560×1776 PNG candidate](../../output/imagegen/landscape-2560x1776.png), high quality, RGB, 7,666,540 bytes; SHA256 `d8bb1058a9b6b026740925fc102745692fbf35100b44a0e1aad48fb740bbd312`. The [exact prompt](landscape-2560x1776.txt) was copied unchanged; [provenance](landscape-2560x1776.json) records the explicit size/quality/format, original reference and hashes. The Liaison independently verified the PNG with Pillow and viewed the dusk lake/mountains/meadow/fireflies composition, palette and style; no text, UI or computer appeared. No local resampling occurred, and the candidate exceeds the 1536px minimum width.

Owner accepted this candidate in the current chat on 2026-10-25. The shipping `apps/web/src/app/(public)/_home/plates/landscape.png` and ignored `assets/plates/landscape.png` now match the native candidate byte-for-byte (SHA256 above); the raw candidate is preserved. Only the landscape opts into the existing Next.js optimizer, with `sizes="100vw"`; no image conversion, local resampling, new dependency or configuration change was needed. The existing OpenNext image optimizer and CloudFront image route support that delivery path. An earlier generation call returned exhausted-credit HTTP 429 without an image; the owner added credits and explicitly authorized the successful retry.

Local verification: lint, repository typecheck, production Next build and all 78 web tests passed. A sixteen-case production-browser batch at 1440, 390, 768 and 1024px covered day/night and normal/reduced motion. Every image decoded, no page overflow or browser runtime errors occurred, and the veil transition changed from 2.4s to 0s under reduced motion. Existing optimization returned WebP HTTP 200: 381,460 bytes at desktop and 54,750 bytes at phone width, compared with the preserved 7,666,540-byte native PNG. Captures and the measured report remain local in `.impeccable/review/landscape-*`.

The native engine's separate `check-plate landscape` passed without forcing. Restored archived state and an official `comp-spec` rerun repaired the measured regions-source byte hash after checkout line-ending drift; the regions and visual specification are unchanged. The responsive rerun no longer reports the landscape-size failure but refuses an existing `explore-title` text fidelity reading (58%, structure 67%); finish therefore remains open. No forced pass, approval receipt or review decision was created, and no deployment occurred. The earlier production notes below describe the original asset pass, before this accepted replacement.

Broader checks remain qualified: the existing e2e suite passed 23/25 with two workers (console pause/resume assertion and a signed-in demo navigation timeout failed). The OpenNext build completed its Next production build but could not complete the Windows sharp workaround because the offline npm cache lacked `sharp@0.35.5` for Linux arm64. Neither failure was bypassed by changing application/configuration code.

## Original asset pass — 2026-10-23

Built-in image_gen produced the original environment, separate CRT/keyboard, and three fictional contact portraits. Exact prompts are beside this note and embedded in the PNGs. `impeccable embed-prompt --scan assets/plates` returned 7 rasters, 0 missing on 2026-10-23. The seventh raster is a clearly named no-reference landscape alternative, not the selected spec plate.

Selected spec paths: `assets/plates/landscape.png` (1505×1045 RGB), `retro-computer.png` (1441×1092 RGBA), `paper-surface.png` (256×256 RGB), `avatar-1.png`, `avatar-2.png`, and `avatar-3.png` (each1217×1293 RGB).

The original clean reference-driven landscape is visually closest to the approved composition. It contains no UI, text or computer. Three built-in landscape attempts explicitly requested larger native resolutions; outputs were1505×1045,1505×1045, and1506×1045. Nothing was upscaled. Landscape resolution remains below the requested1.5× dimensions and the gate's reported1536px minimum width. The Liaison owns any owner exception and gate decision.

The CRT is untouched native transparent output, with480453 fully clear pixels. Most solid foreground alpha values are252–253, inherited from image generation. Fine yellow fringe specks near the upper outline are visible on raw transparency but unobtrusive on light/dark proofs. Both proofs were visually inspected; beige surfaces and screen remain intact, without a solid matte or a baked checkerboard. Proofs and dimensions report: `.impeccable/review/asset-proofs/`.

Paper follows the explicit texture exception in Impeccable new-work.md: the clean70×66 paper patch at x1325/y263 in the fixed approved comp was mirror-tiled into256×256 without resampling. It contains only ivory material, no text or UI ink. Origin is embedded; the reproducible script is `verify-assets.py`. This is the only comp-derived shipping pixel material, expressly authorized by that workflow.

All source comp crops were inspected before generation. Final portraits, landscape and CRT were visually inspected. Page code, comp, spec, region map and build-phase state were not changed. No deployment, commits, paid API fallback or process termination was performed.
