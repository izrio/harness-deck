# Plan 001: Establish jsdom + Testing Library unit test baseline for webview-ui

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c77c19e..HEAD -- vitest.config.ts packages/webview-ui/package.json packages/webview-ui/tsconfig.json packages/webview-ui/test/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `c77c19e`, 2026-11-18

## Why this matters

`packages/webview-ui` already has `@testing-library/react` (`^16.3.3`) and `jsdom` (`^26.1.0`) installed in the root `package.json`, yet `vitest.config.ts` hardcodes `environment: 'node'` and `packages/webview-ui/test/` only contains a 15-line `i18n.test.ts`. UI regressions (like broken accordion state, keyboard navigation bugs, or store race conditions) can currently only be caught by running the full Playwright + Chromium E2E suite (`packages/extension/scripts/ui-e2e.ts`), which requires a built extension and an external agent binary. Establishing a fast `jsdom` component-test baseline in `pnpm test` unblocks safe, machine-verifiable UI fixes in plans `002` through `008`.

## Current state

- `vitest.config.ts:1-15` — configures Vitest with `environment: 'node'` and `include: ['packages/*/test/**/*.test.ts']` (note: `.tsx` test files are NOT matched):
  ```ts
  import { resolve } from 'node:path';
  import { defineConfig } from 'vitest/config';

  export default defineConfig({
    resolve: {
      alias: {
        '@': resolve(import.meta.dirname, 'packages/webview-ui/src'),
      },
    },
    test: {
      include: ['packages/*/test/**/*.test.ts'],
      environment: 'node',
      testTimeout: 15_000,
    },
  });
  ```
- `packages/webview-ui/tsconfig.json:1-13` — includes `"src"`, `"test"`, `"vite.config.ts"`, and maps `"@/*": ["./src/*"]`.
- `packages/webview-ui/src/components/ui/*.tsx` — imports `cn` from `"cn"` (which works at Vite/Vitest time only when resolved; Plan 003 will migrate `"cn"` to `"@/lib/utils"`).
- `packages/webview-ui/src/vscode.ts:24-39` — lazily calls `acquireVsCodeApi<PersistedState>()` when `postToHost`, `loadState`, or `saveState` runs. In tests without `globalThis.acquireVsCodeApi`, calling `postToHost` throws `ReferenceError: acquireVsCodeApi is not defined`.
- `packages/webview-ui/test/i18n.test.ts:1-15` — existing test pattern:
  ```ts
  import { describe, expect, it } from 'vitest';
  import { translator } from '../src/i18n.ts';

  describe('Webview 文案', () => {
    it('按语言取文案并填入参数', () => {
      expect(translator('zh')('changes.title', 3)).toBe('3 个文件已更改');
      expect(translator('en')('changes.title', 3)).toBe('3 files changed');
      ...
    });
  });
  ```
- Root `package.json:9-12`:
  - `"typecheck": "pnpm -r run typecheck"`
  - `"lint": "eslint ."`
  - `"test": "vitest run"`
  - `"build": "pnpm --filter @harness-deck/webview-ui run build && pnpm --filter harness-deck run build"`

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `pnpm typecheck`         | exit 0, no errors   |
| Lint      | `pnpm lint`              | exit 0              |
| Tests     | `pnpm test`              | all pass            |
| Build     | `pnpm build`             | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `vitest.config.ts`
- `packages/webview-ui/test/setup.ts` (create)
- `packages/webview-ui/test/store.test.ts` (create)
- `packages/webview-ui/test/app-smoke.test.tsx` (create)

**Out of scope** (do NOT touch, even though they look related):
- `packages/webview-ui/src/**` — do not modify source code in this plan; fix bugs in subsequent plans.
- `packages/extension/test/**` — must remain running under Node environment without DOM pollution.
- `package.json` — `@testing-library/react` and `jsdom` are already installed; do not install new packages.

## Git workflow

