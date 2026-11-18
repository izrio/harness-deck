# Plan 007: Preserve ItemView memoization during streaming and unify Toasts mount slot

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c77c19e..HEAD -- packages/webview-ui/src/components/Items.tsx packages/webview-ui/src/components/RunStatus.tsx packages/webview-ui/src/components/Thread.tsx packages/webview-ui/src/App.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/001-webview-jsdom-test-baseline.md`
- **Category**: perf
- **Planned at**: commit `c77c19e`, 2026-11-18

## Why this matters

During streaming assistant replies, `Thread` re-renders on every incoming chunk. `ItemView` is wrapped in `React.memo` specifically to avoid re-rendering completed turns, yet `Items.tsx:73` instantiates a fresh `<AssistantActions text={turnDoneCopyText} inline />` JSX element as the `actions` prop of `TurnDone`, AND `Thread.tsx:122-127` relies on `ItemView` props staying stable. Passing `turnDoneCopyText` as a string directly into `TurnDone` (and rendering `<AssistantActions>` inside `TurnDone`) preserves `memo` stability across all completed turns. Separately, `App.tsx:93,96` mounts `<Toasts />` in two mutually exclusive branches (`{!hideChat ? <Toasts /> : null}` inside `SessionsView` and `{hideChat ? <Toasts /> : null}` outside), causing active error/info toasts to unmount/remount and replay their `pop-in` animation whenever switching views or opening Settings/History.

## Current state

- `packages/webview-ui/src/components/Items.tsx:72-74`:
  ```tsx
  case 'turnDone':
    return <TurnDone item={item} {...(turnDoneCopyText !== undefined ? { actions: <AssistantActions text={turnDoneCopyText} inline /> } : {})} />;
  ```
- `packages/webview-ui/src/components/RunStatus.tsx:86-101`:
  ```tsx
  export function TurnDone({ item, actions }: { item: Extract<Item, { kind: 'turnDone' }>; actions?: ReactNode }) {
    const t = useT();
    return (
      <div className={cn('turn-done flex items-center gap-2 text-[12px] text-ink-3', actions ? '-mt-2' : '-mt-1')} data-testid="turn-done">
        {actions}
        <span className="flex items-center gap-1.5">
          {item.completed ? (
            <span className="inline-flex size-3.5 items-center justify-center rounded-full bg-green-tint text-green">
              <CheckIcon className="size-2.5" strokeWidth={2.5} />
            </span>
          ) : null}
          <span>{item.completed ? t('run.done', formatDuration(item.durationMs, t)) : t('run.took', formatDuration(item.durationMs, t))}</span>
        </span>
      </div>
    );
  }
  ```
- `packages/webview-ui/src/App.tsx:81-97`:
  ```tsx
  <SessionsView hidden={hideChat}>
    <TabBar />
    {ready ? <RuntimeBanner status={runtime} connection={connection} /> : null}
    ...
    {opening ? <SessionLoading /> : empty ? <EmptyState /> : <Thread />}
    {!hideChat ? <Toasts /> : null}
    <Composer />
  </SessionsView>
  {hideChat ? <Toasts /> : null}
  ```

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `pnpm typecheck`         | exit 0, no errors   |
| Lint      | `pnpm lint`              | exit 0              |
| Tests     | `pnpm test`              | all pass            |
| Build     | `pnpm build`             | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `packages/webview-ui/src/components/Items.tsx`
- `packages/webview-ui/src/components/RunStatus.tsx`
- `packages/webview-ui/src/App.tsx`
- `packages/webview-ui/test/memo-and-toasts.test.tsx` (create)

**Out of scope** (do NOT touch, even though they look related):
- `packages/webview-ui/src/components/Thread.tsx` — `turnDoneCopyText` is already passed as a primitive string.
- `packages/webview-ui/src/components/Toasts.tsx` — toast item rendering itself is fine.

## Git workflow

- Branch: `advisor/007-streaming-memo-and-toasts-stability`
- Commit per logical unit (e.g. `perf(ui): avoid turnDone element recreation and keep single Toasts mount`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Pass `copyText` string to `TurnDone` instead of creating inline JSX in `Items.tsx`

1. Export `AssistantActions` from `Items.tsx` (or keep a small `CopyButton` / `AssistantActions` prop or render inside `RunStatus.tsx` — check for circular imports! Note `Items.tsx` currently imports `TurnDone` from `RunStatus.tsx`. To avoid a circular import between `Items.tsx` and `RunStatus.tsx`, either:
   - Extract `AssistantActions` (or `TurnDone`) cleanly, e.g., put `AssistantActions` in `RunStatus.tsx` or a tiny `MessageActions` helper, OR pass `renderActions?: (text: string) => ReactNode`? No, passing a function still needs a stable reference. Moving `AssistantActions` into `RunStatus.tsx` (or keeping `TurnDone` accepting `copyText?: string` and importing `IconAction` / `CopyIcon` / `CheckIcon` in `RunStatus.tsx` without importing `Items.tsx`) avoids any circular dependency!).
2. Update `Items.tsx:73` to pass `{...(turnDoneCopyText !== undefined ? { copyText: turnDoneCopyText } : {})}` to `<TurnDone>` (which is inside `ItemView`, already `memo`'d, and also wrap `TurnDone` in `memo` in `RunStatus.tsx`).

**Verify**: `pnpm typecheck && pnpm lint` → exit 0.

### Step 2: Mount `<Toasts />` in a single persistent position in `App.tsx`

In `packages/webview-ui/src/App.tsx:73-98`:
1. Remove `{!hideChat ? <Toasts /> : null}` (line 93) and `{hideChat ? <Toasts /> : null}` (line 96).
2. Render `<Toasts />` ONCE in a single overlay/footer position inside `.app` (for instance, `fixed` or bottom-anchored `pointer-events-none` container above the composer / bottom of `.app`, OR right above `Composer` when `!hideChat`? Wait: in chat mode `Toasts` sits right above `Composer` (`margin-bottom: 8px` inside `.content-column`), and when `hideChat` is true (`SettingsPage`, `HistoryPage`, `OverviewView`, etc.), it sits at the bottom of `.app`!).
3. If keeping `Toasts` visually above `Composer` in chat mode and at the bottom of `.app` in non-chat mode, placing `<Toasts />` in a single fixed/floating container at the bottom of `.app` (e.g. `<div className="pointer-events-none fixed inset-x-0 bottom-3 z-40 [&_.toast]:pointer-events-auto">`) OR keeping it as a direct child at the bottom of `.app` ensures React NEVER unmounts/remounts `<Toasts />` when toggling `settingsOpen`, `historyOpen`, or `activeModule`! Note: verify `ui-e2e.ts:914` only queries `page.locator('.toast', { hasText: 'API Key 已保存' })` — it does not require `.toast` to be inside `.sessions-view` or `.content-column` above Composer, and fixed bottom-center (`content-column`) looks crisp and never shifts the chat thread layout when a toast pops in/out!

**Verify**: `pnpm typecheck && pnpm lint && pnpm build` → exit 0.

### Step 3: Add tests in `packages/webview-ui/test/memo-and-toasts.test.tsx`

Test in `jsdom`:
1. Render `<App />`, trigger an error toast via `applyHostMessage({ type: 'toast', payload: { level: 'error', text: 'Persistent error' } })`, capture the DOM element node of `.toast`, open `SettingsPage` (`openSettingsPage()`), close `SettingsPage` (`closeSettingsPage()`), and assert the exact same `.toast` DOM node (`toBe` identity) remained mounted throughout!
2. Render `TurnDone` with `copyText="Hello"` and verify the copy button (`aria-label` matching `assistant.copy`) renders alongside the completion badge.

**Verify**: `pnpm test` → all pass.

## Test plan

- `packages/webview-ui/test/memo-and-toasts.test.tsx`:
  - `.toast` DOM node identity persists across switching between chat, Settings, and History views.
  - `TurnDone` renders copy action button when `copyText` is provided and omits it when absent.
- Verification: `pnpm typecheck && pnpm lint && pnpm test && pnpm build` → exit 0.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test` exits 0, including `memo-and-toasts.test.tsx`
- [ ] `pnpm build` exits 0
- [ ] `App.tsx` contains only ONE `<Toasts />` JSX element
- [ ] `Items.tsx` does not import from `RunStatus.tsx` and simultaneously export back to `RunStatus.tsx` (zero circular imports)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `Items.tsx`, `RunStatus.tsx`, or `App.tsx` lines do not match the excerpts above.
- Fixed toast positioning overlaps interactive Composer controls in narrow viewports (if so, position above composer offset or bottom-top toast slot and document in NOTES).

## Maintenance notes

- Placing `<Toasts />` in a single persistent portal/overlay slot at the `.app` root prevents toast animations from replaying on module switches and keeps thread scroll height stable when toasts appear/dismiss.
