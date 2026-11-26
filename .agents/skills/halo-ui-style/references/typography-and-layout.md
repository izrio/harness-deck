# Typography, Spatial Layout & Control Sizing

## 1. Typography System

### Font Stacks
- **Interface & Prose (`--font-sans`)**:
  `-apple-system, BlinkMacSystemFont, "Inter Variable", "Segoe UI", system-ui, sans-serif`
  *(In Halo, keep `var(--hd-font-family, var(--vscode-font-family, ...))` ahead of the fallback stack in `beautifului-foundation.css`.)*
- **Code & Terminal (`--font-mono`)**:
  `"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace`
  *(In Halo, keep `var(--hd-code-font-family, var(--vscode-editor-font-family, ...))` ahead of the fallback stack.)*

### Micro-Typography Scale (Dense IDE UI)
Halo introduces stepped sub-`xs` text utilities for metadata, badges, counters, keyboard hints, and tool rows:

| Token / Class | Size | Line Height | Usage |
| --- | --- | --- | --- |
| `text-5xs` | `7px` (`0.4375rem`) | `1` | Tiny icon badge overlays |
| `text-4xs` | `8px` (`0.5rem`) | `1` | Compact provider icon overlays |
| `text-3xs` | `10px` (`0.625rem`) | `14px` | Small `Badge size="sm"`, micro metadata |
| `text-2xs` | `11px` (`0.6875rem`) | `16px` | Timestamps, secondary badges, `Kbd` hints, `micro` labels |
| `text-xs` | `12px` (`0.75rem`) | `16px` | Banner text, tool details, file metadata, compact buttons |
| `text-sm` | `14px` (`0.875rem`) | `20px` | Primary UI controls, sidebar titles, work-log rows, markdown tables |

### Typographic Polish Rules
- **`tabular-nums`**: Mandatory on all working timers, relative timestamps, byte sizes, diff `+N / -N` counts, and numeric inputs.
- **Line wrapping**: Headings use `text-wrap: balance`; prose paragraphs use `text-wrap: pretty`; inline links use `text-underline-position: from-font; text-decoration-skip-ink: auto`.
- **Dotted underline on external links**: Markdown external links use a subtle dotted underline on hover/focus (`radial-gradient(circle, currentcolor 0.75px, transparent 1px)` at `4px 2px` repeat-x) rather than harsh solid underlines.
- **Font ligatures & prose alignment**:
  - Markdown prose: `14px–15px`, `line-height: 1.55–1.6`, paragraph vertical margin `0.65rem` (`~10px`), headings `font-weight: 600` (`1.25rem` h1 -> `1.125rem` h2 -> `1rem` h3 -> `0.875rem` h4–h6), `strong` weight `600–700`.
  - Inline code: `0.85em–0.87em`, `padding: 0.1em 0.35em`, `border-radius: 0.25rem`, `box-decoration-break: clone`, subtle `10%` ink tint background.
  - Blockquote: `2px` inline-start border (`35%` currentColor), `padding-inline-start: 0.8rem`.
  - Ordered lists: `font-variant-numeric: tabular-nums` on `::marker` with adequate gutter (`min 1.25rem`).

## 2. Spatial Rhythm & Layout Geometry

### Workspace Proportions
- **Top Header Bar**: `52px` (`--workspace-topbar-height`, `40px` min in compact frameless mode) or compact IDE header (`~36px–44px`), single horizontal row with breadcrumb/title on the left and compact icon-only layout controls on the right.
- **Topbar Scroll Fade (`topbar-scroll-fade`)**: Use a vertical CSS `mask-image` gradient over the top `1.5rem` of the timeline scroll area (while keeping the `6px` scrollbar lane opaque) so scrolling messages softly dissolve under the header rather than clipping harshly at a 1px line.
- **Centered Chat Column**:
  - Comfortable width: `46rem` (`736px`, comparable to Halo's `--content-width: 820px`)
  - Wide width: `72rem` (`1152px`)
  - Full width: `100%`
  - Consistent horizontal padding (`0.75rem` on narrow viewports, `3rem` on desktop `>= 640px` when spacious, or `14px` in compact IDE sidebars).
- **Radii Hierarchy**:
  - Small chips / inline code / menu items: `4px–6px` (`rounded-sm` / `rounded-md`)
  - Interactive controls (buttons, inputs, selects): `8px` (`--control-radius: 0.5rem` / `rounded-lg`)
  - Inset sub-blocks (previews, channel sub-forms): `12px` (`rounded-xl`)
  - Settings tonal cards, composer, attached banners, dialogs, message bubbles: `16px` (`rounded-2xl`)
  - Pills / scroll-to-bottom / action send buttons: `9999px` (`rounded-full`)

### Sidebar Hierarchy
- Quiet background (`--inset` / `--sidebar`), separated from the main pane by a single `1px` border (`--line` / `white / 8%` dark).
- **Folder / Project Headers**: `h-8` (`32px`), `gap-2.5`, `rounded-lg` hover surface (`hover:bg-sidebar-row-hover`).
- **Thread Rows**:
  - Slim / folder row: `~30px–34px` single-line or compact two-line row; inactive/visited rows subtly recede (`text-ink-2` / `75%` opacity) and brighten on hover (`text-ink`).
  - Selected / active row: crisp elevated surface (`bg-surface` / `ring-1 ring-inset ring-line/70` in light; subtle translucent lift `white / 7%–11%` in dark).
  - Hover-revealed trailing actions: keep action buttons hidden or unobtrusive until row hover/focus-within (`any-hover` media query on desktop, always visible on touch).

## 3. Mapping Halo Sizes to Halo's 4-Tier Scale

> **CRITICAL**: Halo sizes buttons with `sm:h-7` / `sm:h-8` responsive classes, whereas **Halo strictly enforces a 4-tier uniform `size` prop** (`xs` = 24px, `sm` = 32px, `default` = 36px, `lg` = 40px) across `Button`, `Input`, `NativeSelect`, and `SelectTrigger` (`AGENTS.md`).

Always translate Halo's compact ergonomics using Halo's official `size` props:

| Context | Halo Equivalent | Halo Prop | Pixel Height |
| --- | --- | --- | --- |
| Toolbar icon buttons, inline row actions, card header controls, filter pills | `size="xs"` / `size="icon-xs"` / `size="compact"` | `size="xs"` / `size="icon-xs"` | `24px` (`h-6` / `size-6`) |
| **IDE Forms, Settings rows, Dialog footer buttons, Search bars, Composer toolbar pickers** | `size="default"` (`sm:h-8`) / `size="sm"` (`sm:h-7`) | **`size="sm"` / `size="icon-sm"`** | **`32px` (`h-8` / `size-8`)** |
| Standalone roomy forms / emphasized search | `size="lg"` (`sm:h-9`) | `size="default"` / `size="icon"` | `36px` (`h-9` / `size-9`) |
| Welcome hero primary CTA | `size="xl"` | `size="lg"` / `size="icon-lg"` | `40px` (`h-10` / `size-10`) |

**Alignment rule**: Every single-line control in the same horizontal row or form (e.g., `Input` + `SelectTrigger` + `Button`) **must** share the exact same `size` prop (`sm` or `xs`), with zero inline `h-*` class overrides.
