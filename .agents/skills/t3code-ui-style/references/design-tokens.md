# Design Tokens: Colors, Surfaces, Glass & Grain

Extracted from `t3code` (`apps/web/src/index.css` and `packages/shared/src/themePalettes.ts`) and mapped onto Harness Deck's token architecture (`packages/webview-ui/src/styles/beautifului-foundation.css`).

## 1. Core Default Palettes (Light & Dark)

### Light Theme — "Quiet Zinc"

| Role | T3 Code Value | Visual Purpose | Harness Deck Token |
| --- | --- | --- | --- |
| Canvas / Chrome / Toolbar | `#fcfcfc` (`zinc-25`) | Ultra-clean off-white page backdrop | `--canvas` / `--page` |
| Sidebar | `#fafafa` (`zinc-50`) | One subtle step cooler than canvas; row hover `#fcfcfc`, selected `#ffffff` | `--inset` / `--sidebar` |
| Card / Surface / Popover | `#ffffff` | Crisp white elevated cards, composer, and menus | `--surface` / `--card` / `--popover` |
| Ink Primary | `#27272a` (`zinc-800/900`) | High-legibility charcoal prose (avoids harsh `#000`) | `--ink` / `--foreground` |
| Ink Muted / Secondary | `#71717b` (`zinc-500`) | Metadata, timestamps, secondary labels | `--ink-2` / `--muted-foreground` |
| Border (Hairline) | `#e4e4e7` (`zinc-200`) | Subtle 1px structural dividers | `--line` / `--border` |
| Input Border | `#d4d4d8` (`zinc-300`) | Slightly stronger edge on interactive inputs | `--line-strong` / `--input` |
| Primary / Focus / Action | `#1b4ed8` (`oklch(0.488 0.217 264)`) | Royal blue CTA, send button, focus rings | `--accent` / `--brand` / `--ring` |
| User Message Bubble | `#f4f4f5` (`zinc-100` / `200` mix) | One step past accent-surface so user turns stand off canvas | `--field` / `--accent-tint` |
| Error / Warning / Success / Info | `#fb2c36` / `#fe9a00` / `emerald-500` / `blue-500` | Semantic feedback with `-700` foregrounds and soft tinted surfaces (`8%` mix) | `--red`, `--orange`, `--green`, `--accent` |

### Dark Theme — "Cool Slate + Soft Hairlines"

Harness Deck adapts T3 Code's dark polarity to a softer, layered **cool slate-gray** palette (avoiding harsh `#000000` / `#0a0a0a` OLED black in IDE sidebars) while keeping crisp elevation steps and 1px hairline separation:

| Role | Harness Deck Value | Visual Purpose | Harness Deck Token |
| --- | --- | --- | --- |
| Page Backdrop | `oklch(0.198 0.007 264)` | Deep slate-gray outer backdrop | `--page` |
| Canvas / Chrome / Toolbar | `oklch(0.222 0.008 264)` | Soft dark slate-gray main reading/chat surface (avoids harsh `#000`) | `--canvas` |
| Sidebar / Inset | `oklch(0.238 0.008 265)` | Quiet recessed sidebar & code-block surface | `--inset` / `--sidebar` |
| Card / Raised / Popover | `oklch(0.258 0.01 266)` | Lifts cleanly above canvas for cards, composer, and menus | `--surface` / `--card` / `--popover` |
| Interactive Surfaces | `oklch(0.286 0.01 266)` / `oklch(0.316 0.012 268)` | Subtle slate hover & pressed fills | `--hover` / `--hover-2` |
| Ink Primary | `oklch(0.96 0.004 252)` | Crisp soft off-white without glare | `--ink` / `--foreground` |
| Ink Muted / Secondary | `oklch(0.735 0.01 260)` / `oklch(0.545 0.012 262)` | Metadata, timestamps & inactive sidebar items | `--ink-2` / `--ink-3` / `--muted-foreground` |
| Border / Input | `oklch(0.312 0.01 262)` / `oklch(0.362 0.012 264)` | Soft 1px slate hairlines | `--line` / `--line-strong` |
| Primary / Focus / Action | `#346bf1` (`oklch(0.571 0.21 264)`) | Electric blue CTA & focus ring | `--accent` / `--brand` / `--ring` |
| User Message Bubble / Field | `oklch(0.288 0.01 266)` | Sits one step above `--surface`, matching input/user bubble fills | `--field` |

## 2. Frosted Glass Surfaces (`surface-glass`, `dialog-glass`, `dropdown-glass`)

T3 Code uses translucent frosted glass on floating chrome, attached composer banners, dialogs, and popovers, with automatic solid fallbacks:

```css
:root {
  --glass-blur: 12px;
  --glass-opacity: 80%;
  --glass-saturation: 1.14;
}
.dark {
  --glass-blur: 16px;
  --glass-saturation: 1.08;
}
```

- **Glass panel (`surface-glass`)**:
  `background: color-mix(in srgb, var(--surface) var(--glass-opacity), transparent);`
  `backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation));`
  Fallback via `@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))`: solid `var(--surface)`.
