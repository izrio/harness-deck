# Halo Component Recipes

## 1. Floating Glass Composer & Attached Banner Seam

Halo's signature element is a floating `rounded-2xl` glass composer card that lifts cleanly off the scrolled chat timeline, with optional status/queue/approval banners tucked seamlessly above it.

### Composer Card (`ComposerSurface`)
- **Outer shape**: `rounded-2xl` (`16px`), centered in the chat lane (`max-w-[var(--content-width)]`), `relative isolate`.
- **Glass fill**: `surface-glass` (`bg-surface/80 backdrop-blur-[12px] saturate-[1.14]` light; `blur-[16px] saturate-[1.08]` dark), with solid `bg-surface` fallback.
- **Border & Shadow**:
  - Light: `border border-black/8 shadow-[0_1px_2px_rgb(0_0_0/5%)]`
  - Dark: `border border-white/5 inset-shadow-[0_1px_rgb(255_255_255/3%)] shadow-[0_14px_32px_-18px_rgb(0_0_0/75%)]`
- **Inner layout**:
  1. Top zone (optional): context chips & image thumbnails (`gap-1.5`, compact `rounded-lg` thumbnails with `ring-1 ring-inset ring-black/9 dark:ring-white/12` inner media edge).
  2. Middle zone: borderless multi-line editor/textarea (`outline-none`, clean placeholder in `text-ink-2` / `placeholder`).
  3. Bottom toolbar: compact pickers on the left (model, reasoning/effort, permission mode) using `size="xs"` ghost/outline controls; context ring + send/stop circular button (`rounded-full`) on the right.
- **Context Strip below card** (worktree / branch / environment strip): sits outside the main card in bare `surface-glass` (`text-xs text-ink-2`) so scrolled messages remain softly masked behind it.

### Attached Banners (`ComposerBanner`)
When a banner (approval request, queued run, status notice, error) attaches above the composer:
- **Horizontal inset**: slightly narrower than the composer (`w-[calc(100%-2.75rem)] mx-auto`) so it visually docks into the top edge of the `rounded-2xl` composer.
- **Seam tuck**: negative bottom margin (`-mb-[17px]`) + bottom spacer (`pb` / `after:h-[17px]`) + top-edge fade mask so chromium subpixel seams never show; a `10px` subtle dark-mode seam shadow (`rgb(0 0 0 / 18%)`) grounds the card overlap.
- **Banner Row Grid**: 3-column grid `[icon_col (24px–28px) | minmax(0,1fr) | auto actions]`, `text-xs/4`, `gap-x-1`, with `warning` / `error` variants adding only a `8%` top-tint gradient over the glass surface (never loud solid-colored alert boxes).
- **Slot Architecture**: Export cohesive slot subcomponents (`Root`, `Row`, `Icon`, `Content`, `Actions`, `Separator`) using `cn()` so callers never duplicate banner markup.

## 2. Chat Timeline Rows

### User Message Bubbles (`TimelineUserMessageRow`)
- **Alignment & Max Width**: Right-aligned column (`flex flex-col items-end gap-1`), bubble `max-w-[80%] min-w-0 rounded-2xl bg-field/var(--message-surface) text-ink p-3`.
- **Directional Corner Tightening**: When grouped with adjacent user content or media above (`groupedWithPrevious` / `mediaAboveText`), tighten the top-right corner (`rounded-tr-md`); when followed by another grouped turn (`groupedWithNext`), tighten bottom-right (`rounded-br-md`).
- **Media Edge Protection**: Attached images/screenshots apply an inner 1px hairline ring (`after:ring-1 after:ring-inset after:ring-black/9 dark:after:ring-white/12`) so dark screenshots never dissolve into a dark canvas.
- **Quiet Metadata & Hover Actions**: Timestamp + copy/revert/link actions sit subtly below the bubble (`text-xs text-ink-2 tabular-nums`) with ghost icon buttons (`size="icon-xs"`).