- Branch: `advisor/001-webview-jsdom-test-baseline`
- Commit per logical unit; conventional concise style matching repo (e.g. `test(webview): add jsdom + testing-library baseline`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Enable `.test.tsx` discovery and per-environment Vitest config

Update `vitest.config.ts` so:
1. `test.include` matches both `.test.ts` and `.test.tsx` under `packages/*/test/**`: `['packages/*/test/**/*.test.{ts,tsx}']`.
2. Keep `environment: 'node'` as the default for extension/shared tests, OR use Vitest `environmentMatchGlobs` / `projects` (Vitest 3.2 supports `test.projects` or `// @vitest-environment jsdom` docblock + `setupFiles` gated on `typeof window !== 'undefined'`). Using `// @vitest-environment jsdom` in `packages/webview-ui/test/**/*.test.tsx` (or `projects` in `vitest.config.ts` with `environment: 'jsdom'` for `packages/webview-ui/test/**/*.test.tsx` and `environment: 'node'` for everything else) keeps `packages/extension/test/**/*.test.ts` completely untouched in Node.
3. Also add alias `'cn'` if needed or keep `@` alias (`'@': resolve(import.meta.dirname, 'packages/webview-ui/src')`). Note: `eslint.config.mjs:14` configures `projectService: { allowDefaultProject: ['vitest.config.ts'] }`, so `vitest.config.ts` must stay valid TypeScript under strict settings (`tsconfigRootDir`).

**Verify**: `pnpm typecheck && pnpm lint` → exit 0, zero errors.

### Step 2: Create Webview test setup helper (`packages/webview-ui/test/setup.ts`)

Create `packages/webview-ui/test/setup.ts` exporting helper utilities for component tests (do not put test helper code under `src/`):
- `mockVsCodeApi()` — installs a mock `globalThis.acquireVsCodeApi` returning `{ postMessage, getState, setState }` with an in-memory `PersistedState` object and returns `{ posted, reset }` so tests can assert outgoing `WebviewToHost` messages and reset state cleanly.
- `cleanup` call from `@testing-library/react` in `afterEach` (when `typeof document !== 'undefined'`).
- `resetStoreForTests()` call from `../src/store.ts` in `beforeEach` / `afterEach`.
- Polyfill `window.matchMedia` and `Element.prototype.scrollIntoView` / `HTMLElement.prototype.scrollTo` if missing in `jsdom` (guarded on `typeof window !== 'undefined'`).

**Verify**: `pnpm typecheck && pnpm lint` → exit 0.

### Step 3: Add `store.test.ts` and `app-smoke.test.tsx`

1. Create `packages/webview-ui/test/store.test.ts` testing `applyHostMessage`, `setActiveModule`, `openSettingsPage` (including legacy tab normalization `'interface' -> 'appearance'`, `'extensions' -> 'skills'`), `items` incremental patch filtering (`sessionKey` mismatch ignored), and `fileCandidates` monotonic `requestId` guard.
2. Create `packages/webview-ui/test/app-smoke.test.tsx` (with `// @vitest-environment jsdom` at line 1 if not using a separate jsdom project glob) rendering `<App />`, dispatching a minimal `snapshot` message via `applyHostMessage`, and verifying:
   - `Ready` postMessage is emitted on mount (`type: 'ready'`).
   - Empty home view renders (`[data-testid="suggestions"]`).
   - Switching workbench tabs via `[data-testid="workbench-tab-schedules"]` mounts `[data-testid="workbench-schedules"]`.

**Verify**: `pnpm test` → all existing tests + new `store.test.ts` and `app-smoke.test.tsx` pass.

## Test plan

- `packages/webview-ui/test/store.test.ts`:
  - `snapshot` initializes state and sets `ready: true`.
  - `items` non-reset patch with mismatched `sessionKey` is dropped.
  - `fileCandidates` with stale `requestId` is ignored.
  - `openSettingsPage('interface')` normalizes to `'appearance'`.
- `packages/webview-ui/test/app-smoke.test.tsx`:
  - Mounts `<App />` in `jsdom`, asserts `postToHost` called with `{ type: 'ready', payload: {} }`.
  - Applies `snapshot` and asserts suggestions / header navigation work.
- Verification: `pnpm test` → exits 0 with all existing and new tests passing.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test` exits 0 and runs `packages/webview-ui/test/store.test.ts` and `packages/webview-ui/test/app-smoke.test.tsx`
- [ ] `pnpm build` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts.
- `vitest.config.ts` fails `pnpm lint` (`@typescript-eslint` projectService) or breaks any existing test under `packages/extension/test/`.
- A component rendered in `app-smoke.test.tsx` crashes in `jsdom` due to an un-polyfilled browser API that would require editing `packages/webview-ui/src/**`.

## Maintenance notes

- Keep DOM polyfills (such as `matchMedia`, `ResizeObserver`, `scrollIntoView`) inside `packages/webview-ui/test/setup.ts`, never in `packages/webview-ui/src/`.
- Subsequent plans (`002`–`007`) will add component test files under `packages/webview-ui/test/*.test.tsx` modeling after `app-smoke.test.tsx`.
