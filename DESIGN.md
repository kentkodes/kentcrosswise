---
# Visual system only. The repository's architecture and task design live in docs/DESIGN.md.
name: Kentcrosswise
description: A paper hub window held up in a painted dusk meadow, set in one editorial serif.
colors:
  apricot: "#f8d9a8"
  apricot-lit: "#fbe3bc"
  dusk-navy: "#1b2340"
  entrance-ink: "#232a46"
  ivory: "#f6f1e4"
  greige-paper: "#eadbcd"
  panel-wash: "rgb(249 235 216 / 0.8)"
  honey-select: "#f4d7b3"
  label-chip: "#f7e4d1"
  label-chip-edge: "#e6cfb9"
  rule: "#e2d1c0"
  ink: "#120e0b"
  ink-muted: "#7d7166"
  bark-focus: "#8a5a2b"
  toggle-slate: "#4b4541"
  meadow-green: "#1f8a68"
  ember-coral: "#e6604f"
  periwinkle-tile: "#e3e6f4"
  periwinkle-ink: "#5166b0"
  presence-green: "#2f9e5e"
  firefly-gold: "#ffd877"
  office-control: "#252e49"
  office-control-edge: "#aaa28f"
  office-muted: "#e5d8bf"
  office-hover: "#3d465e"
  office-divider: "#847d78"
  office-teal: "#67baa6"
  office-amber: "#e4ad55"
typography:
  office-label:
    fontFamily: "Rosarivo, Georgia, serif"
    fontSize: "14px"
    fontWeight: 400
  office-state:
    fontFamily: "Rosarivo, Georgia, serif"
    fontSize: "21px"
    fontWeight: 400
  office-role:
    fontFamily: "Rosarivo, Georgia, serif"
    fontSize: "28px"
    fontWeight: 400
  office-heading:
    fontFamily: "Rosarivo, Georgia, serif"
    fontSize: "clamp(30px, 4vw, 44px)"
    fontWeight: 400
  display:
    fontFamily: "Rosarivo, Georgia, serif"
    fontSize: "clamp(36px, 10vw, 50px)"
    fontWeight: 400
    lineHeight: 1.22
    letterSpacing: "-0.022em"
  wordmark:
    fontFamily: "Rosarivo, Georgia, serif"
    fontSize: "30px"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "-0.032em"
  headline:
    fontFamily: "Rosarivo, Georgia, serif"
    fontSize: "32px"
    fontWeight: 400
    lineHeight: 1.3
  title:
    fontFamily: "Rosarivo, Georgia, serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: "22px"
  body:
    fontFamily: "Rosarivo, Georgia, serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Rosarivo, Georgia, serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.2
  caption:
    fontFamily: "Rosarivo, Georgia, serif"
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: "17px"
  figure:
    fontFamily: "PT Serif, Rosarivo, Georgia, serif"
    fontSize: "25px"
    fontWeight: 400
    lineHeight: "31px"
    fontFeature: "lnum, tnum"
rounded:
  office-target: "4px"
  pill: "999px"
  window: "22px"
  surface: "15px"
  panel: "12px"
  tile: "10px"
  item: "9px"
  row: "8px"
spacing:
  hair: "4px"
  tight: "8px"
  inset: "14px"
  step: "16px"
  gutter: "20px"
  gutter-wide: "40px"
components:
  office-target:
    rounded: "{rounded.office-target}"
    width: "44px"
    height: "44px"
  button-entrance:
    backgroundColor: "{colors.apricot}"
    textColor: "{colors.entrance-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    padding: "0 28px 0 32px"
    height: "58px"
  button-entrance-hover:
    backgroundColor: "{colors.apricot-lit}"
  button-sign-in:
    textColor: "{colors.ivory}"
    rounded: "{rounded.pill}"
    padding: "0 22px"
    height: "44px"
  nav-link:
    textColor: "{colors.ivory}"
    padding: "6px 0"
  hub-window:
    backgroundColor: "{colors.greige-paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.window}"
  panel:
    backgroundColor: "{colors.panel-wash}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "14px 14px 12px"
  side-link:
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.item}"
    padding: "0 12px"
    height: "38px"
  side-link-current:
    backgroundColor: "{colors.honey-select}"
  simulated-label:
    backgroundColor: "{colors.label-chip}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0 14px"
    height: "32px"
  explore-row:
    rounded: "{rounded.tile}"
    padding: "8px 14px 8px 12px"
  activity-tile:
    backgroundColor: "{colors.periwinkle-tile}"
    textColor: "{colors.periwinkle-ink}"
    rounded: "{rounded.row}"
    size: "32px"
  day-night-toggle:
    backgroundColor: "{colors.toggle-slate}"
    rounded: "{rounded.pill}"
    width: "86px"
    height: "40px"
  footer:
    backgroundColor: "{colors.dusk-navy}"
    textColor: "{colors.ivory}"
