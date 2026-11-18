# Plan 004: Enforce AGENTS.md UI library compliance & fix dark-mode primary button contrast

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c77c19e..HEAD -- packages/webview-ui/src/components/settings/SkillSettings.tsx packages/webview-ui/src/components/settings/McpSettings.tsx packages/webview-ui/src/components/Items.tsx packages/webview-ui/src/components/Interactions.tsx packages/webview-ui/src/components/SubagentRow.tsx packages/webview-ui/src/components/beautifului/TaskRows.tsx packages/webview-ui/src/components/workbench/TasksView.tsx packages/webview-ui/src/components/workbench/SchedulesView.tsx packages/webview-ui/src/components/Header.tsx packages/webview-ui/src/components/settings/AppearanceSettings.tsx packages/webview-ui/src/components/ModelPicker.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: `plans/003-design-tokens-and-cn-unification.md`
- **Category**: tech-debt
- **Planned at**: commit `c77c19e`, 2026-11-18

## Why this matters

`AGENTS.md` mandates that `packages/webview-ui` only uses `shadcn-ui` for standard form controls and never hardcodes color values (`禁止硬编码颜色`). Currently:
1. `SkillSettings` and `McpSettings` use native `<input type="checkbox">` instead of shadcn `<Checkbox>`, while `Items` (`QueueEditor`) and `Interactions` (`QuestionCard`) use raw `<textarea>`/`<input>` instead of shadcn `<Textarea>`/`<Input>`.
2. `TasksView` and `SchedulesView` use hardcoded `bg-emerald-500` instead of semantic `bg-green`.
3. `Interactions` (`ApprovalCard`, `PlanReviewCard`, `QuestionCard`), `SubagentRow`, `TaskRows`, `Header`, and `AppearanceSettings` use hardcoded `text-white` over `bg-brand` / `bg-green` / `bg-red` / `bg-orange`. In dark mode, `--accent` (renamed `--brand` in Plan 003) rises to lightness `oklch(0.69–0.715)`, making white text fail WCAG contrast (~2.5:1–3.5:1). Using semantic foreground tokens (e.g. `oklch` high-contrast foreground or `bg-primary text-primary-foreground` / `--brand-foreground`) restores legibility across all 5 light & dark schemes.

## Current state

- `AGENTS.md:9-27`:
  > 1. 通用基础控件统一使用 `shadcn-ui` ...（`Input`、`Textarea`、`Checkbox`...）
  > - 禁止硬编码颜色：`shadcn-ui` 语义变量已与 `beautifului-foundation.css` 的浅/深模式及 5 套配色方案（`slate` / `warm` / `forest` / `violet` / `rose`）打通，请使用语义主题类名，禁止写死固定色值（色卡预览数据除外）。
- Native checkbox sites:
  - `packages/webview-ui/src/components/settings/SkillSettings.tsx:330-335`: `<input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={checked} onChange={() => toggleDiscoveredSubpath(item.subpath)} />`
  - `packages/webview-ui/src/components/settings/McpSettings.tsx:790-796`: `<input type="checkbox" data-testid={`mcp-candidate-check-${item.name}`} className="mt-0.5 accent-[var(--accent)]" checked={checked} onChange={() => toggleCandidate(item.key)} />`
  - Exemplar usage: `AgentsView.tsx:303-306` and `ProviderSettings.tsx:888-893` use `<Checkbox checked={...} onCheckedChange={(checked) => ...} />` from `@/components/ui/checkbox`.
- Raw input/textarea sites:
  - `packages/webview-ui/src/components/Items.tsx:248-263`: `<textarea className="queue-editor w-full resize-y rounded-[12px] border border-line-strong bg-surface px-3 py-2 text-[13.5px] text-ink shadow-card outline-none focus:border-accent" ... />` (keep `queue-editor` class and `aria-label={t('queue.editLabel')}` because `ui-e2e.ts:679` queries `getByRole('textbox', { name: '编辑排队的消息' })`).
  - `packages/webview-ui/src/components/Interactions.tsx:435-445`: `<input className="question__custom ..." ... />` (keep `question__custom` class and `aria-label`).
