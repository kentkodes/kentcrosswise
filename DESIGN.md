---
# Visual system only. The repository's architecture and task design live in docs/DESIGN.md.
name: Kentcrosswise
description: Paper. White and ink neutrals, one blue accent for links and focus, Geist type, hairline borders over shadows, automatic dark mode.
colors:
  bg: "#ffffff"
  bg-dark: "#0a0a0b"
  bg-soft: "#f7f7f6"
  bg-soft-dark: "#111114"
  line: "#ececea"
  line-dark: "#232328"
  fg: "#0a0a0b"
  fg-dark: "#f2f2f4"
  fg-muted: "#67676f"
  fg-muted-dark: "#8e8e96"
  accent: "#2f5bea"
  accent-dark: "#8aa6ff"
  btn-bg: "#0a0a0b"
  btn-bg-dark: "#f2f2f4"
  btn-fg: "#ffffff"
  btn-fg-dark: "#0a0a0b"
  legacy-dusk-navy: "#1b2340"
  legacy-ivory: "#f6f1e4"
  legacy-apricot: "#f8d9a8"
  legacy-selection-ink: "#120e0b"
  office-control: "#252e49"
  office-control-edge: "#aaa28f"
  office-muted: "#e5d8bf"
  office-text: "#dfd7c6"
  office-hover: "#3d465e"
  office-divider: "#847d78"
  office-teal: "#67baa6"
  office-amber: "#e4ad55"
  office-ink: "#232a46"
typography:
  display:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "clamp(40px, 6vw, 64px)"
    fontWeight: 600
    lineHeight: 1.04
    letterSpacing: "-0.035em"
  subline:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.55
  title:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.01em"
  greeting:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
  small:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  button:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: 1
  wordmark:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.02em"
  mono:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
  mono-label:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "11px"
    fontWeight: 400
    letterSpacing: "0.06em"
  legacy-body:
    fontFamily: "Rosarivo, Georgia, serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  control: "8px"
  card: "10px"
  frame: "12px"
  item: "6px"
  office-target: "4px"
  pill: "999px"
spacing:
  grid: "4px"
  container: "1120px"
  gutter: "24px"
  gutter-phone: "16px"
  header-height: "60px"
  section: "96px"
  section-phone: "64px"
components:
  button-primary:
    backgroundColor: "{colors.btn-bg}"
    textColor: "{colors.btn-fg}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "40px"
  button-secondary:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.fg}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "40px"
  button-account:
    backgroundColor: "{colors.btn-bg}"
    textColor: "{colors.btn-fg}"
    typography: "{typography.small}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "36px"
  header:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.fg}"
    height: "{spacing.header-height}"
  footer:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.fg-muted}"
    typography: "{typography.small}"
  product-still:
    backgroundColor: "{colors.bg}"
    rounded: "{rounded.frame}"
  card:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.fg}"
    rounded: "{rounded.card}"
    padding: "14px"
  activity-row:
    textColor: "{colors.fg-muted}"
    typography: "{typography.mono}"
    padding: "8px 12px"
  status-pill:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.fg-muted}"
    typography: "{typography.small}"
    rounded: "{rounded.pill}"
    padding: "4px 10px"
  agent-card:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.fg}"
    rounded: "{rounded.card}"
    padding: "16px"
  seat-tile:
    textColor: "{colors.fg}"
    typography: "{typography.small}"
    rounded: "{rounded.control}"
    padding: "8px 10px"
  activity-list:
    backgroundColor: "{colors.bg}"
    rounded: "{rounded.card}"
  segmented-tabs:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.fg-muted}"
    rounded: "{rounded.control}"
  room-card:
    backgroundColor: "{colors.legacy-dusk-navy}"
    textColor: "{colors.legacy-ivory}"
    typography: "{typography.legacy-body}"
    rounded: "{rounded.frame}"
    padding: "16px"
  office-target:
    rounded: "{rounded.office-target}"
    width: "44px"
    height: "44px"
  legacy-shell:
    backgroundColor: "{colors.legacy-dusk-navy}"
    textColor: "{colors.legacy-ivory}"
    typography: "{typography.legacy-body}"