---

Visual system for the Kentcrosswise public surfaces; the architectural design doc is `docs/DESIGN.md`, which this file does not replace.

# Design System: Kentcrosswise

Derived from the shipped public home (`apps/web/src/app/(public)/page.tsx`, `_home/*`, tokens in `_home/home.module.css`; the shared header and the demo/office page look in `_site/*`), the approved comp `.impeccable/mocks/03-hub-window.png`, and the review captures in `.impeccable/review/`. The build is the ground truth; where the comp and the build differ, the build is recorded.

## Overview

**Creative North Star: "The Paper Window in the Meadow"**

A painted dusk landscape (lake, mountains, a meadow with wildflowers, a warm beige retro computer in the grass) holds up a large ivory-and-greige paper window that is the personal hub. The scene is atmosphere; the window is where everything readable lives. Ivory serif type sits on the sky for the few words that address the visitor; every name, number and chart sits on paper.

The system is warm, quiet and editorial. One serif at one weight carries every letter, with hierarchy made by size alone. Colour is a dusk palette: apricot for the single way in, navy for the night that closes the page, greige and peach-cream paper for the hub, and two restrained chart inks (meadow green, ember coral). Depth comes from layered translucent paper and soft, long ambient shadows, never from hard edges.

Motion is bounded and optional: a 2.4s day-to-night veil cross-fade driven by an explicit two-option toggle, and a fixed set of drifting firefly lights that pause offscreen and hold still under reduced motion. Painted things (scene, computer, portraits, paper grain) are authored rasters with embedded provenance; everything interactive or textual is semantic native DOM and inline SVG.

**Key Characteristics:**
- One serif (Rosarivo 400) for all letters; PT Serif 400 supplies lining, tabular digits only.
- A paper hub window as the container for all product UI, set into a painted scene.
- Apricot as the single call-to-action fill; ivory text and outline pills on the scene.
- Translucent layered paper and soft ambient shadows for depth.
- Pills and gently rounded panels; no sharp corners on interactive surfaces.
- Bounded, user-controlled day/night motion with a reduced-motion still state.

## Colors

A dusk palette: warm apricot and paper against a deep navy night, with two small chart inks.

### Primary
- **Apricot Dusk** (`apricot`): the fill of the one primary entrance ("Explore the demo"), the text-selection background, the page focus ring, and the hover underline in the footer. It is the colour of the way in.
- **Lit Apricot** (`apricot-lit`): the entrance's hover state only.
- **Entrance Ink** (`entrance-ink`): text and arrow on the apricot entrance; a navy tuned to the dusk sky rather than black.

### Secondary
- **Dusk Navy** (`dusk-navy`): the body ground behind the page, the footer, and the end of the meadow-to-night gradient below the scene (`#1f2617` to dusk navy at 70%). The night that closes the page.
- **Ivory** (`ivory`): all type set directly on the scene or the footer (wordmark, nav, headline, footer text). Translucent ivory forms the sign-in outline (85%), its hover wash (12%), the nav divider (35%), the footer rule (14%) and the footer note (74%).

### Tertiary
- **Meadow Green** (`meadow-green`): the Happiness chart line, points and area wash.
- **Ember Coral** (`ember-coral`): the Stress chart line, points and area wash.
- **Periwinkle Tile / Ink** (`periwinkle-tile`, `periwinkle-ink`): the cool square tiles of Recent activity rows, the only cool note on the paper.
- **Presence Green** (`presence-green`): the small online dot on avatars, ringed in cream.
- **Firefly Gold** (`firefly-gold`): the ambient lights, a radial from `#fff6cf` through firefly gold to transparent with a soft warm glow.

