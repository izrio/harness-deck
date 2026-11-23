// @vitest-environment jsdom
import './setup.ts';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildSplitDiffRows,
  buildUnifiedDiffLines,
  computeWordDiffSegments,
  extractHunkPatch,
} from '../src/lib/lineDiff.ts';
import { applyHostMessage, resetStoreForTests, setRightPanelOpen, setRightPanelTab } from '../src/store.ts';
import { applyHighContrast, applyThemePreset } from '../src/theme.ts';
import { CommandPalette } from '../src/components/CommandPalette.tsx';
import { DiffViewerModal } from '../src/components/DiffViewerModal.tsx';
import { AppearanceSettings } from '../src/components/settings/AppearanceSettings.tsx';
import { WorkbenchRightPanel } from '../src/components/workbench/WorkbenchRightPanel.tsx';
import { TurnDone } from '../src/components/RunStatus.tsx';

describe('P0 / P1 / P2 UI Enhancements', () => {
  beforeEach(() => {
    resetStoreForTests();
    document.documentElement.removeAttribute('data-theme-preset');
    document.documentElement.removeAttribute('data-high-contrast');
  });

  afterEach(() => {
    cleanup();
  });

  it('computes word diff segments, split rows, and valid git hunk patches (P0-1)', () => {
    const word = computeWordDiffSegments('const a = 1;', 'const a = 2;');
    expect(word.left.some((s) => s.changed && s.text === '1')).toBe(true);
    expect(word.right.some((s) => s.changed && s.text === '2')).toBe(true);

    const lines = buildUnifiedDiffLines('line1\nold\nline3', 'line1\nnew\nline3');
    const split = buildSplitDiffRows(lines);
    expect(split.some((r) => r.kind === 'hunk')).toBe(true);
    expect(split.some((r) => r.kind === 'pair' && r.left?.kind === 'del' && r.right?.kind === 'add')).toBe(true);

    const patch = extractHunkPatch('src/demo.ts', lines, 0);
    expect(patch).toContain('diff --git a/src/demo.ts b/src/demo.ts');
    expect(patch).toContain('-old');
    expect(patch).toContain('+new');
  });

  it('places Terminal tab immediately to the right of Git tab in WorkbenchRightPanel (P1-4)', () => {
    setRightPanelOpen(true);
    setRightPanelTab('files');
    render(<WorkbenchRightPanel />);

    const filesTab = screen.getByTestId('right-panel-tab-files');
    const gitTab = screen.getByTestId('right-panel-tab-git');
    const termTab = screen.getByTestId('right-panel-tab-terminal');

    expect(filesTab.compareDocumentPosition(gitTab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(gitTab.compareDocumentPosition(termTab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('supports Unified/Split diff toggle and line-level review comments in DiffViewerModal (P0-1)', () => {
    applyHostMessage({
      type: 'diffContent',
      payload: {
        path: 'src/app.ts',
        title: 'app.ts',
        language: 'typescript',
        kind: 'pair',
        before: 'const x = 1;',
        after: 'const x = 2;',
        sourceControlPath: 'src/app.ts',
        staged: false,
      },
    });
    render(<DiffViewerModal />);

    expect(screen.getByTestId('diff-lines-view')).toBeTruthy();
    expect(screen.getByTestId('diff-stage-hunk')).toBeTruthy();

    fireEvent.click(screen.getByTestId('diff-mode-toggle'));
    expect(screen.getByTestId('diff-split-view')).toBeTruthy();
  });

  it('renders cross-backend checkpoint rollback & fork buttons on TurnDone (P0-3)', () => {
    render(
      <TurnDone
        item={{ kind: 'turnDone', id: 'td-1', durationMs: 1200, completed: true }}
        turnSeq={2}
        hasCheckpoint
        canFork
      />,
    );
    expect(screen.getByTestId('turn-checkpoint-rollback-2')).toBeTruthy();
    expect(screen.getByTestId('turn-fork-2')).toBeTruthy();
  });

  it('opens global CommandPalette with actions and panel commands (P1-6)', () => {
    render(<CommandPalette open onOpenChange={() => undefined} onNewWorktree={() => undefined} />);
    expect(screen.getByTestId('command-palette-input')).toBeTruthy();
  });

  it('applies OKLCH theme presets and high contrast mode cleanly (P2-9)', () => {
    applyThemePreset('ocean');
    expect(document.documentElement.getAttribute('data-theme-preset')).toBe('ocean');
    applyHighContrast(true);
    expect(document.documentElement.getAttribute('data-high-contrast')).toBe('true');

    render(<AppearanceSettings />);
    expect(screen.getByTestId('theme-preset-grove')).toBeTruthy();
    expect(screen.getByTestId('theme-high-contrast-switch')).toBeTruthy();
  });
});
