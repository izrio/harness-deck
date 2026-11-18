# Plan 003: Separate shadcn --accent hover token from brand accent, define --ink-4, and unify cn()

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c77c19e..HEAD -- packages/webview-ui/src/styles/beautifului-foundation.css packages/webview-ui/src/components/ui/ packages/webview-ui/package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/001-webview-jsdom-test-baseline.md`
- **Category**: bug
- **Planned at**: commit `c77c19e`, 2026-11-18

## Why this matters

Three foundational styling/token bugs currently affect the entire UI:
1. **shadcn `--accent` collision**: `beautifului-foundation.css` bridges `--color-accent: var(--accent)` (vivid blue/orange/green/purple/rose brand color) and `--accent-foreground: #ffffff`. However, shadcn-ui's `Button` (`outline`/`ghost`), `Badge` (`outline`/`ghost`), `SelectItem`, `DropdownMenuItem`, and `Skeleton` use `bg-accent` / `hover:bg-accent` expecting a subtle neutral hover surface. As a result, hovering any `outline`/`ghost` button in light mode flashes vivid brand color with white text (or red-on-blue in `ProviderSettings.tsx:1357`), and `Skeleton` pulses in vivid brand color.
2. **Missing `--ink-4` token**: `SkillSettings.tsx:309` and `McpSettings.tsx:645,768,813,977` use `text-ink-4`, which is never defined in `:root`, `.dark`, or `@theme inline`, so Tailwind v4 emits no rule and secondary metadata renders in full-contrast `--ink`.
3. **Dual `cn()` implementations**: `packages/webview-ui/components.json:16` specifies `"utils": "@/lib/utils"` (`clsx` + `tailwind-merge`), yet `src/components/ui/*.tsx` import `{ cn } from "cn"` (the external `cn` npm package, which does not merge conflicting Tailwind utility classes).

## Current state

- `packages/webview-ui/src/styles/beautifului-foundation.css`:
  - Lines 36–46 (`:root` Slate Light):
    ```css
    --ink: oklch(0.242 0.012 258);
    --ink-2: oklch(0.502 0.014 260);
    --ink-3: oklch(0.685 0.012 260);

    --line: oklch(0.932 0.006 255);
    --line-strong: oklch(0.892 0.009 255);
    --line-soft: oklch(0.956 0.004 255);

    --accent: oklch(0.585 0.195 255);
    --accent-ink: oklch(0.515 0.185 255);
    --accent-tint: oklch(0.955 0.022 253);
    ```
  - Lines 64–91 (`:root` shadcn bridge):
    ```css
    --muted: var(--inset);
    --muted-foreground: var(--ink-2);
    --accent-foreground: #ffffff;
    --destructive: var(--red);
    --destructive-foreground: #ffffff;
    ```
  - Lines 200–211 (`.dark` Slate Dark):
    ```css
    --ink: oklch(0.96 0.004 252);
    --ink-2: oklch(0.735 0.01 260);
    --ink-3: oklch(0.545 0.012 262);
    ...
    --accent: oklch(0.69 0.165 253);
    --accent-ink: oklch(0.79 0.115 248);
    --accent-tint: oklch(0.69 0.165 253 / 0.16);
    ```
  - Lines 329–340 & 371–398 (`@theme inline`):
    ```css
    --color-ink: var(--ink);
    --color-ink-2: var(--ink-2);
    --color-ink-3: var(--ink-3);
    ...
    --color-accent: var(--accent);
    --color-accent-ink: var(--accent-ink);
    --color-accent-tint: var(--accent-tint);
    ...
    --color-accent-foreground: var(--accent-foreground);
    ```
- Brand-color callers using Tailwind `accent` utilities (`bg-accent`, `border-accent`, `hover:bg-accent-ink`, etc.):
  - `Header.tsx:100,107,115`, `TabBar.tsx:65`, `Thread.tsx:152`, `ModelPicker.tsx:215`, `Interactions.tsx:175,248,259,462,467`, `TaskRows.tsx:32,52`, `OverviewView.tsx:154,218,322`, `SchedulesView.tsx:283,502,581,597`, `TasksView.tsx:384`, `AppearanceSettings.tsx:188,235`, `SkillSettings.tsx:373,390,547,564`, `McpSettings.tsx:667,837,967`.
