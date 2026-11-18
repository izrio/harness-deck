# Plan 008: Deduplicate shared workbench/settings logic and split oversized UI modules

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c77c19e..HEAD -- packages/webview-ui/src/components/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: MED
- **Depends on**: `plans/001-webview-jsdom-test-baseline.md`, `plans/003-design-tokens-and-cn-unification.md`, `plans/004-agents-md-ui-and-contrast-compliance.md`, `plans/007-streaming-memo-and-toasts-stability.md`
- **Category**: tech-debt
- **Planned at**: commit `c77c19e`, 2026-11-18

## Why this matters

Several non-trivial patterns are duplicated verbatim across multiple UI files, and six component files exceed [DESIGN.md](file:///home/izrio/project/harness-deck/docs/DESIGN.md#L100)'s 500-line guideline (`ProviderSettings.tsx` 1380 lines, `McpSettings.tsx` 989 lines, `Items.tsx` 779 lines, `AgentSettings.tsx` 674 lines, `SchedulesView.tsx` 668 lines, `TasksView.tsx` 667 lines). Consolidating shared hooks/UI primitives (`useProjectOptions`, `useMergedModels`, `FALLBACK_BACKENDS`, `NumberStepper`, `CollapsibleDrawer`) and splitting monolithic settings/item views into focused <500-line modules eliminates lockstep edits and improves readability without altering any external selectors or behavior.

## Current state

- **Duplicated derivations**:
  - `projectOptions` (`projects.currentPath` + `projects.recent` Map deduplication):
    - `AgentsView.tsx:66-76`
    - `SchedulesView.tsx:135-145`
    - `TasksView.tsx:81-94`
  - `mergedModels` (`providers` ordered by `boundBackendIds` + `models.options` deduplication):
    - `AgentsView.tsx:78-100`
    - `TasksView.tsx:96-118`
  - `FALLBACK_BACKENDS`:
    - `SkillSettings.tsx:36-43`
    - `McpSettings.tsx:37-44`
- **Duplicated UI sub-structures**:
  - Stepper `ButtonGroup` (`-` / `ButtonGroupText` / `+` + default `ValuePill`): 4× in `AppearancePanel.tsx:163-313` and 2× in `AppearanceSettings.tsx:294-356`.
  - Smooth CSS-grid accordion drawer (`grid transition-[grid-template-rows,opacity] duration-300`): `Items.tsx:385-399`, `Items.tsx:475-490`, `Items.tsx:555-570`, `Items.tsx:635-684`, `SubagentRow.tsx:120-166`, `StatusDock.tsx:69-92`, plus inline chevron SVG in `Items.tsx:446-463, 525-543, 611-628`.
- **Oversized files (>500 lines)** (line counts at commit `c77c19e`):
  - `ProviderSettings.tsx`: 1380 lines (`ProviderSettings`, `GatewayLogsDialog`, `SavedProviderCard`, model table editor, parsing helpers)
  - `McpSettings.tsx`: 989 lines (`McpSettings`, JSON/arg/KV parsers, `McpFormDialog`, `McpImportDialog`, `McpServerCard`)
  - `Items.tsx`: 779 lines (`ItemView`, `UserBubble`/`QueueEditor`, `AssistantMessage`/`Reasoning`, `ActivityRow`/`EditRow`/`ExploreRow`, `ChangesCard`, `Notice`)
  - `AgentSettings.tsx`: 674 lines (`AgentSettings`, `NodeEnvBanner`, `BackendCard`, ACP agent dialog)
  - `SchedulesView.tsx`: 668 lines (`SchedulesView`, `TEMPLATES`, schedule form, rule card + run history)
  - `TasksView.tsx`: 667 lines (`TasksView`, task create modal, kanban column + task card)
- **Important E2E selector contract**: `packages/extension/scripts/ui-e2e.ts` queries exact `data-testid`s and CSS class names (`.user__bubble`, `.activity__row`, `.activity__detail`, `.activity__output`, `.activity--edit`, `.explore__entry`, `.changes__file`, `.changes__header`, `.changes__note`, `.queue-editor`, `.tab--active`, etc.). All class names and `data-testid` attributes MUST remain identical.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `pnpm typecheck`         | exit 0, no errors   |
| Lint      | `pnpm lint`              | exit 0              |
| Tests     | `pnpm test`              | all pass            |
| Build     | `pnpm build`             | exit 0              |

## Scope

**In scope** (the only files you should create or modify):
- `packages/webview-ui/src/lib/workbenchOptions.ts` (create — `getProjectOptions`, `getMergedModels`, `FALLBACK_BACKENDS`)
- `packages/webview-ui/src/components/NumberStepper.tsx` (create — shared `ButtonGroup` stepper row composing `shadcn-ui` `Button` + `ButtonGroup` + `ValuePill`)
- `packages/webview-ui/src/components/beautifului/CollapsibleDrawer.tsx` (create — or export from `beautifului/index.ts`, encapsulating the CSS-grid smooth accordion wrapper)
- `packages/webview-ui/src/components/beautifului/index.ts`
- `packages/webview-ui/src/components/AppearancePanel.tsx`
- `packages/webview-ui/src/components/settings/AppearanceSettings.tsx`
- `packages/webview-ui/src/components/settings/SkillSettings.tsx`
- `packages/webview-ui/src/components/settings/McpSettings.tsx` + split subfiles under `packages/webview-ui/src/components/settings/mcp/`
- `packages/webview-ui/src/components/settings/ProviderSettings.tsx` + split subfiles under `packages/webview-ui/src/components/settings/providers/`
- `packages/webview-ui/src/components/settings/AgentSettings.tsx` + split subfiles under `packages/webview-ui/src/components/settings/agents/`
- `packages/webview-ui/src/components/Items.tsx` + split subfiles under `packages/webview-ui/src/components/items/`
- `packages/webview-ui/src/components/SubagentRow.tsx`
- `packages/webview-ui/src/components/StatusDock.tsx`
- `packages/webview-ui/src/components/workbench/AgentsView.tsx`
- `packages/webview-ui/src/components/workbench/SchedulesView.tsx` + split subfiles under `packages/webview-ui/src/components/workbench/schedules/`
- `packages/webview-ui/src/components/workbench/TasksView.tsx` + split subfiles under `packages/webview-ui/src/components/workbench/tasks/`
- `packages/webview-ui/test/workbench-options.test.ts` (create)

**Out of scope** (do NOT touch, even though they look related):
- `packages/webview-ui/src/components/ui/**` — never add non-shadcn files under `src/components/ui/`.
- `packages/extension/**` & `packages/shared/**`.

## Git workflow

- Branch: `advisor/008-ui-dedup-and-module-split`
- Commit per logical step (1 commit for shared helpers/primitives, 1 commit per split area) so diffs remain reviewable.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extract `workbenchOptions.ts` (`getProjectOptions`, `getMergedModels`, `FALLBACK_BACKENDS`)

1. Create `packages/webview-ui/src/lib/workbenchOptions.ts` with pure helper functions `getProjectOptions(projects)`, `getMergedModels(backendId, providers, models)`, and `FALLBACK_BACKENDS`.
2. Replace the duplicated blocks in `AgentsView.tsx`, `SchedulesView.tsx`, `TasksView.tsx`, `SkillSettings.tsx`, and `McpSettings.tsx`.
3. Add `packages/webview-ui/test/workbench-options.test.ts` testing deduplication, ordering (`boundBackendIds` first), and fallback behavior.

**Verify**: `pnpm typecheck && pnpm lint && pnpm test` → exit 0.

### Step 2: Extract `NumberStepper` and `CollapsibleDrawer`

1. Create `packages/webview-ui/src/components/NumberStepper.tsx` composing `shadcn-ui` `Button` / `ButtonGroup` / `ButtonGroupText` and `ValuePill` (per `AGENTS.md`: business layout composition only, no new custom base control). Use it in `AppearancePanel.tsx` (4 steppers) and `AppearanceSettings.tsx` (2 steppers), preserving every `data-testid` and `aria-label`.
2. Create `packages/webview-ui/src/components/beautifului/CollapsibleDrawer.tsx` (exported via `beautifului/index.ts`) for the `grid-template-rows` smooth accordion wrapper and use it in `Items.tsx`, `SubagentRow.tsx`, and `StatusDock.tsx`, and reuse `ChevronDownIcon` instead of inline chevron `<svg>` copies in `Items.tsx`.

**Verify**: `pnpm typecheck && pnpm lint && pnpm test && pnpm build` → exit 0.

### Step 3: Split oversized settings modules (`ProviderSettings`, `McpSettings`, `AgentSettings`)

Split each >500-line settings file into pure helpers + focused sub-components under `settings/{providers,mcp,agents}/` so every resulting file is `< 500` lines:
- `ProviderSettings.tsx` → `settings/providers/providerEditor.ts` (state/model row helpers), `ProviderEditorForm.tsx`, `SavedProviderCard.tsx`, `GatewayLogsDialog.tsx`.
- `McpSettings.tsx` → `settings/mcp/mcpParsers.ts` (JSON paste + arg/KV parsing), `McpFormDialog.tsx`, `McpImportDialog.tsx`, `McpServerCard.tsx`.
- `AgentSettings.tsx` → `settings/agents/BackendCard.tsx`, `NodeEnvBanner.tsx`, `AgentProfileDialog.tsx`.

Keep all `data-testid`s, `aria-label`s, and CSS classes unchanged.

**Verify**: `pnpm typecheck && pnpm lint && pnpm test && pnpm build` → exit 0.

### Step 4: Split oversized thread/workbench modules (`Items`, `SchedulesView`, `TasksView`)

Split each remaining >500-line file into `< 500`-line sub-components while keeping public exports (`ItemView`, `ChangedFileButton`, `Stats`, `openDiff`, `useDiffOpening` from `Items.tsx`) intact:
- `Items.tsx` → `items/UserBubble.tsx` (with `QueueEditor`, `QueuedMeta`), `items/ActivityRows.tsx` (`ActivityRow`, `EditRow`, `ExploreRow`), `items/ChangesCard.tsx` (`ChangesCard`, `ChangedFileButton`, `Stats`), `items/AssistantMessage.tsx`.
- `SchedulesView.tsx` → `workbench/schedules/ScheduleForm.tsx`, `workbench/schedules/ScheduleRuleCard.tsx`, `workbench/schedules/scheduleTemplates.ts`.
- `TasksView.tsx` → `workbench/tasks/TaskCreateDialog.tsx`, `workbench/tasks/TaskCard.tsx`.

**Verify**: `pnpm typecheck && pnpm lint && pnpm test && pnpm build` → exit 0, and `wc -l` on every `.ts`/`.tsx` under `packages/webview-ui/src/components/` (except `ui/sidebar.tsx` shadcn vendor file) is `< 500`.

## Test plan

- `packages/webview-ui/test/workbench-options.test.ts`: covers `getProjectOptions` (current workspace priority + recent dedup) and `getMergedModels` (provider binding priority + `models.options` dedup).
- All existing tests (`i18n.test.ts`, `store.test.ts`, `app-smoke.test.tsx`, `schedules-view.test.tsx`, `ui-compliance.test.tsx`, `keyboard-and-a11y.test.tsx`, `composer-and-interactions.test.tsx`, `memo-and-toasts.test.tsx`) must continue to pass unchanged.
- Verification: `pnpm typecheck && pnpm lint && pnpm test && pnpm build` → exit 0.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test` exits 0, including `workbench-options.test.ts`
- [ ] `pnpm build` exits 0
- [ ] Every file in `packages/webview-ui/src/components/{.,settings,workbench,items}/**/*.{ts,tsx}` (excluding `components/ui/sidebar.tsx`) is under 500 lines
- [ ] No duplicate `FALLBACK_BACKENDS` or `projectOptions` blocks remain in `src/components/`
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any `data-testid` or CSS class referenced by `packages/extension/scripts/ui-e2e.ts` would need to change during extraction.
- Circular imports arise between `Items.tsx` and `StatusDock.tsx` (break via a shared `items/ChangesCard.tsx` import).

## Maintenance notes

- New settings tabs or workbench views should import `getProjectOptions` / `getMergedModels` from `@/lib/workbenchOptions` instead of writing inline `Map` deduplication.
- Enforce the 500-line ceiling from `docs/DESIGN.md` during PR review when adding new forms or cards.
