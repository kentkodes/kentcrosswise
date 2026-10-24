# Asset production

Built-in image_gen produced the original environment, separate CRT/keyboard, and three fictional contact portraits. Exact prompts are beside this note and embedded in the PNGs. `impeccable embed-prompt --scan assets/plates` returned 7 rasters, 0 missing on 2026-10-23. The seventh raster is a clearly named no-reference landscape alternative, not the selected spec plate.

Selected spec paths: `assets/plates/landscape.png` (1505×1045 RGB), `retro-computer.png` (1441×1092 RGBA), `paper-surface.png` (256×256 RGB), `avatar-1.png`, `avatar-2.png`, and `avatar-3.png` (each1217×1293 RGB).

The original clean reference-driven landscape is visually closest to the approved composition. It contains no UI, text or computer. Three built-in landscape attempts explicitly requested larger native resolutions; outputs were1505×1045,1505×1045, and1506×1045. Nothing was upscaled. Landscape resolution remains below the requested1.5× dimensions and the gate's reported1536px minimum width. The Liaison owns any owner exception and gate decision.

The CRT is untouched native transparent output, with480453 fully clear pixels. Most solid foreground alpha values are252–253, inherited from image generation. Fine yellow fringe specks near the upper outline are visible on raw transparency but unobtrusive on light/dark proofs. Both proofs were visually inspected; beige surfaces and screen remain intact, without a solid matte or a baked checkerboard. Proofs and dimensions report: `.impeccable/review/asset-proofs/`.

Paper follows the explicit texture exception in Impeccable new-work.md: the clean70×66 paper patch at x1325/y263 in the fixed approved comp was mirror-tiled into256×256 without resampling. It contains only ivory material, no text or UI ink. Origin is embedded; the reproducible script is `verify-assets.py`. This is the only comp-derived shipping pixel material, expressly authorized by that workflow.

All source comp crops were inspected before generation. Final portraits, landscape and CRT were visually inspected. Page code, comp, spec, region map and build-phase state were not changed. No deployment, commits, paid API fallback or process termination was performed.
