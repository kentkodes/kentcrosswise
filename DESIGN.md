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
- `/demo`, `/office` and `/bot` still use the legacy dusk shell. See [Legacy shell](#legacy-shell).
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
- Rosarivo and PT Serif are not used on the new pages. Rosarivo stays in the legacy shell.

## Layout

- Container: 1120px max width, centred. Used by the header, the footer and the home page.
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

### Feature rows

Three short text blocks under the product still. A 1px `--line` top border, 32px padding above. Title in the Title style. Text in `--fg-muted` at the inherited 16px. Three columns with 32px gaps on desktop. One column with 24px gaps on phones.

### Office target

A 44px square hit area with a 4px radius. Used by the legacy office room. See [Legacy shell](#legacy-shell).

## Page templates

Four templates. Only Marketing is built.

- **Marketing (home). Done.** Hero, product still, three feature rows, footer. Wide rhythm, 96px sections.
- **App frame (`/demo`, `/office`). Planned.** The product still's sidebar and main area, filled with demo data. The log becomes a plain table. Office illustrations sit inside one contained card.
- **Reading (essays, `/bot`). Planned.** Measure of about 680px. Larger body text. A list instead of cards.
- **Dense UI (owner console). Planned.** Tables, status dots, mono timestamps. The smallest type scale. Same tokens.

Do not build a template before its page is redone.

## Legacy shell

`/demo`, `/office` and `/bot` still render inside `PublicShell` (`apps/web/src/app/(public)/_site/public-shell.tsx`). They keep the old dusk look until they are redone.

The shell is styled in `public-shell.module.css`:

- Ground `#1b2340` and text `#f6f1e4` (legacy-dusk-navy, legacy-ivory). The shell sets `color-scheme: dark`, so it does not follow the system setting.
- Body text is Rosarivo 400 through `--font-rosarivo`, with Georgia and serif as fallbacks. Headings are not bold.
- Selection: `#f8d9a8` background with `#120e0b` text.
- Focus: 2px `#f8d9a8` outline, offset 3px, 6px radius.
- Content measure: 48rem plus gutters. Gutters are 20px under 640px, 40px from 640px, and `max(40px, 6.25vw)` from 1100px.
- The shell sets the header variables to ivory on navy: `--header-fg` `#f6f1e4`, `--header-muted` `rgb(246 241 228 / 0.65)`, `--header-line` `rgb(246 241 228 / 0.18)`, `--header-bg` `#1b2340`. The shared header and footer read these, so the account button is an ivory pill with navy text here.

The office pages use these values in addition to the shell:

- `office/office.module.css` (live `/office`): `#dfd7c6` for explanatory text (`office-text`). Ivory alpha lines and button borders: `rgb(246 241 228 / 0.2)`, `0.3`, `0.6`, and button hover `0.12`. Event times use Rosarivo with lining, tabular figures.
- `office/preview/preview.module.css` (imported by live `/office` and by the sub-routes): the office palette `office-control`, `office-control-edge`, `office-muted`, `office-hover`, `office-divider`, `office-teal`, `office-amber`, `office-ink`, plus apricot for selection and focus. Robot and desk targets are 44px with 4px radius.
- The sub-routes `/office/preview`, `/office/draft` and `/office/connected` are `noindex`. They use the same shell and palette. Their own CSS is in their folders.
- The room canvas colours are set in code in `office/preview/draw-office.ts` and `office/draft/draw-office.ts`. They are not listed here.
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