### Neutral
- **Greige Paper** (`greige-paper`): the hub window ground under a 256px tiled paper-grain plate.
- **Panel Wash** (`panel-wash`): translucent cream panel fill so the paper grain reads through. Explore rows use a close sibling (`rgb(249 233 213 / 0.85)`, hover `rgb(255 248 236 / 0.9)`).
- **Honey Select** (`honey-select`): the current sidebar item; 45% of it is the sidebar hover.
- **Label Chip** (`label-chip`, edge `label-chip-edge`): the Simulated data label.
- **Rule** (`rule`): every hairline divider inside the hub (header, sidebar, list separators, mood column divider). Panel borders sit just darker (`#e5d4c3`, `#e3d1bf`).
- **Ink** (`ink`): primary text on paper; per-element near-blacks (`#14100e` to `#2c2520`) stay within this warm-brown family.
- **Ink Muted** (`ink-muted`): panel asides ("View all", "Last 7 days", "Total") and explore descriptions. Activity timestamps go lighter still (`#9a8d82`).
- **Bark Focus** (`bark-focus`): the focus ring colour inside the hub, where apricot would vanish on paper.
- **Toggle Slate** (`toggle-slate`): the day/night toggle track (gradient to `#3c3a3d`), the only dark object on the paper.

### Named Rules
**The Single Apricot Rule.** Apricot fills exactly one control per view: the primary entrance. Elsewhere it appears only as selection, focus and underline accents, never as a second filled button.

**The Two Inks Rule.** Meadow green and ember coral are data inks. They mark chart lines, points and area washes and nothing else; chrome, buttons and text never borrow them.

**The Warm Ink Rule.** Text on paper is a warm brown-black, never neutral grey or pure black; muted text stays in the same warm family.

## Typography

**Display Font:** Rosarivo 400 (self-hosted, OFL; fallback Georgia, Times New Roman, serif)
**Body Font:** Rosarivo 400
**Figures:** PT Serif 400 (self-hosted, OFL), limited by `unicode-range` to digits, comma and full stop and stacked before Rosarivo, so numbers get lining figures and every letter stays Rosarivo.

**Character:** A literary, slightly calligraphic old-style serif used at a single weight everywhere, from a 50px headline to 11px timestamps; it makes the hub read like a well-kept notebook rather than a dashboard. PT Serif's sturdier lining figures keep numbers level and tabular.

### Hierarchy
Narrow and tablet values are listed first. From 1100px the page is a 1505x1045 stage scaled to the window width, so stage values are comp pixels multiplied by window width / 1505 (about 0.96 at 1440px), and the hub's content is further foreshortened by its perspective tilt.
- **Display** (400, `clamp(36px, 10vw, 50px)`, 1.22; stage 50px/61px, -0.022em): the two-line headline on the scene, ivory, balanced wrapping.
- **Wordmark** (400, 30px, 1; stage 38px, -0.032em): "Kentcrosswise" top left. Footer mark 24px; hub brand 22px (stage 24px).
- **Headline** (400, 32px, 1.3; stage 35px/47px): the hub greeting.
- **Title** (400, 15px/22px): panel titles. On the stage a 0.3px text stroke restores ink weight lost to the projection.
- **Body** (400, 16px, 1.5; stage 16.7px/26px): the hub lede. Footer note 15px/1.6 at a 60ch measure. Entrance label 20px; nav and sign-in 17px (stage 16.5px).
- **Label** (400, 13px, 1.2): sidebar items, people and platform names, activity titles (12.8px/18px), mood labels (12px/20px), Simulated data (14px).
- **Caption** (400, 11.5px/17px): panel asides and explore descriptions; activity timestamps 11px/15px.
- **Figure** (PT Serif digits, 400, 25px/31px, lining and tabular): mood values. Follower counts 18px; chart axis labels 13.5px in the flowing layouts.

### Named Rules
**The One Weight Rule.** Every letter is Rosarivo 400. Hierarchy comes from size, colour and placement; there is no bold, no italic emphasis and no uppercase tracking.

**The Lining Numbers Rule.** Any numeral that carries data is set in the figure stack with `lining-nums tabular-nums`, so columns of counts and values align.

## Layout

Three layouts, switched at 640px and 1100px.

Demo and agent office share the public look without the scene: dusk navy ground, ivory Rosarivo 400 (headings not synthesised bold), apricot focus and selection, content at a 48rem measure on the header gutters.

- **Narrow (under 640px):** one readable column. Header and intro sit over the painted scene with 20px gutters; the headline and apricot entrance lead, the CRT rests in the meadow lower left, and the hub follows as a front-facing paper window (`calc(100% - 24px)`, max 920px) that overlaps the scene's foot by 72px. The hub sidebar becomes a horizontally scrolling row with edge fades (44px masks) that appear only when there is more to scroll. Mood charts stack one per row so labels stay at 11px or above.
- **Tablet (640-1099px):** 40px gutters; the hub becomes a two-column grid: header, sidebar row, greeting and lede span both columns, then People beside Following, Mood full width, Recent activity beside Explore more (16px column gap).
- **Wide (1100px and up):** the first viewport is the approved comp, a 1505x1045 stage scaled uniformly by window width (aspect ratio fixed, so hub text never shrinks for a short window). Elements are absolutely placed in comp pixels; the hub is laid out flat at 912x665 and projected onto the comp's tilted window with one `matrix3d`. These stage coordinates are a fitting of one composition, not a spacing system.