- Hardcoded colors:
  - `TasksView.tsx:387`: `'bg-emerald-500'`
  - `SchedulesView.tsx:584`: `'bg-emerald-500'`
  - `Header.tsx:99`: `text-white`
  - `Interactions.tsx:175, 248, 259, 462, 467`: `bg-brand text-white hover:bg-accent-ink` (previously `bg-accent text-white hover:bg-accent-ink`)
  - `SubagentRow.tsx:81, 85`: `bg-red text-white` / `bg-green text-white`
  - `TaskRows.tsx:100`: `bg-green text-white`
  - `AppearanceSettings.tsx:188, 235`: `bg-brand text-white` (previously `bg-accent text-white`)
  - `ModelPicker.tsx:233, 235`: `bg-white`, `ring-black/10`, `bg-white/70`

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `pnpm typecheck`         | exit 0, no errors   |
| Lint      | `pnpm lint`              | exit 0              |
| Tests     | `pnpm test`              | all pass            |
| Build     | `pnpm build`             | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `packages/webview-ui/src/styles/beautifului-foundation.css` (only `--brand-foreground` / semantic solid-badge foreground tokens)
- `packages/webview-ui/src/components/settings/SkillSettings.tsx`
- `packages/webview-ui/src/components/settings/McpSettings.tsx`
- `packages/webview-ui/src/components/Items.tsx`
- `packages/webview-ui/src/components/Interactions.tsx`
- `packages/webview-ui/src/components/SubagentRow.tsx`
- `packages/webview-ui/src/components/beautifului/TaskRows.tsx`
- `packages/webview-ui/src/components/workbench/TasksView.tsx`
- `packages/webview-ui/src/components/workbench/SchedulesView.tsx`
- `packages/webview-ui/src/components/Header.tsx`
- `packages/webview-ui/src/components/settings/AppearanceSettings.tsx`
- `packages/webview-ui/src/components/ModelPicker.tsx`
- `packages/webview-ui/test/ui-compliance.test.tsx` (create)

**Out of scope** (do NOT touch, even though they look related):
- `packages/webview-ui/src/theme.ts` (`COLOR_SCHEME_SWATCHES` preview hexes — explicitly exempted by `AGENTS.md`).
- `packages/webview-ui/src/components/BackendLogo.tsx` (`bg-white` tile for dark brand SVG marks) & `HarnessDeckLogo.tsx` (SVG illustration).
- `packages/webview-ui/src/components/Composer.tsx` main auto-sizing `textarea.composer__input` (its custom `scrollHeight` measurement + borderless prompt-bar styling is part of the `beautifului` Composer design).
- `packages/webview-ui/src/components/ProviderSettings.tsx` card selection border style (unless part of Plan 008).

## Git workflow

