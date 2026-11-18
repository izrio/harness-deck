# Plan 006: Fix Composer async image tab-switch race, attach-image entry, and InteractionCard permanent lock

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c77c19e..HEAD -- packages/webview-ui/src/components/Composer.tsx packages/webview-ui/src/components/Interactions.tsx packages/webview-ui/src/i18n.ts`
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

Two state-integrity bugs affect core chat input and interaction flows:
1. In `Composer.tsx`, `addImages` awaits `FileReader` (`readImage(file)`) and then unconditionally calls `setImages(...)` on the currently mounted tab's state. If the user switches session tabs while an image is being read, the image lands on the wrong tab instead of being stashed under the originating `tabKey`. Additionally, `<input data-testid="composer-image-input" type="file" ... />` is rendered in `Composer.tsx:501-513` without any UI trigger in the `+` attach menu.
2. In `Interactions.tsx`, `ApprovalCard`, `PlanReviewCard`, and `QuestionCard` store a local `sent` state that permanently disables all action buttons once clicked. If the Host keeps the interaction active (for instance after a dirty-file race, reconnect, or backend rejection) or re-pushes the interaction, the card stays frozen forever; additionally, `QuestionCard` indexes `questions[index]!` without guarding `total === 0`.

## Current state

- `packages/webview-ui/src/components/Composer.tsx:94-124`:
  ```tsx
  const tabKey = useView((s) => s.tabs.active);
  const [images, setImages] = useState<PromptImage[]>([]);
  const imageStash = useRef(new Map<string, PromptImage[]>());
  const [text, setText] = useState(() => loadState().draft ?? '');
  const draftOwner = useRef(tabKey);
  ```
- `packages/webview-ui/src/components/Composer.tsx:283-311`:
  ```tsx
  const addImages = async (files: readonly File[]) => {
    let room = MAX_IMAGES - images.length;
    const added: PromptImage[] = [];
    for (const file of files) {
      ...
      try {
        const { data, dataUrl } = await readImage(file);
        const localId = nextImageId();
        registerLocalImage(localId, dataUrl);
        const name = file.name && file.name !== 'image.png' ? file.name : undefined;
        added.push({ localId, mediaType: file.type as ImageMediaType, data, ...(name ? { name } : {}) });
        room--;
      } catch {
        showToast('error', t('image.failed'));
      }
    }
    if (added.length) setImages((current) => [...current, ...added].slice(0, MAX_IMAGES));
  };
  ```
- `packages/webview-ui/src/components/Composer.tsx:486-513`:
  ```tsx
  <div role="menu" data-testid="composer-attach-menu">
    <GlideMenu className="flex flex-col gap-px" highlightClassName="inset-x-0 rounded-[6px] bg-hover">
      <MenuItem
        icon={<FileIcon className="size-3.5" />}
        onSelect={() => {
          setAttachOpen(false);
          postToHost({ type: 'pickFiles', payload: {} });
        }}
      >
        {t('composer.attachFile')}
      </MenuItem>
    </GlideMenu>
  </div>
  ```
- `packages/webview-ui/src/components/Interactions.tsx:106-114` (`ApprovalCard`):
  ```tsx
  const [sent, setSent] = useState<'allow' | 'allowAlways' | 'reject' | undefined>();
  ...
  const respond = (decision: 'allow' | 'allowAlways' | 'reject') => {
    setSent(decision);
    postToHost({ type: 'respondApproval', payload: { id: item.id, decision } });
  };
  ```
- `packages/webview-ui/src/components/Interactions.tsx:184-192` (`PlanReviewCard`) and `278-323` (`QuestionCard`): same local `sent` pattern; line 289: `const q = questions[index]!;`.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `pnpm typecheck`         | exit 0, no errors   |
| Lint      | `pnpm lint`              | exit 0              |
| Tests     | `pnpm test`              | all pass            |
| Build     | `pnpm build`             | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `packages/webview-ui/src/components/Composer.tsx`
- `packages/webview-ui/src/components/Interactions.tsx`
- `packages/webview-ui/src/i18n.ts` (only if adding `composer.attachImage` key in both `zh` and `en`)
- `packages/webview-ui/test/composer-and-interactions.test.tsx` (create)

**Out of scope** (do NOT touch, even though they look related):
- `packages/extension/**` — Host-side `respondApproval` / `answerQuestion` / `pickFiles` handlers.
- `packages/webview-ui/src/store.ts` — message schema and store reducer.

## Git workflow

- Branch: `advisor/006-composer-and-interaction-resilience`
- Commit per logical unit (e.g. `fix(ui): guard async image tab race and recover stuck interaction buttons`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Fix `addImages` tab-switch race and wire image picker menu item in `Composer.tsx`

In `packages/webview-ui/src/components/Composer.tsx`:
1. At the start of `addImages`, capture `const targetTab = draftOwner.current;` and compute `room` against the originating tab's images (already `images.length`).
2. After the `await readImage(file)` loop finishes, check `if (draftOwner.current !== targetTab)`:
   - If the active tab changed while reading, merge `added` into `imageStash.current.set(targetTab, [...(imageStash.current.get(targetTab) ?? []), ...added].slice(0, MAX_IMAGES))` instead of mutating the new tab's `images` state.
   - Otherwise, `setImages((current) => [...current, ...added].slice(0, MAX_IMAGES))`.
3. In the attach `Popover` menu (`composer-attach-menu`, line 488), add a second `MenuItem` (`data-testid="composer-attach-image"`, `icon={<ImageIcon className="size-3.5" />}`) that closes the popover and calls `imageInputRef.current?.click()`. Add `'composer.attachImage'` to both `zh` (`'图片'`) and `en` (`'Images'`) in `packages/webview-ui/src/i18n.ts` (remember `en` is type-checked against `typeof zh`).

**Verify**: `pnpm typecheck && pnpm lint` → exit 0.

### Step 2: Recover `sent` state on persistent/re-pushed interactions and guard empty `questions` in `Interactions.tsx`

In `packages/webview-ui/src/components/Interactions.tsx`:
1. Add a shared timeout/recovery helper (or `useEffect`) for `sent`:
   - If `sent !== undefined` and the card is still mounted after e.g. `4_000` ms (meaning the Host did not settle/remove the interaction), or if `item` reference/fields update (e.g. `dirtyFiles` newly populated on an `ApprovalCard`), reset `sent` to `undefined` so the user is never permanently locked out.
   - Example helper hook inside `Interactions.tsx`:
     ```tsx
     function usePendingReply<T extends string>() {
       const [sent, setSent] = useState<T | undefined>();
       useEffect(() => {
         if (sent === undefined) return;
         const timer = setTimeout(() => setSent(undefined), 4_000);
         return () => clearTimeout(timer);
       }, [sent]);
       return [sent, setSent] as const;
     }
     ```
   - In `ApprovalCard`, also reset `setSent(undefined)` when `item.dirtyFiles` changes (`useEffect(() => setSent(undefined), [item.dirtyFiles])`).
2. In `QuestionCard` (`line 286-290`), guard `if (total === 0) return null;` before indexing `questions[index]!`.

**Verify**: `pnpm typecheck && pnpm lint` → exit 0.

### Step 3: Add unit tests in `packages/webview-ui/test/composer-and-interactions.test.tsx`

Test in `jsdom` using fake timers (`vi.useFakeTimers()` where appropriate):
1. `Composer`:
   - Open attach popover (`composer-attach-btn`), assert `composer-attach-image` menu item exists.
   - Simulate `addImages` via file drop/input change with a mocked `FileReader` that resolves *after* `applyHostMessage({ type: 'tabs', payload: { items: [...], active: 'tab-2' } })` switches tabs; verify `tab-2` has no image thumbnails, and switching back to `tab-1` restores the stashed image thumbnail!
2. `Interactions`:
   - Render `ApprovalCard`, click Allow (`允许本次` / `Approve once`), verify button becomes disabled with spinner, advance timers by `4_000` ms, verify button re-enables if card is still mounted.
   - Render `QuestionCard` with `questions: []`, verify it renders `null` without throwing.

**Verify**: `pnpm test && pnpm build` → all pass.

## Test plan

- `packages/webview-ui/test/composer-and-interactions.test.tsx`:
  - `addImages` does not leak images into a newly selected tab if tab switches mid-read; stashes into originating tab.
  - Attach menu exposes `composer-attach-image`.
  - `ApprovalCard` recovers from `sent` lock after timeout or `dirtyFiles` update.
  - `QuestionCard` safely handles empty `questions` array.
- Verification: `pnpm typecheck && pnpm lint && pnpm test && pnpm build` → exit 0.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test` exits 0, including `composer-and-interactions.test.tsx`
- [ ] `pnpm build` exits 0
- [ ] `i18n.test.ts` passes and both `zh` and `en` include `composer.attachImage`
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `Composer.tsx` or `Interactions.tsx` lines differ from the excerpts above.
- `ui-e2e.ts` assertions break because of `composer-attach-image` text matching (check `ui-e2e.ts` uses `composer-attach-menu` or exact button labels).

## Maintenance notes

- Keep `data-testid="composer-image-input"` intact so existing/future E2E tests can upload files directly via `setInputFiles`.
- If Host ever adds an explicit `interactionAckFailed` event, `usePendingReply` can clear immediately on that event while keeping the 4s fallback.
