---
name: halo-ui-style
description: >-
  Applies the Halo minimal AI coding-agent UI aesthetic and design system
  to Halo (packages/webview-ui). Use when designing, styling, polishing, or
  refactoring chat timelines, floating glass composers, sidebars, settings groups,
  dialogs/popovers, activity work-logs, themes, or micro-interactions while staying
  strictly compliant with Halo's shadcn-ui, beautifului, 4-tier size scale,
  and offline Iconify rules.
---

# Halo UI & Visual Style Guide

This skill defines the visual identity, surface hierarchy, spatial rhythm, and motion discipline of **Halo** (`packages/webview-ui`).

## Core Aesthetic Principles

1. **Quiet Neutrality, High Signal**
   - **Light mode ("Quiet Zinc")**: Near-white canvas (`#fcfcfc`), cool-zinc sidebar (`#fafafa`), crisp `#ffffff` raised cards, `#e4e4e7` hairline borders, and deep royal blue primary (`#1b4ed8`).
   - **Dark mode ("Cool Slate + Soft Hairlines")**: Layered cool slate-gray backdrop (`oklch(0.198 0.007 264)` `--page`, `oklch(0.222 0.008 264)` `--canvas`, `oklch(0.238 0.008 265)` `--inset` sidebar) rather than harsh pure `#000`; cards and popovers lift cleanly via `oklch(0.258 0.01 266)` (`--surface`) and subtle slate hairline borders (`oklch(0.312 0.01 262)`), paired with electric blue (`#346bf1`).
   - **Curated Editorial Palettes**: Optional OKLCH surface themes (`Rose`, `Grove`, `Ocean`, `Ember`, `Iris`) tint surfaces gently while keeping syntax, diff, and semantic feedback tokens legible.

2. **Hairlines, Specular Edges, and Glass over Heavy Shadows**
   - Separate stacked surfaces with **1px translucent borders** and subtle **1px top-edge inset highlights** (`white/16%` on solid primary buttons, `black/4%` light / `white/6%` dark on outline surfaces) instead of muddy drop shadows.
   - Floating surfaces (composer, attached banners, dialogs, popovers) use **frosted glass** (`backdrop-filter: blur(12px–16px) saturate(1.08–1.14)` at ~80% surface opacity) with an opaque fallback when `backdrop-filter` is unsupported.
   - Optional subtle **surface grain** (`0.035` opacity SVG turbulence) is baked directly into surface `background-image`—never as a full-viewport overlay—to avoid idle GPU compositing overhead.

3. **Dense, Calibrated IDE Proportions**
   - Centered reading/chat lane (`max-width` ~46rem / `820px` in Halo), generous outer breathing room, and compact inner control rhythm.
   - Clear sub-`xs` micro-typography (`11px` / `10px`) with `tabular-nums` for timestamps, line counts, file sizes, and diffs.
   - Lighter icon stroke weight (`1.75` vs heavy `2px` default) and muted icon tinting so icons support labels without competing with prose.

4. **Performance-First Motion**
   - Stepped keyframes (`steps(4)`, `steps(6)`, `steps(30)`) for skeletons, status pulses, and live-tool shine so 120Hz displays do not repaint every vsync.
   - One-shot `@starting-style` opacity fades (`600ms ease-out`) for streaming markdown blocks; tactile `scale-[0.97]` press feedback on buttons; full `prefers-reduced-motion` support.

## Mandatory Halo Guardrails

When applying Halo's visual patterns inside `packages/webview-ui`, **never violate `AGENTS.md` constraints**:

| Area | Halo Pattern | Halo Mandatory Rule |
| --- | --- | --- |
| **Component Primitives** | `@base-ui/react` in `components/ui/` | Use existing `shadcn-ui` (`packages/webview-ui/src/components/ui/*`, installed via `pnpm dlx shadcn@latest add -c packages/webview-ui <name>`) and `beautifului` (`packages/webview-ui/src/components/beautifului/*`). **Do not invent new base controls.** |
| **Control Sizing** | Responsive `sm:h-7` / `sm:h-8` overrides | **Strictly use the 4-tier `size` prop**: `xs` (`h-6` / 24px), `sm` (`h-8` / 32px — IDE form/modal default), `default` (`h-9` / 36px), `lg` (`h-10` / 40px). **Never override height with inline `h-7`/`h-8` classes.** Align sibling controls in the same row to the exact same `size`. |
| **Icons** | `lucide-react` direct imports | **Offline Iconify only** via `packages/webview-ui/src/components/icons.tsx` (`<AppIcon />` + `@iconify-icons/lucide/*` + `@iconify/react/offline`). Never import `lucide-react` in business components or `beautifului`, and never fetch icons online (strict Webview CSP). |
| **Color Tokens** | `--background`, `--card`, `--contrast-*` | Map colors through semantic tokens in `packages/webview-ui/src/styles/beautifului-foundation.css` (`--page`, `--canvas`, `--surface`, `--inset`, `--hover`, `--field`, `--ink`, `--ink-2`, `--ink-3`, `--line`, `--line-strong`, `--accent`, plus bridged shadcn vars). **Never hardcode colors in components.** |
| **IDE Host Fonts & CSP** | `--font-sans` (`Inter Variable`) | Preserve `--hd-font-family` / `--vscode-font-family` and `--hd-code-font-family` / `--vscode-editor-font-family` fallbacks in `beautifului-foundation.css` so VS Code and JetBrains theme fonts remain respected. |

## Reference Modules (Progressive Disclosure)

Read only the reference file(s) relevant to the task at hand:

- **Colors, Palettes, Glass & Grain**: [design-tokens.md](./references/design-tokens.md) — Exact Halo light/dark palettes, 5 OKLCH theme presets, contrast-mix math, glass/grain utilities, and direct mapping to `beautifului-foundation.css`.
- **Typography, Layout & Sizing**: [typography-and-layout.md](./references/typography-and-layout.md) — Font stacks, micro-type ramp, `tabular-nums`, chat lane geometry, header scroll-fade masks, sidebar hierarchy, and Halo `xs`/`sm`/`default`/`lg` mapping.
- **Component Recipes**: [component-patterns.md](./references/component-patterns.md) — Floating glass Composer + attached banner seam (`ComposerSurface` / `ComposerBanner`), grouped user bubbles, unboxed assistant prose, `WorkLog` activity rows, `SettingsGroup` cards, and Diff/Markdown styling.
- **Motion & Webview Performance**: [motion-and-performance.md](./references/motion-and-performance.md) — Stepped keyframes, offscreen animation pausing, `@starting-style` streaming chunk fade, tactile button press, and reduced-motion rules.

## Workflow When Applying This Style

1. **Audit target component(s)** in `packages/webview-ui/src/components/` against the relevant reference file(s).
2. **Place token/surface changes centrally** in `packages/webview-ui/src/styles/beautifului-foundation.css` or `beautifului-prose.css` (not scattered inline `style={{}}` or hardcoded hex values).
3. **Compose existing primitives** (`Button`, `Badge`, `Card`, `Input`, `Dialog`, `Popover`, `beautifului/*`) using `size="xs"` (toolbars/row actions) or `size="sm"` (forms/dialogs).
4. **Verify** after edits using Halo checks:
   - `pnpm --filter @harness-deck/webview-ui typecheck` (or `pnpm typecheck`)
   - `pnpm lint`
   - `pnpm test` / `pnpm build`
   - Visually inspect both Light and Dark themes (plus reduced-motion behavior if motion changed).