- **Dialog glass (`dialog-glass`)**:
  - Border: `color-mix(in srgb, var(--ink) 10%, transparent)` (light) / `rgb(255 255 255 / 8%)` (dark).
  - Shadow: `0 24px 64px -24px rgb(0 0 0 / 65%)` (light); dark adds top specular edge `inset 0 1px rgb(255 255 255 / 4%), 0 24px 72px -20px rgb(0 0 0 / 90%)`.
- **Dialog backdrop (`dialog-backdrop`)**:
  `background: color-mix(in srgb, var(--canvas) 60%, transparent); backdrop-filter: blur(4px);` (`64%` in dark).
- **Dropdown glass (`dropdown-glass`)**:
  Slightly denser mix (`18%` solid popover + `82%` glass opacity) so menu labels remain crisp over busy code/diffs.

## 3. Specular Edge Highlights & Shadows

Instead of heavy blurred shadows on buttons/inputs, use 1px top/bottom highlights via `before:` / `inset-shadow`:

- **Solid Primary / Destructive Button**:
  - Rest: `inset-shadow-[0_1px_rgb(255_255_255/16%)]` + `shadow-xs`
  - Pressed: `inset-shadow-[0_1px_rgb(0_0_0/8%)] shadow-none`
- **Outline Button / Input Control**:
  - Light rest: `shadow-xs/5` + inner `before:shadow-[0_1px_rgb(0_0_0/4%)]`
  - Dark rest: `bg-input/32` + inner `before:shadow-[0_-1px_rgb(255_255_255/6%)]` (subtle bottom-edge rim light)
- **Composer Elevation**:
  - Light: `0 1px 2px rgb(0 0 0 / 5%)` + `border: rgb(0 0 0 / 8%)`
  - Dark: `0 14px 32px -18px rgb(0 0 0 / 75%)` + `border: rgb(255 255 255 / 5%)` + `inset-shadow` highlight `rgb(255 255 255 / 3%)`

## 4. Micro-Grain Surface Texture (`surface-grain`)

T3 Code applies an ultra-subtle tactile grain directly on `body` and floating chrome surfaces (never as a fixed full-screen overlay, avoiding GPU re-blending on animations):

```css
:root {
  --surface-grain: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.035'/%3E%3C/svg%3E");
  --surface-grain-size: 256px 256px;
}
```
> **IDE Webview CSP Note**: Before using `data:image/svg+xml` in `beautifului-foundation.css`, verify VS Code / JetBrains Webview `img-src` CSP allows `data:`; if `data:` SVG is restricted or undesirable in compact IDE sidebars, omit `surface-grain` and keep pure color + glass surfaces.

## 5. Curated OKLCH Editorial Theme Seeds

T3 Code defines 5 curated OKLCH themes (`T3 Chat`, `Grove`, `Ocean`, `Ember`, `Iris`) for users who want tinted drafting-paper or deep-ink workspaces:

| Theme | Vibe | Light Canvas | Dark Canvas | Light Accent / Action | Dark Accent / Action |
| --- | --- | --- | --- | --- | --- |
| **T3 Chat** | Rose vellum / plum ink | `oklch(0.982 0.010 325.7)` | `oklch(0.228 0.020 307.5)` | `oklch(0.592 0.218 0.6)` | `oklch(0.461 0.185 4.1)` |
| **Grove** | Forest drafting paper | `oklch(0.972 0.005 157.2)` | `oklch(0.261 0.022 162.8)` | `oklch(0.523 0.112 158.1)` / ochre | `oklch(0.796 0.133 157.3)` / ochre |
| **Ocean** | Marine cyanotype | `oklch(0.974 0.003 241.6)` | `oklch(0.243 0.024 250.6)` | `oklch(0.537 0.120 247.0)` / teal | `oklch(0.759 0.106 241.5)` / cyan |
| **Ember** | Warm copper paper | `oklch(0.977 0.003 60.7)` | `oklch(0.246 0.019 42.0)` | `oklch(0.553 0.129 44.7)` | `oklch(0.762 0.124 52.1)` |
| **Iris** | Violet ink | `oklch(0.977 0.004 303.2)` | `oklch(0.226 0.031 293.7)` | `oklch(0.525 0.154 294.2)` | `oklch(0.672 0.169 293.9)` |

## 6. Diff & Semantic Color Discipline

- **Modified file icons** use a muted info blue (`color-mix(in srgb, var(--accent-ink) 50%, var(--ink-2))` light; `65%` mixed with transparent in dark so it does not glow too brightly on dark canvas) so **Added** (green) and **Deleted** (red) lead visually.
- **High-contrast accessibility boost**: T3 Code computes `--contrast-foreground` and `--contrast-border` via `color-mix(in oklab, ...)` toward `--appearance-contrast-target` (`black` in light, `white` in dark). In Harness Deck, keep semantic `--ink`, `--ink-2`, `--line`, and `--line-strong` tokens central in `beautifului-foundation.css` so global contrast adjustments propagate everywhere cleanly.