- `packages/webview-ui/src/components/ui/button.tsx:3`:
  ```tsx
  import { cn } from "cn"
  ```
- `packages/webview-ui/components.json:14-20`:
  ```json
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  }
  ```
- `AGENTS.md:27`:
  > 禁止硬编码颜色：`shadcn-ui` 语义变量已与 `beautifului-foundation.css` 的浅/深模式及 5 套配色方案（`slate` / `warm` / `forest` / `violet` / `rose`）打通，请使用语义主题类名，禁止写死固定色值（色卡预览数据除外）。

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `pnpm typecheck`         | exit 0, no errors   |
| Lint      | `pnpm lint`              | exit 0              |
| Tests     | `pnpm test`              | all pass            |
| Build     | `pnpm build`             | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `packages/webview-ui/src/styles/beautifului-foundation.css`
- `packages/webview-ui/src/components/ui/*.tsx` (only changing `import { cn } from "cn"` to `import { cn } from "@/lib/utils"`)
- Brand `bg-accent` / `border-accent` callers listed above (`Header.tsx`, `TabBar.tsx`, `Thread.tsx`, `ModelPicker.tsx`, `Interactions.tsx`, `beautifului/TaskRows.tsx`, `workbench/OverviewView.tsx`, `workbench/SchedulesView.tsx`, `workbench/TasksView.tsx`, `settings/AppearanceSettings.tsx`, `settings/SkillSettings.tsx`, `settings/McpSettings.tsx`)
- `packages/webview-ui/test/foundation-tokens.test.ts` (create)

**Out of scope** (do NOT touch, even though they look related):
- Replacing native `<input type="checkbox">` or hardcoded `text-white`/`bg-emerald-500` colors — handled in Plan 004.
- Adding new components manually to `src/components/ui/`.
- Changing `packages/webview-ui/package.json` dependencies unless `cn` is completely unused after Step 3 (leave `package.json` untouched to avoid lockfile drift).

## Git workflow