Text is never scaled down to fit a small screen: below 1100px everything reflows instead.

**Spacing rhythm** (flowing layouts): 4px between sidebar items, 8px and 14px inside panels and lists (14px is also the standard column gap beside icons and tiles), 16px between panels, 20px and 40px page gutters. Footer padding is 40px top and 48px bottom with `max(20px, 6.25vw)` sides. List rows hold a steady 52px height for people and platforms.

## Elevation & Depth

Hybrid: depth comes mainly from layered translucent paper over a grain texture, with a few soft, long, low-opacity ambient shadows. Nothing is hard-edged or offset.

### Shadow Vocabulary
- **Window lift** (`box-shadow: 0 40px 80px -36px rgb(8 10 30 / 0.6), inset 0 1px 0 rgb(255 255 255 / 0.7)`): the hub window only; a deep, diffuse night shadow plus a lit top edge.
- **Entrance glow** (`box-shadow: 0 10px 24px -14px rgb(20 16 40 / 0.6)`): the apricot entrance, lifting it off the scene.
- **Paper whisper** (`box-shadow: 0 1px 2px rgb(120 90 60 / 0.08)`; 0.12 on the label chip): panels and the Simulated data label.
- **Toggle well** (`box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.3)`): the recessed toggle track; its pressed knob gets `0 0 0 1px rgb(150 120 90 / 0.45), 0 1px 3px rgb(0 0 0 / 0.3)`.
- **Cream rings** (`box-shadow: 0 0 0 2px #fbf3e8` on avatars; 1.5px `#fbf2e6` on chart points): separation rings, not elevation.

### Named Rules
**The Layered Paper Rule.** Inside the hub, depth is translucency, not shadow: an inset surface with a warm left-to-cool-right light gradient, then panels at 80-85% cream over the grain. A new panel takes the paper whisper, never the window lift.

**The Bounded Dusk Rule.** The scene's time of day changes only through the explicit toggle: a night veil cross-fades over 2.4s (`cubic-bezier(0.22, 1, 0.36, 1)`) and the lights brighten. Fireflies animate transform and opacity only, pause when the scene is offscreen, and under `prefers-reduced-motion` hold a still 0.55 glow with no transitions.

## Shapes

Soft, nested rounding. Interactive controls on the scene and in the hub header are full pills (999px). Containers step down as they nest: window 22px, inner surface 15px, panels 12px, explore rows and their tiles 10px, sidebar items 9px, rows and activity tiles 8px, focus ring corners 6px. Avatars, presence dots, chart points and fireflies are circles. Borders are 1px hairlines in warm rule tones; the sign-in outline is the one heavier stroke (1.5px, 2px on the stage). Icons are inline SVG on a 24-unit grid with round caps and joins (1.6 stroke, 2 to 2.2 in the sidebar); a few take a solid fill (sun disc, moon, People and Mood glyphs) or a light fill (the Following heart).

## Components

### Buttons
- **Shape:** full pill (`rounded.pill`).
- **Primary (entrance):** apricot fill, entrance-ink text at 20px, 58px tall, a right arrow 16px after the label; entrance glow shadow. One per view.
- **Hover / Focus:** fill lightens to lit apricot and the arrow slides 3px right (0.2s ease). Focus is a 2px apricot ring at 3px offset.
- **Ghost (sign in / your hub):** ivory text in a 1.5px ivory-85% outline pill, 44px tall; hover adds a 12% ivory wash. Separated from the nav by a 1px ivory-35% vertical rule.

### Chips
- **Simulated data label:** label-chip fill, label-chip edge border, pill, 32px tall, 14px text with an info icon; paper whisper shadow. A label, not a control: its full meaning is carried in screen-reader text. Any surface showing demo data carries it visibly.

### Cards / Containers
- **Hub window:** greige paper with a tiled 256px grain plate, 22px corners, window lift shadow, and an inset 7px surface (15px corners, 1px border `rgb(150 118 92 / 0.26)`) carrying the warm-left light gradient.
- **Panel:** panel wash fill, 1px `#e5d4c3` border, 12px corners, 14px padding, paper whisper. Title top left; an optional muted aside (link or note) top right, 11.5px.
- **Lists inside panels:** rows divided by 1px rule hairlines, no zebra fills.