- Branch: `advisor/004-agents-md-ui-and-contrast-compliance`
- Commit per logical unit (e.g. `refactor(ui): use shadcn controls and semantic tokens per AGENTS.md`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Define high-contrast semantic foreground token for solid brand/status fills

In `packages/webview-ui/src/styles/beautifului-foundation.css`:
1. Ensure `--brand-foreground` (and `--color-brand-foreground` in `@theme inline`) has high contrast in BOTH modes:
   - Light mode (`:root`): `--brand-foreground: var(--surface);` (white on medium-dark `0.56–0.58` lightness `--accent`, >4.5:1 contrast).
   - Dark mode (`.dark`): `--brand-foreground: var(--page);` (dark ink on bright `0.69–0.715` lightness `--accent`, >6:1 contrast) — OR keep `--brand-solid` darker in dark mode (`oklch(0.54 0.16 253)`) with white text. Choosing `--brand-foreground: var(--page)` in `.dark` (matching shadcn's `--primary: var(--ink); --primary-foreground: var(--canvas);` pattern!) keeps `--accent` crisp and guarantees high contrast across all 5 palettes (`slate`, `warm`, `forest`, `violet`, `rose`) without inventing extra per-scheme colors.
   - Similarly define `--solid-status-foreground: var(--surface)` in `:root` and `var(--page)` in `.dark` (or use `text-canvas` / `text-brand-foreground` consistently on solid `bg-green`/`bg-red`/`bg-orange` badges/dots).

**Verify**: `pnpm build` → exit 0.

### Step 2: Replace native checkboxes and raw inputs in `SkillSettings`, `McpSettings`, `Items`, `Interactions`

1. In `SkillSettings.tsx`: import `{ Checkbox } from '@/components/ui/checkbox'` and replace lines 330–335 `<input type="checkbox" ... />` with `<Checkbox className="mt-0.5" checked={checked} onCheckedChange={() => toggleDiscoveredSubpath(item.subpath)} />`.
2. In `McpSettings.tsx`: import `{ Checkbox } from '@/components/ui/checkbox'` and replace lines 790–796 `<input type="checkbox" ... />` with `<Checkbox data-testid={`mcp-candidate-check-${item.name}`} className="mt-0.5" checked={checked} onCheckedChange={() => toggleCandidate(item.key)} />`.
3. In `Items.tsx` (`QueueEditor`, line 248): import `{ Textarea } from '@/components/ui/textarea'` and replace `<textarea className="queue-editor ..." ... />` with `<Textarea className="queue-editor min-h-0 resize-y rounded-[12px] bg-surface text-[13.5px] shadow-card" ... />` (preserve `value`, `autoFocus`, `rows`, `aria-label`, `onChange`, `onKeyDown`).
4. In `Interactions.tsx` (`QuestionCard`, line 434–446): import `{ Input } from '@/components/ui/input'` or wrap cleanly with `Input` styled borderless (`border-0 bg-transparent shadow-none focus-visible:ring-0`) while keeping `question__custom` class, `aria-label`, `placeholder`, `value`, `onChange`, `onKeyDown`.

**Verify**: `pnpm typecheck && pnpm lint` → exit 0.

### Step 3: Replace hardcoded color classes with semantic tokens

1. `TasksView.tsx:387` and `SchedulesView.tsx:584`: replace `'bg-emerald-500'` with `'bg-green'`.
2. `Interactions.tsx:175, 248, 259, 462, 467`: replace `bg-brand text-white hover:bg-accent-ink` with `bg-brand text-brand-foreground hover:opacity-90` (works cleanly in both light and dark modes with `text-brand-foreground`).
3. `Header.tsx:99`, `SubagentRow.tsx:81, 85`, `TaskRows.tsx:100`, `AppearanceSettings.tsx:188, 235`: replace `text-white` with `text-brand-foreground` (or `text-canvas` on `bg-green`/`bg-red`/`bg-orange` where appropriate so dark mode stays crisp).
4. `ModelPicker.tsx:233, 235`: replace `bg-white shadow-md ring-1 ring-black/10` with `bg-surface shadow-raised ring-1 ring-line-strong`, and `bg-white/70` with `bg-surface/80`.

**Verify**: `grep -rn -E "bg-emerald-|text-white|bg-white\b|ring-black" packages/webview-ui/src/components/ --exclude="BackendLogo.tsx" --exclude="HarnessDeckLogo.tsx"` returns zero matches; `pnpm typecheck && pnpm lint && pnpm build` exits 0.

### Step 4: Add compliance & component tests

Create `packages/webview-ui/test/ui-compliance.test.tsx`:
- Render `SkillSettings` and `McpSettings` import/install dialogs with mock candidates and assert `[data-slot="checkbox"]` (`role="checkbox"`) toggles selection on click.
- Render `ApprovalCard` and assert the primary Allow button uses `text-brand-foreground` (no hardcoded `text-white`).

**Verify**: `pnpm test` → all tests pass.

## Test plan

- `packages/webview-ui/test/ui-compliance.test.tsx`:
  - `SkillSettings` discovered skill checkbox uses shadcn `Checkbox` (`role="checkbox"`) and toggles.
  - `McpSettings` import candidate checkbox (`data-testid="mcp-candidate-check-..."`) uses shadcn `Checkbox` and toggles.
  - `QueueEditor` renders `textbox` with `aria-label` preserved.
- Verification: `pnpm typecheck && pnpm lint && pnpm test && pnpm build` → exit 0.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test` exits 0, including `ui-compliance.test.tsx`
- [ ] `pnpm build` exits 0
- [ ] `grep -rn '<input[^>]*type="checkbox"' packages/webview-ui/src/` returns 0 matches
- [ ] `grep -rn -E "bg-emerald-|text-white|bg-white\b|ring-black" packages/webview-ui/src/components/ --exclude="BackendLogo.tsx" --exclude="HarnessDeckLogo.tsx"` returns 0 matches
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any file in the Drift check changed and the excerpts above no longer match.
- `pnpm lint` rejects an import or prop shape on `Checkbox` / `Textarea` / `Input`.
- Replacing `<textarea>` in `QueueEditor` changes its `role="textbox"` accessible name or `queue-editor` class used by `ui-e2e.ts:679`.

## Maintenance notes

- Keep `BackendLogo.tsx` (`bg-white` tile) and `theme.ts` (`COLOR_SCHEME_SWATCHES`) untouched as intentional visual data exceptions noted in `AGENTS.md`.
