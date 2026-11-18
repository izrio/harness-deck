# Plan 005: Fix Header/SettingsPage keyboard navigation & Escape handling and remove SidebarProvider Cmd/Ctrl+B hijack

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c77c19e..HEAD -- packages/webview-ui/src/components/Header.tsx packages/webview-ui/src/components/SettingsPage.tsx packages/webview-ui/src/components/workbench/SessionsView.tsx packages/webview-ui/src/components/ui/sidebar.tsx packages/webview-ui/src/App.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/001-webview-jsdom-test-baseline.md`
- **Category**: bug
- **Planned at**: commit `c77c19e`, 2026-11-18

## Why this matters

Three keyboard/accessibility issues affect navigation and IDE integration:
1. `Header` implements a `role="tablist"` for the 5 workbench modules, yet `ArrowLeft`/`ArrowRight` does not move focus to the newly activated tab button, `Home`/`End` are unhandled, tabs lack `aria-controls` / panel `id` links, and when an overlay (`settingsOpen` or `historyOpen`) is open, ALL 5 tabs get `tabIndex={-1}`, making the tablist unreachable by keyboard `Tab`.
2. `SettingsPage` lacks an `Escape` shortcut to return to the active module (unlike `SessionHistoryPage` and `MarkdownPreviewModal`).
3. `ui/sidebar.tsx`'s `SidebarProvider` unconditionally registers a `window` `keydown` listener for `Cmd/Ctrl+B` calling `event.preventDefault()`, and writes `document.cookie` on toggle. Both `SessionsView` (kept mounted even when `hidden={true}`) and `SettingsPage` wrap `collapsible="none"` sidebars in `SidebarProvider`, so pressing `Cmd/Ctrl+B` in VS Code Webview intercepts the IDE's own "Toggle Primary Sidebar" shortcut without toggling anything visible.

## Current state

- `packages/webview-ui/src/components/Header.tsx:38-119`:
  ```tsx
  const onNavKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const idx = WORKBENCH_MODULES.indexOf(activeModule);
    const nextIdx =
      e.key === 'ArrowRight'
        ? (idx + 1) % WORKBENCH_MODULES.length
        : (idx - 1 + WORKBENCH_MODULES.length) % WORKBENCH_MODULES.length;
    const nextMod = WORKBENCH_MODULES[nextIdx]!;
    setActiveModule(nextMod);
  };
  ```
  And lines 76–85:
  ```tsx
  {WORKBENCH_MODULES.map((mod) => {
    const active = !settingsOpen && !historyOpen && activeModule === mod;
    return (
      <button
        key={mod}
        type="button"
        role="tab"
        data-testid={`workbench-tab-${mod}`}
        aria-selected={active}
        tabIndex={active ? 0 : -1}
  ```
- Compare exemplar focus-moving tablists in this repo:
  - `TabBar.tsx:57`: `strip.current?.querySelectorAll<HTMLElement>('[role="tab"]')[nextIndex]?.focus();`
  - `SettingsPage.tsx:121-135`: uses `buttonRefs.current[next]?.focus()` and handles `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Home`, `End`.
- `packages/webview-ui/src/components/SessionHistoryPage.tsx:35-41`:
  ```tsx
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeHistoryPage();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
  ```
- `packages/webview-ui/src/components/ui/sidebar.tsx:84, 95-108`:
  ```tsx
  document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`
  ...
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === SIDEBAR_KEYBOARD_SHORTCUT &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault()
        toggleSidebar()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [toggleSidebar])
  ```
- `packages/webview-ui/src/components/workbench/SessionsView.tsx:108-112` & `SettingsPage.tsx:164`.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `pnpm typecheck`         | exit 0, no errors   |
| Lint      | `pnpm lint`              | exit 0              |
| Tests     | `pnpm test`              | all pass            |
| Build     | `pnpm build`             | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `packages/webview-ui/src/components/Header.tsx`
- `packages/webview-ui/src/components/SettingsPage.tsx`
- `packages/webview-ui/src/components/workbench/SessionsView.tsx`
- `packages/webview-ui/src/components/ui/sidebar.tsx`
- `packages/webview-ui/test/keyboard-and-a11y.test.tsx` (create)

**Out of scope** (do NOT touch, even though they look related):
- `packages/webview-ui/src/components/App.tsx` — module mounting logic.
- `packages/webview-ui/src/components/TabBar.tsx` — already moves focus cleanly.
- `packages/webview-ui/src/store.ts` — `setActiveModule` / `closeSettingsPage` already exist.

## Git workflow

- Branch: `advisor/005-a11y-keyboard-and-sidebar-cleanup`
- Commit per logical unit (e.g. `fix(ui): improve header/settings keyboard a11y and disable global Cmd+B sidebar hijack`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Fix `Header.tsx` tablist focus, `tabIndex`, `Home`/`End`, and `aria-controls`

In `packages/webview-ui/src/components/Header.tsx`:
1. Add a `tabRefs = useRef<(HTMLButtonElement | null)[]>([])` (or query `[role="tab"]` inside the tablist ref, matching `SettingsPage.tsx:66, 133`).
2. Update `onNavKeyDown` to handle `ArrowLeft`, `ArrowRight`, `Home`, and `End`, call `setActiveModule(nextMod)`, and move focus with `tabRefs.current[nextIdx]?.focus()`.
3. Keep roving `tabIndex`: set `tabIndex={activeModule === mod ? 0 : -1}` (instead of `!settingsOpen && !historyOpen && activeModule === mod`), so even when an overlay is open, the last-active workbench tab remains reachable via keyboard `Tab`. Keep `aria-selected={active}` as `!settingsOpen && !historyOpen && activeModule === mod`.
4. Add `id={`workbench-tab-${mod}`}` and `aria-controls={`workbench-panel-${mod}`}` (or when `!settingsOpen && !historyOpen && activeModule === mod`, matching `role="tabpanel"` if/when added — note `aria-controls` is valid on tabs).

**Verify**: `pnpm typecheck && pnpm lint` → exit 0.

### Step 2: Add safe `Escape` handler to `SettingsPage.tsx`

In `packages/webview-ui/src/components/SettingsPage.tsx`:
1. Add a `useEffect` listening for `keydown` on `document` (same pattern as `SessionHistoryPage.tsx:35-41`):
   - Only close settings if `event.key === 'Escape'` AND `!event.defaultPrevented` AND no Radix dialog overlay/content (`document.querySelector('[data-slot="dialog-content"]')`) is currently mounted, so pressing `Escape` inside an open modal (`AgentSettings`, `SkillSettings`, `McpSettings`, `ChatCommandSettings`, `GatewayLogsDialog`) closes ONLY the modal first, and pressing `Escape` on the Settings page itself closes Settings (`closeSettingsPage()`).
   - Also check `!event.isComposing`.

**Verify**: `pnpm typecheck && pnpm lint` → exit 0.

### Step 3: Prevent `SidebarProvider` from hijacking `Cmd/Ctrl+B` and writing cookies in Webview

1. In `packages/webview-ui/src/components/ui/sidebar.tsx`:
   - Add an optional prop `keyboardShortcut?: boolean` (default `true` for standard shadcn compatibility) and `persistCookie?: boolean` (default `true`) on `SidebarProvider`.
   - Guard the `document.cookie = ...` line with `if (persistCookie && typeof document !== 'undefined')` and guard the `window.addEventListener("keydown", ...)` effect with `if (!keyboardShortcut) return`.
2. In `packages/webview-ui/src/components/SettingsPage.tsx:164` and `packages/webview-ui/src/components/workbench/SessionsView.tsx:108`:
   - Pass `keyboardShortcut={false} persistCookie={false}` to `<SidebarProvider>`.

**Verify**: `pnpm typecheck && pnpm lint && pnpm build` → exit 0.

### Step 4: Add regression tests in `packages/webview-ui/test/keyboard-and-a11y.test.tsx`

Test in `jsdom`:
1. Render `<Header />`:
   - Press `ArrowRight` on `workbench-tab-overview` → `setActiveModule` updates to `'schedules'` AND `document.activeElement` moves to `workbench-tab-schedules`.
   - Press `End` → moves focus to `workbench-tab-sessions` (`WORKBENCH_MODULES.at(-1)`).
   - Press `Home` → moves focus back to `workbench-tab-overview`.
   - When `settingsOpen` is `true`, `workbench-tab-overview` still has `tabIndex={0}` while `aria-selected="false"`.
2. Render `<SettingsPage />`:
   - Pressing `Escape` calls `closeSettingsPage()` (store `settingsOpen` becomes `false`).
   - When a `[data-slot="dialog-content"]` dialog is open inside `SettingsPage` (e.g. clicking `chat-command-add-btn`), pressing `Escape` closes the dialog first without closing `SettingsPage`.
3. Render `<App />` (or `<SessionsView />` + `<SettingsPage />`), dispatch `Ctrl+B` (`{ key: 'b', ctrlKey: true, cancelable: true }`), and assert `event.defaultPrevented === false` and `document.cookie` does not contain `sidebar_state`.

**Verify**: `pnpm test` → all tests pass.

## Test plan

- New file `packages/webview-ui/test/keyboard-and-a11y.test.tsx` covering Header roving tabindex & arrow/Home/End focus, SettingsPage Escape + dialog precedence, and `Cmd/Ctrl+B` non-interception.
- Verification: `pnpm typecheck && pnpm lint && pnpm test && pnpm build` → exit 0.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test` exits 0, including `keyboard-and-a11y.test.tsx`
- [ ] `pnpm build` exits 0
- [ ] Pressing `Ctrl/Cmd+B` in `SessionsView` / `SettingsPage` does not call `preventDefault()`
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `Header.tsx`, `SettingsPage.tsx`, `SessionsView.tsx`, or `ui/sidebar.tsx` lines differ from the excerpts above.
- Radix `Dialog` swallows `Escape` in `jsdom` differently than expected (verify with `userEvent` or `KeyboardEvent` dispatch in test before assuming).

## Maintenance notes

- If `ui/sidebar.tsx` is later regenerated via `shadcn add`, remember to re-apply `keyboardShortcut={false}` / `persistCookie={false}` props or ensure VS Code Webview keybindings are not intercepted.
