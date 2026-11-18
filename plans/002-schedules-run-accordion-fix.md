# Plan 002: Fix SchedulesView latest run permanently stuck open and cross-rule expansion state

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c77c19e..HEAD -- packages/webview-ui/src/components/workbench/SchedulesView.tsx`
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

In `SchedulesView`, the first/latest run of every schedule rule (`rule.runs[0]`) is intended to start expanded for convenience, yet the current expression `expandedRunId === run.id || rule.runs[0]?.id === run.id` makes `isRunOpen` permanently `true` for `rule.runs[0]`. Users can never collapse a rule's latest run, clicking a second run keeps both open, and `expandedRunId` is shared across rules instead of scoped per rule. Fixing this makes the schedule history accordion predictable and independently collapsible.

## Current state

- `packages/webview-ui/src/components/workbench/SchedulesView.tsx:107-109`:
  ```tsx
  const [editingId, setEditingId] = useState<string | undefined>();
  const [expandedRuleId, setExpandedRuleId] = useState<string | undefined>(inspectRuleId);
  const [expandedRunId, setExpandedRunId] = useState<string | undefined>();
  ```
- `packages/webview-ui/src/components/workbench/SchedulesView.tsx:554-575`:
  ```tsx
  <div className="flex flex-col gap-2">
    {rule.runs.map((run) => {
      const isRunOpen = expandedRunId === run.id || rule.runs[0]?.id === run.id;
      return (
        <div
          key={run.id}
          className="overflow-hidden rounded-control border border-line bg-surface"
          data-testid={`schedule-run-${run.id}`}
        >
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-hover"
            onClick={() => {
              setExpandedRunId(expandedRunId === run.id ? '__none__' : run.id);
              if (run.unread) {
                postToHost({
                  type: 'markScheduleRunRead',
                  payload: { ruleId: rule.id, runId: run.id },
                });
              }
            }}
          >
  ```
- Conventions: `SchedulesView.tsx` uses `useState` with `Record<string, ...>` for keyed per-item UI state (compare `SessionsView.tsx:64`: `useState<Record<string, boolean>>({})`).

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `pnpm typecheck`         | exit 0, no errors   |
| Lint      | `pnpm lint`              | exit 0              |
| Tests     | `pnpm test`              | all pass            |
| Build     | `pnpm build`             | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `packages/webview-ui/src/components/workbench/SchedulesView.tsx`
- `packages/webview-ui/test/schedules-view.test.tsx` (create)

**Out of scope** (do NOT touch, even though they look related):
- `packages/extension/**` — schedule execution/storage logic.
- Other files under `packages/webview-ui/src/components/workbench/`.

## Git workflow

- Branch: `advisor/002-schedules-run-accordion-fix`
- Commit per logical unit (e.g. `fix(ui): allow collapsing latest schedule run independently per rule`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Scope expanded run state per rule and support collapsing `rule.runs[0]`

In `packages/webview-ui/src/components/workbench/SchedulesView.tsx`:
1. Replace `const [expandedRunId, setExpandedRunId] = useState<string | undefined>();` with per-rule map state:
   ```tsx
   const [expandedRunsByRule, setExpandedRunsByRule] = useState<Record<string, string | null>>({});
   ```
   Semantics for `expandedRunsByRule[rule.id]`:
   - `undefined` (never toggled by user): default to `rule.runs[0]?.id` (latest run opens by default).
   - `string` (a `run.id`): that specific run is open.
   - `null`: user explicitly collapsed the currently open run, so all runs for this rule are closed.
2. In the `rule.runs.map` loop (around line 555):
   - Compute `const activeRunId = expandedRunsByRule[rule.id] === undefined ? rule.runs[0]?.id : expandedRunsByRule[rule.id];`
   - Compute `const isRunOpen = activeRunId === run.id;`
   - Also set `aria-expanded={isRunOpen}` on the toggle `<button>` (line 563) for accessibility.
   - In `onClick`:
     ```tsx
     setExpandedRunsByRule((prev) => ({
       ...prev,
       [rule.id]: isRunOpen ? null : run.id,
     }));
     ```
3. When clicking "Run Now" (`schedule-run-now-${rule.id}`, line 511), clear any explicit `null` override for that rule (`setExpandedRunsByRule((prev) => { const next = { ...prev }; delete next[rule.id]; return next; })`) so the new latest run opens automatically.

**Verify**: `pnpm typecheck && pnpm lint` → exit 0.

### Step 2: Add component regression tests

Create `packages/webview-ui/test/schedules-view.test.tsx` following `packages/webview-ui/test/app-smoke.test.tsx`:
- Seed `workbench.schedules` via `applyHostMessage({ type: 'snapshot', payload: ... })` with two rules, the first having two runs (`run-latest` and `run-older`, both with `output` markdown).
- Expand `schedule-history-toggle-<ruleId>`.
- Assert `run-latest` output is initially visible and its toggle has `aria-expanded="true"`, while `run-older` is collapsed (`aria-expanded="false"`).
- Click `run-latest` toggle and assert its output is hidden and `aria-expanded="false"` (verifies the fix).
- Click `run-older` toggle and assert `run-older` opens while `run-latest` stays closed.
- Click `run-older` toggle again and assert both are closed.

**Verify**: `pnpm test` → all tests including `schedules-view.test.tsx` pass.

## Test plan

- New file `packages/webview-ui/test/schedules-view.test.tsx` covering:
  - Latest run starts open by default.
  - Latest run can be collapsed by clicking its header.
  - Expanding an older run switches the active run without reopening the latest run.
  - Expanding/collapsing runs in Rule A does not alter Rule B's run state.
  - Clicking unread run still emits `markScheduleRunRead`.
- Verification: `pnpm test && pnpm typecheck && pnpm lint && pnpm build` → exit 0.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test` exits 0, including `packages/webview-ui/test/schedules-view.test.tsx`
- [ ] `pnpm build` exits 0
- [ ] No `rule.runs[0]?.id === run.id` forced-open condition remains in `SchedulesView.tsx`
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `SchedulesView.tsx` lines 107–109 or 554–575 do not match the excerpts above.
- Any E2E selector expectation in `packages/extension/scripts/ui-e2e.ts` relies on `schedule-run-*` DOM behavior that conflicts with collapsing `runs[0]`.

## Maintenance notes

- If multiple runs should ever be expandable simultaneously in the future, change `Record<string, string | null>` to `Record<string, ReadonlySet<string>>` without changing the `aria-expanded` contract.
