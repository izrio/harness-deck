# Motion & Webview Performance Rules

T3 Code is engineered for high-refresh-rate displays (120Hz+) and low idle GPU overhead. Apply these exact patterns in Harness Deck (`packages/webview-ui`).

## 1. Stepped Duty-Cycled Animations (Anti-GPU-Spike Rule)

Continuous CSS animations (`linear` / `ease-in-out` infinite) force the browser compositor to repaint on every vsync (up to 120–240 frames/sec). T3 Code replaces smooth infinite loops with **stepped duty-cycled keyframes** (`steps(...)`):

### Skeleton Loading Breath
Hold solid, then step cleanly to `0.55` opacity and back:
```css
@keyframes skeleton-breath {
  0%, 42% {
    opacity: 1;
    animation-timing-function: steps(4);
  }
  50%, 92% {
    opacity: 0.55;
    animation-timing-function: steps(4);
  }
  100% {
    opacity: 1;
  }
}
/* Duration: 2.4s infinite */
```

### Status Dot Pulse & Ping
```css
@keyframes status-pulse {
  0%, 40% {
    opacity: 1;
    animation-timing-function: steps(6);
  }
  50%, 90% {
    opacity: 0.5;
    animation-timing-function: steps(6);
  }
  100% {
    opacity: 1;
  }
}

@keyframes status-ping {
  0% {
    opacity: 0.9;
    scale: 0.75;
    animation-timing-function: steps(8);
  }
  40%, 100% {
    opacity: 0;
    scale: 2;
  }
}
```

### Live Tool / Activity Focus Sweep
Instead of animating a full-width gradient across the entire DOM, use `steps(30)` over `2.2s` on `transform: translateX(...)` (or `background-position` on a compact `4.5rem` highlight window) and pause when offscreen:

```css
.live-activity-sweep {
  animation: live-activity-focus 2.2s steps(30) infinite;
  animation-play-state: var(--visible-animation-state, paused);
  will-change: var(--visible-animation-will-change, auto);
}
```
> **Offscreen Pause Pattern**: Attach an `IntersectionObserver` to active rows that sets `--visible-animation-state: running` only while visible in the scrollport (`paused` when scrolled offscreen).

## 2. Streaming Text Arrival (`@starting-style`)

To prevent newly streamed paragraphs, code blocks, or Mermaid diagrams from snapping harshly into place without breaking scroll anchoring:

```css
@media (prefers-reduced-motion: no-preference) {
  .markdown[data-streaming] > * {
    transition: opacity 600ms ease-out;

    @starting-style {
      opacity: 0;
    }
  }
}
```
- **Opacity-only**: zero layout shift (`height`/`transform` untouched).
- **One-shot**: gated on `[data-streaming]`, so opening a completed thread never replays entrance fades.

## 3. One-Shot Micro-Interactions

- **Button Tactile Press**: `[&:active:not([aria-haspopup])]:scale-[0.97]` with `transition-[box-shadow,scale]`. (Exclude `[aria-haspopup]` triggers so menus/popovers anchored to the button don't jitter on press.)
- **Timeline Step Arrival**: `180ms ease-out`, `opacity: 0` + `translate: 0 4px` -> resting position (runs once, never loops).
- **Drawer / Context Reveal Curve**: `--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)` for panels, composer drawers, and popovers.
- **Target Highlight Pulse** (e.g., jumping to a setting or search match): 2 cycles of `650ms ease-in-out` inset box-shadow pulse (`2px` `--ring` at `70%` opacity).
- **Theme Switch Suppression**: Temporarily toggle `.no-transitions` (`transition-duration: 0s !important; animation-duration: 0s !important;`) during programmatic theme/contrast switches if needed to prevent multi-element color flash.

## 4. Scrollbar & Scrollport Discipline

- **Thin Pill Scrollbar**: `width: 6px` (`--app-scrollbar-width`), transparent track, rounded pill thumb (`rgb(0 0 0 / 15%)` / `rgb(217 217 217)` light; `rgb(255 255 255 / 32%)` dark to meet WCAG 1.4.11 contrast against the dark slate canvas).
- **Iframe Exclusion**: Never apply `::-webkit-scrollbar` styles globally to `iframe` elements (`:where(:not(iframe))::-webkit-scrollbar`) to avoid WebKit resize loops.
- **Overscroll Containment**: `overscroll-behavior: none` on root shell so IDE webviews don't rubber-band the outer host frame.

## 5. Accessibility & Reduced Motion

- Respect `@media (prefers-reduced-motion: reduce)`:
  - Disable decorative entrance transitions, shimmer sweeps, and progress bar animations.
  - Keep essential active-work indicators readable (e.g., slow down spinners to `1.5s` or show static active state).
- Respect `@media (forced-colors: active)`:
  - Revert custom range sliders to native `appearance: auto` (`accent-color: Highlight`) and hide decorative shine overlays.
- **Keyboard Focus Rings**: Keep `2px` outlines **inside** clipped/scrollable containers (`outline-offset: -2px` or `focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`) so focus rings are never clipped by `overflow: hidden`.