- Branch: `advisor/003-design-tokens-and-cn-unification`
- Commit per logical unit (e.g. `fix(ui): decouple shadcn accent surface from brand token and add ink-4`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add `--ink-4` across light and dark palettes and `@theme inline`

In `packages/webview-ui/src/styles/beautifului-foundation.css`:
1. In `:root` (around line 38), add `--ink-4: oklch(0.755 0.01 260);` (and optional subtle tint matching warm/forest/violet/rose schemes if appropriate, or keep neutral/theme-neutral fallback `--ink-4` in `:root` and `.dark` — e.g. in `.dark` around line 202 add `--ink-4: oklch(0.455 0.012 262);`, and subtle overrides in the 4 extra schemes if desired).
2. In `@theme inline` (around line 331), add `--color-ink-4: var(--ink-4);`.

**Verify**: `pnpm build` → exit 0; `grep -rn "color-ink-4" packages/webview-ui/src/styles/beautifului-foundation.css` finds the definition.

### Step 2: Separate shadcn's neutral hover `--color-accent` from BeautifulUI's brand `--color-brand`

In `packages/webview-ui/src/styles/beautifului-foundation.css`:
1. Keep CSS custom property `--accent` (and `--accent-ink`, `--accent-tint`) in all 5 light & dark schemes untouched so existing CSS (`beautifului-prose.css`, inline `var(--accent)` in `shadow-[0_0_0_1px_var(--accent)]`, etc.) keeps working with zero breakage.
2. In `:root` (lines 77–79) and `.dark`, define shadcn's semantic hover surface variables:
   - `--shadcn-accent: var(--hover);`
   - `--accent-foreground: var(--ink);` (instead of `#ffffff`!)
   - Also define `--brand: var(--accent);` and `--brand-foreground: var(--surface);` (or keep `--brand-foreground: #ffffff` for light, and high-contrast foreground for dark — note Plan 004 will refine dark-mode button foreground contrast).
3. In `@theme inline` (lines 338–340 & 384):
   - Change `--color-accent: var(--accent);` → `--color-accent: var(--shadcn-accent);` (so shadcn's `hover:bg-accent hover:text-accent-foreground` and `Skeleton`'s `bg-accent` use `--hover` + `--ink`!).
   - Add `--color-brand: var(--accent);` and `--color-brand-foreground: var(--brand-foreground);` (keep `--color-accent-ink: var(--accent-ink);` and `--color-accent-tint: var(--accent-tint);` unchanged because shadcn-ui never uses `accent-ink` or `accent-tint` — only bare `-accent` collides with shadcn!).
4. Run `grep -rn -E "(bg|text|border|ring)-accent([^A-Za-z0-9_-]|$)" packages/webview-ui/src/components/ --exclude-dir=ui` and update every intentional brand-accent Tailwind utility (`bg-accent`, `bg-accent/15`, `border-accent`, etc.) to `bg-brand`, `bg-brand/15`, `border-brand`. Leave `text-accent-ink` and `bg-accent-tint` unchanged.
   - **Important**: Do NOT change `src/components/ui/*.tsx` classes (`hover:bg-accent`, `focus:bg-accent`, `bg-accent`), because those are shadcn components expecting neutral surface hover!

**Verify**: `pnpm typecheck && pnpm lint && pnpm build` → exit 0; `grep -rn -E "(bg|border|ring)-accent([^A-Za-z0-9_-]|$)" packages/webview-ui/src/components/ --exclude-dir=ui` returns zero brand-color uses on `accent`.

### Step 3: Unify `cn()` import in `src/components/ui/*.tsx`

In every file under `packages/webview-ui/src/components/ui/*.tsx` that has `import { cn } from "cn"`:
- Replace with `import { cn } from "@/lib/utils"`.

**Verify**: `grep -rn 'from "cn"' packages/webview-ui/src/` returns no matches; `pnpm typecheck && pnpm lint && pnpm build` exits 0.

### Step 4: Add CSS token verification test

Create `packages/webview-ui/test/foundation-tokens.test.ts` (Node environment is fine) reading `packages/webview-ui/src/styles/beautifului-foundation.css` and verifying:
- `--color-ink-4` is defined in `@theme inline` and `--ink-4` in `:root` & `.dark`.
- `--color-accent` resolves to `var(--shadcn-accent)` (or `var(--hover)`) and `--accent-foreground` is `var(--ink)` (not `#ffffff`).
- `--color-brand` and `--color-brand-foreground` are defined in `@theme inline`, while `--color-accent-ink` and `--color-accent-tint` remain mapped to `--accent-ink` and `--accent-tint`.

**Verify**: `pnpm test` → all tests pass.

## Test plan

- `packages/webview-ui/test/foundation-tokens.test.ts`: verifies CSS token definitions and absence of `--accent` / `#ffffff` collision in `@theme inline`.
- Existing `packages/webview-ui/test/*.test.tsx` + `pnpm build` verify Vite + `@tailwindcss/vite` compiles all utilities cleanly.
- Verification: `pnpm typecheck && pnpm lint && pnpm test && pnpm build` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test` exits 0, including `foundation-tokens.test.ts`
- [ ] `pnpm build` exits 0
- [ ] `grep -rn 'from "cn"' packages/webview-ui/src/` returns 0 matches
- [ ] `grep -rn "text-ink-4" packages/webview-ui/src/` references a defined `--color-ink-4` token in `beautifului-foundation.css`
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Grep reveals a `beautifului` or `settings` component using `accent` inside dynamic template strings that would be broken by switching to `brand`.
- Tailwind CSS build (`pnpm build`) reports unknown utility classes or CSS parse errors.
- Any `src/components/ui/*.tsx` fails `pnpm typecheck` after switching `cn` to `@/lib/utils`.

## Maintenance notes

- Whenever adding a new shadcn component via `pnpm dlx shadcn@latest add -c packages/webview-ui <component>`, update its `import { cn } from "cn"` (if emitted by shadcn CLI) to `import { cn } from "@/lib/utils"`, and verify no brand color expects `bg-accent` (use `bg-brand`, `text-brand-ink`, `bg-brand-tint` for brand accent).