### Navigation
- **Site nav (shared public header):** one header on every public page (home, demo, agent office): the wordmark, then Home, Demo and Agent office as ivory 17px links, then the ghost account pill. The current page carries a 2px current-colour underline at 85% opacity below the text (`aria-current="page"`); hover goes to pure white. On home it sits on the scene (stage-placed from 1100px); on demo and agent office it sits on dusk navy with the same gutters as the home stage (`max(40px, 6.25vw)` from 1100px). Phones get one compact row of links under the wordmark, never a menu, sized to fit 320px. The day/night toggle stays on home only.
- **Account pill:** pages render "Sign in" statically; after load the browser asks the Auth.js session endpoint and a signed-in visitor sees "Your hub" (to the owner hub) in the same pill. Both labels share one cell, so the swap changes no width.
- **Hub sidebar:** 38px items with icon and 13px label, 9px corners; current item honey-select, hover 45% honey. Vertical column with a lower group (Agent office, Settings) under a rule on the stage; a scrolling row with edge fades below 1100px, focus rings drawn inside the mask.
- **Footer:** dusk navy, ivory text, links underlined in 50% apricot that strengthens to full apricot on hover.

### Day/Night Toggle (signature)
A real two-button group ("Scene light") in the hub header: a slate pill track with a recessed inset shadow, two 34px circular buttons with sun and moon glyphs. The pressed option fills `#f6e0bf` with dark ink; the other stays light ink on slate. Transitions 0.4s, removed under reduced motion.

### Mood Chart (signature)
An SVG plot stretched to its box (non-scaling 2px line, 1px grid at 0, 0.5 and 1) with a monotone cubic line that never overshoots, an area wash fading from 30% ink to 0 at the baseline, 6px points with a cream ring, and HTML axis labels in the figure stack that never scale with the chart. Alternate days are labelled; every day keeps its point. The whole chart is one `role="img"` with its values in the accessible label.

### Explore Row
A bordered cream row (10px corners) with a 38px gradient tile (`#f9e2bf` to `#f6e7d3`), a name and a muted one-line description, and a trailing arrow (or external mark for another surface). Hover lifts the fill toward `rgb(255 248 236 / 0.9)` and darkens the border to `#d9bfa3`.

### Activity Row
A 32px periwinkle tile with an icon, a 12.8px title and an 11px figure-stack timestamp, rows separated by rule hairlines.

## Do's and Don'ts

### Do:
- **Do** put all product UI (names, numbers, charts, lists) on the paper hub; keep only the wordmark, nav, headline, entrance and footer on the scene or navy.
- **Do** set every letter in Rosarivo 400 and every data numeral in the PT Serif figure stack with lining, tabular numbers.
- **Do** keep apricot to one filled control per view, and use the bark focus ring on paper and the apricot ring on the scene.
- **Do** reflow below 1100px instead of scaling text down; keep chart labels at 11px or more on phones.
- **Do** make painted elements authored rasters with embedded provenance, and build every control, label and chart as semantic DOM or inline SVG.
- **Do** keep scene motion behind an explicit control, bounded in duration, paused offscreen and still under reduced motion.
- **Do** show the Simulated data label wherever demo data appears.

### Don't:
- **Don't** introduce a second font weight, bold emphasis, or a second letter face.
- **Don't** use meadow green or ember coral outside data marks.
- **Don't** put text, UI or numbers inside a raster plate; plates carry only scenery, objects, portraits and grain.
- **Don't** give panels the window's deep shadow; inside the hub, depth is layered paper.
- **Don't** copy artwork from the reference video; the scene must stay original.
- **Don't** treat the 1100px stage's absolute comp coordinates as spacing tokens for new surfaces.

## Local integration status — 2026-10-25

The owner-accepted landscape is now native 2560×1776 and integrated byte-identically, served with Next Image optimization through the existing image route. The scenery remains an original dusk lake, meadow, mountains and fireflies; the CRT is a separate plate. Locally measured WebP responses are 381,460 bytes for desktop and 54,750 bytes for phone. Other plates retain their existing formats. This integration is prepared for draft review; no merge or deployment has occurred.

