# Asset production

## Accepted native landscape — 2026-10-25

The owner-authorized paid `gpt-image-2` reference-image edit produced [a native 2560×1776 PNG candidate](../../output/imagegen/landscape-2560x1776.png), high quality, RGB, 7,666,540 bytes; SHA256 `d8bb1058a9b6b026740925fc102745692fbf35100b44a0e1aad48fb740bbd312`. The [exact prompt](landscape-2560x1776.txt) was copied unchanged; [provenance](landscape-2560x1776.json) records the explicit size/quality/format, original reference and hashes. The Liaison independently verified the PNG with Pillow and viewed the dusk lake/mountains/meadow/fireflies composition, palette and style; no text, UI or computer appeared. No local resampling occurred, and the candidate exceeds the 1536px minimum width.

Owner accepted this candidate in the current chat on 2026-10-25. The shipping `apps/web/src/app/(public)/_home/plates/landscape.png` and ignored `assets/plates/landscape.png` now match the native candidate byte-for-byte (SHA256 above); the raw candidate is preserved. Only the landscape opts into the existing Next.js optimizer, with `sizes="100vw"`; no image conversion, local resampling, new dependency or configuration change was needed. The existing OpenNext image optimizer and CloudFront image route support that delivery path.

Local verification: lint, repository typecheck, production Next build and all 78 web tests passed. A sixteen-case production-browser batch at 1440, 390, 768 and 1024px covered day/night and normal/reduced motion. Every image decoded, no page overflow or browser runtime errors occurred, and the veil transition changed from 2.4s to 0s under reduced motion. Existing optimization returned WebP HTTP 200: 381,460 bytes at desktop and 54,750 bytes at phone width, compared with the preserved 7,666,540-byte native PNG. Captures and the measured report remain local in `.impeccable/review/landscape-*`.

The native engine's separate `check-plate landscape` passed without forcing. Restored archived state and an official `comp-spec` rerun repaired the measured regions-source byte hash after checkout line-ending drift; the regions and visual specification are unchanged. The responsive rerun no longer reports the landscape-size failure but refuses an existing `explore-title` text fidelity reading (58%, structure 67%); finish therefore remains open. No forced pass, approval receipt or review decision was created, and no deployment occurred.

Latest combined integration verification supersedes earlier asset-only failures: 93 focused tests, lint/typecheck, full production OpenNext build and 66 files/1,105 Vitest tests passed independently. The dev browser suite was 29/31; both console cases passed targeted production isolation 2/2. The full production browser suite and other-browser/physical-device checks remain open. Exact scope and office-specific evidence are in `docs/HANDOFF.md`.

## Current supporting assets and provenance

Built-in image_gen produced the original environment, separate CRT/keyboard, and three fictional contact portraits. Exact prompts are beside this note and embedded in the PNGs. `impeccable embed-prompt --scan assets/plates` returned 7 rasters, 0 missing on 2026-10-23. The seventh raster is a clearly named no-reference landscape alternative, not the selected spec plate.

Selected spec paths: `assets/plates/landscape.png` (accepted native 2560×1776 RGB), `retro-computer.png` (1441×1092 RGBA), `paper-surface.png` (256×256 RGB), `avatar-1.png`, `avatar-2.png`, and `avatar-3.png` (each1217×1293 RGB).

The selected landscape is the accepted native replacement documented above. Exact source prompts and JSON provenance remain the source for reproduction; obsolete generation attempts are historical and do not block current delivery.

The CRT is untouched native transparent output, with480453 fully clear pixels. Most solid foreground alpha values are252–253, inherited from image generation. Fine yellow fringe specks near the upper outline are visible on raw transparency but unobtrusive on light/dark proofs. Both proofs were visually inspected; beige surfaces and screen remain intact, without a solid matte or a baked checkerboard. Proofs and dimensions report: `.impeccable/review/asset-proofs/`.

Paper follows the explicit texture exception in Impeccable new-work.md: the clean70×66 paper patch at x1325/y263 in the fixed approved comp was mirror-tiled into256×256 without resampling. It contains only ivory material, no text or UI ink. Origin is embedded; the reproducible script is `verify-assets.py`. This is the only comp-derived shipping pixel material, expressly authorized by that workflow.

All source comp crops were inspected before generation. Final portraits, landscape and CRT were visually inspected. The retained original asset proofs establish supporting-asset appearance; current release state and verification gaps are in `docs/HANDOFF.md`.