---

Visual system for the Kentcrosswise public surfaces; the architectural design doc is `docs/DESIGN.md`, which this file does not replace.

# Design System: Kentcrosswise

## Overview

Paper is the visual system for the public pages. It is plain and calm. A white page holds black type. One blue accent marks focus. Hairline borders separate content, and shadows are used once. Text is set in Geist, with Geist Mono for timestamps and labels. Dark mode follows the operating system setting. The page has no control for it.

Status:

- The home page, the shared header and the shared footer use Paper.
- `/office` uses Paper with the App frame board (Board tab). Its Room tab is the one scoped legacy-navy block. See [Room card](#room-card) and [Legacy shell](#legacy-shell).
- `/demo` uses the Paper app frame. See [Demo app frame](#demo-app-frame).
- `/bot` still uses the legacy dusk shell. See [Legacy shell](#legacy-shell).
- Other pages are not covered yet. See [Page templates](#page-templates).

Principles:

- Smooth and professional beats clever.
- Shadows only on the home product still.
- Motion is short and plays once. Nothing loops.

## Colors

The tokens are CSS custom properties on `:root` in `apps/web/src/app/globals.css`. Dark values sit under `@media (prefers-color-scheme: dark)`. The values match the frontmatter.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#ffffff` | `#0a0a0b` | Page ground. The header uses it at 80% with a blur. |
| `--bg-soft` | `#f7f7f6` | `#111114` | Product still sidebar. |
| `--line` | `#ececea` | `#232328` | Hairline borders and dividers. |
| `--fg` | `#0a0a0b` | `#f2f2f4` | Text and headings. Current nav link. |
| `--fg-muted` | `#67676f` | `#8e8e96` | Secondary text, nav and footer links, sub-line, card notes. |
| `--accent` | `#2f5bea` | `#8aa6ff` | Focus outline. Also the activity dot (see Activity row). |
| `--btn-bg` | `#0a0a0b` | `#f2f2f4` | Primary button fill. |
| `--btn-fg` | `#ffffff` | `#0a0a0b` | Primary button text. |

Rules:

- Accent is for focus. Do not add it to new elements.
- Header and footer links are `--fg-muted`, not accent.
- New public CSS reads these tokens. It does not use literal colours.

The legacy shell and its office palette are listed in the frontmatter and in [Legacy shell](#legacy-shell).

## Typography

Geist and Geist Mono load through `next/font/google` in `apps/web/src/app/(public)/_site/fonts.ts`. They are exposed as `--font-sans` and `--font-mono`. The fonts are self-hosted at build time, so the page makes no runtime request to Google. The CSS uses weights 400, 500 and 600.

| Style | Size | Weight | Line height | Tracking | Used for |
|---|---|---|---|---|---|
| Display | `clamp(40px, 6vw, 64px)` | 600 | 1.04 | -0.035em | Home headline |
| Sub-line | 18px | 400 | 1.55 | | Home sub-line, max 560px |
| Title | 17px | 600 | 1.4 | -0.01em | Feature row titles |
| Greeting | 20px | 600 | | -0.02em | Product still greeting |
| Body | 16px | 400 | 1.6 | | Home page default |
| Small | 14px | 400 | 1.6 | | Header and footer text, feature text |
| Button | 15px (header account: 14px) | 500 | 1 | | Buttons |
| Wordmark | 16px | 600 | 1 | -0.02em | Header and footer |
| Card value | 14px | 500 | 1.4 | | Product still card values |
| Mono | 12px | 400 | | | Log times, product still labels |
| Mono label | 11px, uppercase | 400 | | 0.06em | Product still card labels |

Rules:

- Geist for text. Geist Mono only for timestamps and labels.
- Hierarchy comes from size and weight. Do not add a third weight.
- Rosarivo and PT Serif are not used on the new pages. Rosarivo stays in the legacy shell and in the Room card.

## Layout

- Container: 1120px max width, centred. Used by the header, the footer, the home page and `/office`.
- Gutters: 24px on each side, 16px under 640px. The header, the home page and the footer use the same gutters at every width.
- Breakpoint: 640px. Phone rules apply below it.
- Spacing: 4px grid, with these exceptions in the code: 2px (gap between product still sidebar items), 6px (sidebar item padding, card gap, gap before the agent name in the log), 10px (sidebar side padding), 14px (card padding and sidebar padding).
- Home page vertical rhythm: hero 96px top and 64px bottom. Feature rows 96px above and below. On phones: hero 56px top and 40px bottom, features 64px above and below.
- Home page order: header, hero, product still, three feature rows, footer.
- Hero is left aligned. Feature rows are three columns on desktop and one column on phones.

## Elevation & Depth

Hairlines do the work. Borders are 1px `--line` on the header bottom, the footer top, the feature row top, the product still frame, cards and the activity log. The secondary button uses a stronger outline (see Buttons).

There is one shadow in the code:

- Product still frame: `0 1px 2px rgb(0 0 0 / 0.04), 0 12px 40px -12px rgb(0 0 0 / 0.12)`. The same value applies in dark mode.

Two other effects are not shadows:

- The selected sidebar item uses a 1px `--line` ring (`box-shadow: 0 0 0 1px`).
- The header background is 80% `--bg` with a 12px backdrop blur.

Do not add shadows to other components.

## Shapes

Radius tokens:

- `control` 8px: buttons.
- `card` 10px: cards and the activity log.
- `frame` 12px: the product still frame.
- `item` 6px: sidebar items in the product still. This value is in the code but not in the Paper spec.

Legacy radii: `office-target` 4px for room targets, `pill` 999px for office buttons. See [Legacy shell](#legacy-shell).

The home page CSS uses no icons and no avatars.

## Components

### Buttons

- **Primary.** Fill `--btn-bg`, text `--btn-fg`, 40px tall, 0 16px padding, 15px, weight 500, radius 8px. Hover drops opacity to 0.86 over 150ms. Used once per view: "Explore the demo" on the home hero.
- **Secondary.** Fill `--bg`, text `--fg`, same size. 1px outline `color-mix(in srgb, var(--fg) 22%, transparent)`, 40% on hover, so it reads as a boundary in both themes. Used for "Agent office" on the home hero.
- **Account button (header).** Primary style at 36px tall, 14px, weight 500. A pseudo-element extends its hit area to 44px.

Focus on every button: 2px solid `--accent` outline, offset 2px. The rule uses low specificity (`:where`) so the legacy shell's own focus ring can override it.

Hover transitions take 150ms with `--ease-out`. Under `prefers-reduced-motion: reduce` they are off.

### Header

Shared header in `apps/web/src/app/(public)/_site/site-header.module.css`.

- Sticky at the top, z-index 10. A 60px row, centred in the 1120px container.
- Wordmark on the left. Links on the right: Home, Demo, Agent office, then the account button.
- Background `--bg` at 80% with a 12px backdrop blur. A 1px `--line` bottom border always shows.
- Links are 14px `--fg-muted`. Hover and the current page (`aria-current`) use `--fg`. The current link is weight 500. There is no underline bar.
- Phone (under 640px): two rows. The wordmark sits on its own row. The four links take the full width below it, space-between with at least 16px between them, 14px text, 44px tap targets. One row does not fit at 320px.

Colours come from local variables: `--header-fg`, `--header-muted`, `--header-line` and `--header-bg`. Each reads its global token as a fallback. The legacy shell sets its own values.

### Footer

Shared footer in `apps/web/src/app/(public)/_site/site-footer.module.css`.

- 1px `--line` top border. Text 14px, `--fg-muted`, line height 1.6.
- Wordmark (16px, 600), then the note: "A personal hub built with a small team of AI agents. Everything in the demo is simulated. The people, moods and numbers are generated examples."
- Links: Demo, Agent office, Bot. Each is 44px tall. Hover uses `--fg`.
- Padding 32px top, 40px bottom, 24px sides (16px under 640px). From 640px the wordmark and note share a row, and the links take the next row.

### Product still

The static picture of the hub on the home page. Styles are in `apps/web/src/app/(public)/_home/home.module.css`.

- Frame: a two-column grid, 170px sidebar and content. Minimum height 300px. 1px `--line` border, 12px radius, hidden overflow, the only shadow in the system.
- Sidebar: `--bg-soft` background, 13px text, items with 6px 8px padding and 6px radius. The current item has a `--bg` fill and a 1px `--line` ring, and `--fg` text. Other items use `--fg-muted`.
- Content: 20px padding. A greeting (20px, 600), then a mono label (12px). Three cards in a row with 12px gaps.
- Cards: see [Cards](#cards).
- Activity log: see [Activity row](#activity-row).
- Entrance: the frame rises 6px and fades in over 300ms, once.
- Only the live activity list changes. Everything else is static.
- Phone: the sidebar is hidden, the content has 16px padding, and the cards stack in one column.

### Demo app frame

The `/demo` page (`apps/web/src/app/(public)/demo/`) is the product still's app frame filled with demo data. Styles are in `demo/demo.module.css`.

- Frame: 1px `--line` border, 12px radius, hidden overflow. A 200px sidebar of tabs on `--bg-soft` beside the section. On phones the tabs become one horizontally scrollable row above it, so the page never scrolls sideways at 320px.
- Tabs: Today, People, Mood, Following, Notes. Real `<button aria-pressed>` in a `Hub sections` nav. The selected tab has a `--bg` fill and a 1px `--line` ring. Tabs switch in place, with no URL change.
- Data: `buildDemoView()` in `demo/demo-view.ts` turns `@kcw/demo-data` into a serializable view model. The server page builds it; the client component (`demo/demo-app.tsx`) holds only the selected tab.
- Sparkline: shared with the home product still through `_site/sparkline.ts`.
- Footnote: the home page's live activity is real; everything inside the frame is generated.

### Cards

- 1px `--line` border, 10px radius, 14px padding, no fill. Content stacks with a 6px gap.
- Label: Geist Mono 11px, uppercase, 0.06em tracking, `--fg-muted`.
- Value: 14px, weight 500, line height 1.4.
- Note: 12px, `--fg-muted`.
- Sparkline: 160 by 36px, drawn 1:1. The seven points are scaled to the week's own range with 15% padding. `--fg` stroke and a 2.5px end dot.

### Activity row

Rows in the live activity log, inside a 1px `--line` border with a 10px radius and hidden overflow.

- Row: flex, no wrap, 16px gap, 8px 12px padding. A 1px `--line` top border, none on the first row.
- Time: Geist Mono 12px, `--fg-muted`.
- Agent name: 96px wide, weight 500, capitalised. A 6px dot in front, filled with `--accent`. This is the one place accent is used outside focus.
- Title: `--fg-muted`, single line with an ellipsis.
- Phone: the title moves to its own line under the time and agent.

### Status pill

Summary pills above the board on `/office`, in `apps/web/src/app/(public)/office/board/board.module.css`.

- Pill: 1px `--line` border, 999px radius, 4px 10px padding, 13px text in `--fg-muted`. A count is set in `--fg`, weight 500.
- Dot: 7px circle. `ok` is `--ok` (green), `warn` is `--warn` (amber), `idle` is `--idle` (grey). Tones are colour only; the words carry the meaning.
- Shown: System (Paused, Working or Idle), the in-flight task count when above zero, and the feed (Updates delayed, Feed unavailable). Nothing is shown when the feed is fresh.

### Agent card

One card per agent on the Board tab: Orchestrator, Developer, QA, Docs-keeper and Scraper-builder. Developer is wider and holds the seat tiles.

- Card: 1px `--line` border, 10px radius, 16px padding, 10px gap, no fill and no shadow. Three columns on desktop, one below a 720px container width.
- Head: the title at 15px, weight 600, with a status dot. The model tag sits on the right: Geist Mono 11.5px in a 1px `--line` box with a 6px radius.
- Now line: a mono label (Now, Waiting on …, or Last) and the task text. The text is "Private task" for a private task, never its title.
- Footer: a 1px `--line` top border and "Last event" with a relative time. The time is a `<time>` with the absolute UTC value in its title.

### Seat tile

The four Developer seats inside the Developer card. Seat 1 to Seat 4.

- Tile: 1px `--line` border, 8px radius, 8px 10px padding, 13px text. Two per row, four per row at 720px container width or more, one column on a phone.
- Head: a dot and "Seat n". An idle seat shows only "Idle" with no text line.
- An annex line in the card footer appears only when at least one extra worker is running.

### Activity list

The Activity list under the cards on `/office`. It is a bordered region with a title bar.

- Region: 1px `--line` border, 10px radius, hidden overflow. The title bar has a 1px `--line` bottom border and holds the title and the filter chips.
- Title: 14px, weight 600. "Activity" when the list is live, "Activity · replay" when it shows recorded events. A replay list has a note: "Latest recorded events with their original times."
- Row: four columns on desktop (time, role, event, task), 12px gap, 9px 12px padding, a 1px `--line` top border on each row but the first. On a phone, time and role share a line and the event and task sit below. Long text wraps (`overflow-wrap: anywhere`).
- Time: Geist Mono 12px in `--fg-muted`, as "Nov 11, 15:42 UTC".
- Role: weight 500 with a 6px `--fg-muted` dot. Accent is not used here.
- Withdrawn event: an italic `--fg-muted` line with no role.
- Filter chips: All, Orchestrator, Developer, QA, Docs, Scraper. A 32px-tall text button with a 6px radius. The selected chip (`aria-pressed="true"`) has a 1px `--line` border and a `--bg-soft` fill with `--fg` text. The filter applies before the list is capped at 50 rows.
- States: loading, empty, unavailable and "no events for this filter" each show one short `--fg-muted` line. An unavailable feed that still has rows keeps them and adds the note "Showing the last events received. Updates will retry."

### Segmented tabs

The Board | Room control at the top right of `/office`. It is a tablist.

- Track: 1px `--line` border, 8px radius, 2px padding and gap.
- Tab: 36px tall, 14px, weight 500, `--fg-muted`, 6px radius. Hover uses `--fg`.
- Selected tab: `--fg` text, 1px `--line` border and a `--bg-soft` fill.
- Keyboard: Left and Right arrows move between tabs and wrap at the ends. Only the selected tab is in the tab order.
- Colour and motion transitions take 150ms and are off under reduced motion.

### Room card

The Room tab holds the connected office room (`office/connected/connected-office.tsx`) in one card.

- Frame: 1px `--line` border, 12px radius, hidden overflow.
- Scope: a block with `#1b2340` ground, `#f6f1e4` text, the Rosarivo variable and 16px padding. This is the one scoped legacy-navy block on a Paper page.
- Why: the room's own CSS (`connected.module.css`) was written for the navy shell, and it is accepted as the visual baseline. Restyling it to Paper is a later task. The scope keeps the room looking as it did, and no other part of `/office` uses navy. Remove the scope when the room is redone.

### Feature rows

Three short text blocks under the product still. A 1px `--line` top border, 32px padding above. Title in the Title style. Text in `--fg-muted` at the inherited 16px. Three columns with 32px gaps on desktop. One column with 24px gaps on phones.

### Office target

A 44px square hit area with a 4px radius. Used by the legacy office room. See [Legacy shell](#legacy-shell).

## Page templates

Four templates. Marketing and App frame are partly built.

- **Marketing (home). Done.** Hero, product still, three feature rows, footer. Wide rhythm, 96px sections.
- **App frame (`/office`). Built.** The Paper frame with a page heading, the Board | Room segmented tabs, status pills, agent cards, seat tiles and the filterable activity list. The Room tab is the one scoped legacy-navy block (see [Room card](#room-card)).
- **App frame (`/demo`). Built.** The product still's sidebar and main area, filled with demo data. Tabs, a plain table for people, and bars for mood. See [Demo app frame](#demo-app-frame).
- **Reading (essays, `/bot`). Planned.** Measure of about 680px. Larger body text. A list instead of cards.
- **Dense UI (owner console). Planned.** Tables, status dots, mono timestamps. The smallest type scale. Same tokens.

Do not build a template before its page is redone.

## Legacy shell

`/bot` still renders inside `PublicShell` (`apps/web/src/app/(public)/_site/public-shell.tsx`) and keeps the old dusk look until it is redone. `/demo` left the shell for the Paper app frame (see [Demo app frame](#demo-app-frame)). `/office` left the shell: it renders in the Paper frame, and only its Room card keeps the navy look (see below).

The shell is styled in `public-shell.module.css`:

- Ground `#1b2340` and text `#f6f1e4` (legacy-dusk-navy, legacy-ivory). The shell sets `color-scheme: dark`, so it does not follow the system setting.
- Body text is Rosarivo 400 through `--font-rosarivo`, with Georgia and serif as fallbacks. Headings are not bold.
- Selection: `#f8d9a8` background with `#120e0b` text.
- Focus: 2px `#f8d9a8` outline, offset 3px, 6px radius.
- Content measure: 48rem plus gutters. Gutters are 20px under 640px, 40px from 640px, and `max(40px, 6.25vw)` from 1100px.
- The shell sets the header variables to ivory on navy: `--header-fg` `#f6f1e4`, `--header-muted` `rgb(246 241 228 / 0.65)`, `--header-line` `rgb(246 241 228 / 0.18)`, `--header-bg` `#1b2340`. The shared header and footer read these, so the account button is an ivory pill with navy text here.

The office room is the one legacy block left on `/office`:

- The Room card's scope (`office/board/room-panel.module.css`) sets `#1b2340` ground and `#f6f1e4` text around the connected room, and the Rosarivo variable. See [Room card](#room-card).
- `office/connected/connected.module.css` (the room itself) uses the office palette literals: `#252e49`, `#232a46`, `#293d47` and `#3d465e` for surfaces, `#f8d9a8` apricot for selection and focus, `#e5d8bf` and `#d4c7b4` for text, and `#847d78`, `#756f69` and `#aaa28f` for lines. Event times use Rosarivo with lining, tabular figures.
- The room canvas colours are set in code in `office/draft/draw-office.ts`. They are not listed here.
- `bot/bot.module.css`: `#d9d6cd` for the status and note text, apricot `#f8d9a8` for the report link, and ivory `#f6f1e4` on hover.

When a page is redone, remove its literal values and its use of the shell. Do not extend the legacy palette to new pages.

## Do's and Don'ts

### Do

- **Do** read colours, radii and motion from the tokens in `globals.css`.
- **Do** keep one primary button in each view.
- **Do** separate content with 1px `--line` borders.
- **Do** keep motion to 150ms hover and 300ms enter, and turn it off under reduced motion.
- **Do** keep the simulated-data note in the footer.
- **Do** use a 4px grid for new spacing.

### Don't

- **Don't** add shadows except to the product still.
- **Don't** use accent for anything but focus. The activity dot is the one existing exception.
- **Don't** add looping or ambient animation, parallax or scroll effects.
- **Don't** use Rosarivo or PT Serif on new pages.
- **Don't** put literal colours in new components.
- **Don't** extend the legacy dusk palette to new pages.