### Assistant Responses (`TimelineAssistantRows`)
- **Unboxed Prose**: Assistant replies have **no card background or border** (`px-1 py-0.5`); they sit directly on the quiet canvas so code blocks, diff cards, and tables carry visual emphasis.
- **Hidden Semantic Heading**: `sr-only` `<h3>` author heading for screen-reader navigation without cluttering visual space.
- **Hover-Revealed Metadata**: Timestamp and copy/fork actions stay unobtrusive (`opacity-0 group-hover/timeline-row:opacity-100 group-focus-within/timeline-row:opacity-100`) until hovered or focused.

## 3. Work Log & Tool Activity Rows (`WorkLog`)

- **Ultra-compact Row**: `min-h-6` (`24px`), `gap-1.5`, `text-sm leading-relaxed` (or `text-xs` in dense IDE sidebars), `select-none` on the toggle header and `select-text` inside expanded output.
- **Fixed Icon Column**: `w-6 shrink-0` centered icon slot (`size-3.5` / `size-4` offline Iconify icon in Halo), using `text-ink-2` (`--secondary-label`) for label text with single-line `truncate` when collapsed.
- **Expanded Output Panel**: Indented `ms-7` (aligned under the label text past the `24px` icon + `4px` gap), `max-h-96 overflow-auto`, subtle hairline border or `bg-inset` code/command surface.
- **In-Progress Shimmer**: Overlay the active label with a soft horizontal highlight sweep (see `motion-and-performance.md`) rather than spinning every tool icon simultaneously.

## 4. Settings Groups (`SettingsGroup`)

- **Grouped Card**: `rounded-xl border border-line/60 bg-surface/40 shadow-xs/5` (light) / `bg-surface/60` (dark).
- **Hairline Row Dividers**: `*:not-first:border-t *:not-first:border-line/50` — rows inside a group have `rounded-none` so focus rings and hover highlights stay flush inside the outer `rounded-xl` clip.
- **Flat Detail Panes**: Avoid nesting bordered cards inside an already-bordered detail card (`border-transparent bg-transparent shadow-none` on inner groups, relying on headings and row dividers instead).
- **Uniform Controls**: Every `Input`, `SelectTrigger`, `NativeSelect`, and `Button` inside a settings row uses `size="sm"` (`h-8`, 32px).

## 5. Markdown, Code Blocks & Diff Surfaces

- **Code Blocks**: `rounded-lg` (`0.5rem`), `1px` border (`border-line`), `bg-inset` / `var(--code-background)`, compact header bar with language label and copy/wrap actions in `color-mix(in srgb, var(--ink) 72%, transparent)`.
- **Diagnostics-Style Markdown Tables**:
  - No heavy outer grid boxes; use `border-collapse` with `1px solid color-mix(in srgb, var(--line) 60%, transparent)` bottom borders only.
  - First/last columns sit flush (`padding-inline-start: 0` on `:first-child`, `padding-inline-end: 0` on `:last-child`).
  - Header cells `font-weight: 600`, `text-align: start`, `vertical-align: top`, `text-wrap: pretty`.
- **Changed Files / Diff Cards**:
  - Compact header row with file count, `+additions` (`--green`) / `-deletions` (`--red`) in `tabular-nums`, and hover-only copy-path button (`opacity-0` until file row hover/focus).

## 6. Dialogs, Popovers & Menus

- **Dialogs**: `rounded-2xl` (`16px`) on desktop with `dialog-glass` + `dialog-backdrop`; on narrow mobile widths (`max-sm`), dock smoothly as a bottom sheet (`max-sm:rounded-none max-sm:border-x-0 max-sm:border-b-0`).
- **Entry/Exit Transition**: `scale-98 opacity-0` -> `scale-100 opacity-100` over `200ms ease-in-out`; nested dialogs offset upward (`-translate-y-[calc(1.25rem*var(--nested-dialogs))]`) and scale down (`scale-[calc(1-0.1*var(--nested-dialogs))]`).
- **Popovers & Dropdown Menus**: `rounded-lg` (`8px`), `dropdown-glass`, `shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)]` light / `rgb(0_0_0/80%)` dark, `scale-98 opacity-0` entrance.