Recent activity now displays three real sanitized public events instead of fictional samples. The office entrance is “View agent activity.” A shared five-second feed poll retains at most 100 events. The text office first shows history, then quietly replays up to the last 20 events with a Replay label, original timestamps and the actual count. New arrivals take priority; pause/resume/next remain explicit, reduced motion uses manual stepping, and hidden/offscreen views pause. The accessible list remains available. Empty feeds stay empty. A separate local fictional office preview now explores the approved pixel scene; full-team real-feed integration remains future work.

## Open items

1. **Formal finish remains open:** the native landscape passes its resolution plate check, and 16 local viewport/light/motion checks passed. Responsive/finish still report existing explore-title fidelity (58%) and navigation advisories. No forced pass or fabricated receipt was used; the older receipt file could not be verified. Do not claim current receipt validity or a completed engine ship record.
2. **Verification:** combined focused web/scripts tests (93), lint/typecheck and the full production OpenNext build passed independently. The full dev-server browser run passed 29/31, including all activity tests; both console controls that timed out there passed targeted production-preview isolation (2/2 in 50.4 seconds, installed Chrome, one worker, `PW_SERVER=start`) without a form source fix. The full 31-test production suite was not rerun; the final full Vitest suite independently passed 66 files/1,105 tests in 123.03 seconds outside the sandbox for fixture subprocess/loopback access. The earlier asset run was 23/25; do not confuse it with the combined result. Firefox/Safari and real devices remain unverified.
3. **Copy:** fictional activity samples and “See and manage your AI agents” have been replaced locally by real sanitized events and “View agent activity.” The greeting subline about a world powered by agents remains trial copy under Simulated data; review remaining agent claims before launch.
4. **Visual advisories:** prior seam/paper/quill/night-paper observations and current title/navigation fidelity are review items, not new visual-system rules. The local sample artwork is documented below; full-team real-feed mapping remains future work, with the existing replay as its text-feed foundation.

## Office preview — scoped visual extension

This local `/office/preview` surface extends the existing public world with an original overhead woodland studio. Navy, ivory, apricot and Rosarivo remain the surrounding interface; the coarse pixel room is a route-specific medium. The paper-window, painted-raster and soft-corner guidance above continues to describe the incumbent home/demo, rather than imposing that medium on the pixel room.

The native Canvas 2D scene is 320×256, with a 16×16 tile vocabulary and approximately 16×24 robot bodies. Integer rectangle fills, disabled image smoothing and pixelated display preserve actual coarse pixels. The room displays at 2× where available, 1× on phones with room, and fits narrower widths without page overflow. It ships code-drawn scenery, with no raster scene asset. Furniture and robots are distinct layers, with robots ordered by their vertical position. All readable text and controls remain HTML.

The palette in `draw-office.ts` declares 20 colors: honey wood and seams, sage walls and foliage, cream/paper, teal Developer, amber QA, dusk windows, navy and a failure red. The Liaison measured 19 rendered colors in the initial task-assigned frame; failure states use the twentieth color. This is a frame measurement, not a claim that every state uses 19 colors. The `office-*` color tokens above are intentional scoped interface shades and role swatches extracted from `preview.module.css`, not a replacement global palette.

The scoped type steps are office-label, office-state, office-role and office-heading. The heading reaches 44px on desktop and uses 30px on phones. Pill playback/role buttons and the rounded story selector accompany 44px robot/workstation targets with office-target corners and visible apricot focus. Apricot identifies the selected role here. This local selection treatment and the compact target corners are scoped exceptions to the homepage entrance and soft-panel vocabulary.

Controls precede the room. The inspector sits beside it from 1200px and below it on narrower screens. The route's container is capped at 1280px; readable prose retains a 65–70ch measure. The compact phone toolbar keeps the room and role controls in the first viewport. Labels explicitly identify fictional samples; no public-event request is made and `/office` retains its real/replay text feed.

Play/pause/resume, optional next and restart control frame-based pixel movement. Simulation updates are bounded to 1/60 second, so the current paths advance at most one native pixel per rendered update. Reduced motion defaults to a still scene, with an enabled Play animation control that explicitly opts into full autoplay. Scenario changes preserve playback intent; Restart starts fresh autoplay. Hidden tabs and offscreen rooms freeze without catch-up; failure and owner-wait states remain readable. Robot and desk selection works with keyboard and pointer; the inspector, current event and expandable sequence supply the text equivalent. Only a merged event files the papers.

Design-token detection remains advisory for this scoped extension. No detector pass or complete engine ship receipt is implied. Final local mobile review and implementation checks are recorded in the handoff; owner preview acceptance, real-feed integration, merge and deployment remain separate milestones.
