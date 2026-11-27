// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { SourceControlCommitView, SourceControlState } from '@harness-deck/shared';
import { ChangesView } from '../src/components/workbench/ChangesView.tsx';
import { buildBranchFolderTree, computeCommitGraph, groupRefLabels } from '../src/components/workbench/git/gitHelpers.ts';
import { applyHostMessage, resetStoreForTests } from '../src/store.ts';
import { makeSnapshot, mockVsCodeApi } from './setup.ts';

const vscode = mockVsCodeApi();

function hydrateSourceControl(sourceControl: SourceControlState): void {
  act(() => {
    applyHostMessage({
      type: 'snapshot',
      payload: makeSnapshot({
        workbench: {
          overview: { waiting: [], todos: [], running: [], upcoming: [], unread: [] },
          schedules: [],
          agents: [],
          tasks: { items: [], autoRun: true },
          sessionGroups: [],
          sourceControl,
        },
      }),
    });
  });
}

beforeEach(() => {
  vscode.reset();
  resetStoreForTests();
});

describe('GitWorkbench（IDEA 风格 Git 工作台）', () => {
  it('computeCommitGraph 正确分配多分支合并 DAG 泳道与 HEAD 节点', () => {
    const commits: SourceControlCommitView[] = [
      {
        hash: 'aaaa1111',
        shortHash: 'aaaa111',
        parents: ['bbbb2222', 'cccc3333'],
        author: 'Alice',
        date: 3000,
        subject: 'Merge feat/dag',
        refs: [
          { name: 'HEAD', kind: 'head' },
          { name: 'main', kind: 'local' },
        ],
      },
      {
        hash: 'cccc3333',
        shortHash: 'cccc333',
        parents: ['dddd4444'],
        author: 'Bob',
        date: 2000,
        subject: 'feat: graph',
        refs: [{ name: 'feat/dag', kind: 'local' }],
      },
      {
        hash: 'bbbb2222',
        shortHash: 'bbbb222',
        parents: ['dddd4444'],
        author: 'Alice',
        date: 1500,
        subject: 'chore: main',
        refs: [],
      },
      {
        hash: 'dddd4444',
        shortHash: 'dddd444',
        parents: [],
        author: 'Alice',
        date: 1000,
        subject: 'init',
        refs: [{ name: 'v1.0.0', kind: 'tag' }],
      },
    ];

    const graph = computeCommitGraph(commits);
    expect(graph.maxLanes).toBeGreaterThanOrEqual(2);
    expect(graph.rows[0]!.isHead).toBe(true);
    expect(graph.rows[0]!.outgoingEdges).toHaveLength(2);
    expect(graph.rows[3]!.outgoingEdges).toHaveLength(0);

    // vs-idea-gittool LabelPainter 分组合并：local + 对应 remote 合并为双色书签 `origin & main`
    const grouped = groupRefLabels(
      [
        { name: 'HEAD', kind: 'head' },
        { name: 'main', kind: 'local' },
        { name: 'origin/main', kind: 'remote' },
        { name: 'v1.0.0', kind: 'tag' },
      ],
      'main',
    );
    expect(grouped).toEqual([
      { text: 'origin & main', kinds: ['head', 'remote'], tip: 'main, origin/main' },
      { text: 'v1.0.0', kinds: ['tag'], tip: 'v1.0.0' },
    ]);

    // 分支目录分组（Group by Directory）
    const tree = buildBranchFolderTree([
      { name: 'main', kind: 'local', current: true },
      { name: 'feat/git-ui', kind: 'local' },
      { name: 'feat/dag', kind: 'local' },
    ]);
    expect(tree.rootBranches.map((b) => b.name)).toEqual(['main']);
    expect(tree.folders[0]?.name).toBe('feat');
    expect(tree.folders[0]?.branches.map((b) => b.name)).toEqual(['feat/dag', 'feat/git-ui']);
  });

  it('提交页支持 IDEA 风格勾选部分文件提交、Amend 自动回填与冲突操作横幅', () => {
    render(<ChangesView />);
    hydrateSourceControl({
      available: true,
      root: '/repo',
      branch: 'main',
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
      remote: 'https://github.com/org/repo.git',
      branches: ['main', 'feat/ui'],
      lastCommitMessage: 'prev commit message',
      files: [
        { path: 'src/a.ts', status: 'modified', staged: false, additions: 3, deletions: 1 },
        { path: 'src/b.ts', status: 'untracked', staged: false },
      ],
      additions: 3,
      deletions: 1,
      updatedAt: 100,
    });

    // 顶部显示领先/落后标记
    expect(screen.getByTestId('git-ahead-behind').textContent).toContain('↑2');
    expect(screen.getByTestId('git-ahead-behind').textContent).toContain('↓1');

    // 取消勾选 src/b.ts，仅提交 src/a.ts
    fireEvent.click(screen.getByTestId('changes-check-src/b.ts'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'only commit a' } });
    fireEvent.click(screen.getByTestId('git-commit-btn'));
    expect(vscode.posted).toContainEqual({
      type: 'sourceControlCommit',
      payload: { message: 'only commit a', files: ['src/a.ts'] },
    });

    // 勾选 Amend 时空输入框自动回填最近一次提交信息
    hydrateSourceControl({
      available: true,
      root: '/repo',
      branch: 'main',
      remote: 'https://github.com/org/repo.git',
      lastCommitMessage: 'prev commit message',
      files: [],
      additions: 0,
      deletions: 0,
      lastAction: { kind: 'commit', ok: true, at: 200 },
      updatedAt: 200,
    });
    fireEvent.click(screen.getByTestId('git-amend-checkbox'));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('prev commit message');
    fireEvent.click(screen.getByTestId('git-commit-push-btn'));
    expect(vscode.posted).toContainEqual({
      type: 'sourceControlCommit',
      payload: { message: 'prev commit message', stageAll: true, amend: true, push: true },
    });

    // 合并冲突横幅显示「中止」与单文件冲突解决按钮
    hydrateSourceControl({
      available: true,
      root: '/repo',
      branch: 'main',
      inProgressOp: 'merge',
      files: [{ path: 'src/conflict.ts', status: 'conflicted', staged: false }],
      additions: 0,
      deletions: 0,
      updatedAt: 300,
    });
    expect(screen.getByTestId('git-in-progress-banner')).toBeTruthy();
    fireEvent.click(screen.getByTestId('changes-conflict-ours-src/conflict.ts'));
    expect(vscode.posted).toContainEqual({
      type: 'sourceControlResolveConflict',
      payload: { path: 'src/conflict.ts', strategy: 'ours' },
    });
    // 宿主完成上一操作并回推最新状态后，解除 pendingOp 锁定再点击中止
    hydrateSourceControl({
      available: true,
      root: '/repo',
      branch: 'main',
      inProgressOp: 'merge',
      files: [],
      additions: 0,
      deletions: 0,
      lastAction: { kind: 'resolveConflict', ok: true, at: 350 },
      updatedAt: 350,
    });
    fireEvent.click(screen.getByTestId('git-op-abort-btn'));
    expect(vscode.posted).toContainEqual({ type: 'sourceControlAbortOp', payload: {} });
  });

  it('历史页加载 DAG 提交图谱、查看提交详情并打开历史文件 Diff', () => {
    render(<ChangesView />);
    hydrateSourceControl({
      available: true,
      root: '/repo',
      branch: 'main',
      branches: ['main'],
      files: [],
      additions: 0,
      deletions: 0,
      updatedAt: 100,
    });

    // 切换到「历史」子标签
    fireEvent.mouseDown(screen.getByTestId('git-tab-log'));
    fireEvent.click(screen.getByTestId('git-tab-log'));

    const fetchLogMsg = [...vscode.posted].reverse().find((m) => m.type === 'sourceControlFetchLog');
    expect(fetchLogMsg).toBeTruthy();
    const logReqId = fetchLogMsg?.type === 'sourceControlFetchLog' ? fetchLogMsg.payload.requestId : 0;

    act(() => {
      applyHostMessage({
        type: 'sourceControlLogResult',
        payload: {
          requestId: logReqId,
          hasMore: false,
          commits: [
            {
              hash: 'abcdef1234567890',
              shortHash: 'abcdef1',
              parents: [],
              author: 'Halo',
              date: Date.now() - 60_000,
              subject: 'feat: idea git workbench',
              refs: [{ name: 'HEAD', kind: 'head' }],
            },
          ],
        },
      });
    });

    const row = screen.getByTestId('git-log-row-abcdef1');
    expect(row.textContent).toContain('feat: idea git workbench');
    fireEvent.click(row);

    const detailMsg = [...vscode.posted].reverse().find((m) => m.type === 'sourceControlFetchCommitDetail');
    expect(detailMsg).toBeTruthy();
    const detailReqId = detailMsg?.type === 'sourceControlFetchCommitDetail' ? detailMsg.payload.requestId : 0;

    act(() => {
      applyHostMessage({
        type: 'sourceControlCommitDetail',
        payload: {
          requestId: detailReqId,
          detail: {
            hash: 'abcdef1234567890',
            shortHash: 'abcdef1',
            parents: [],
            author: 'Halo',
            date: Date.now() - 60_000,
            subject: 'feat: idea git workbench',
            body: 'Detailed body line',
            files: [{ path: 'src/git.ts', status: 'modified', additions: 12, deletions: 4 }],
          },
        },
      });
    });

    fireEvent.click(screen.getByTestId('git-commit-file-src/git.ts'));
    expect(vscode.posted).toContainEqual({
      type: 'sourceControlOpenCommitFileDiff',
      payload: { hash: 'abcdef1234567890', path: 'src/git.ts' },
    });
  });

  it('分支页与贮藏页分别支持本地/远程/标签展示、创建分支及保存/弹出贮藏', () => {
    render(<ChangesView />);
    hydrateSourceControl({
      available: true,
      root: '/repo',
      branch: 'main',
      branches: ['main', 'dev'],
      remoteBranches: ['origin/main'],
      tags: ['v1.0.0'],
      branchDetails: [
        { name: 'main', kind: 'local', current: true, ahead: 1, lastCommitSubject: 'init' },
        { name: 'dev', kind: 'local', lastCommitSubject: 'wip dev' },
        { name: 'origin/main', kind: 'remote', lastCommitSubject: 'init' },
        { name: 'v1.0.0', kind: 'tag', lastCommitSubject: 'release' },
      ],
      stashes: [{ index: 0, ref: 'stash@{0}', branch: 'main', message: 'my stash', date: Date.now() - 120_000 }],
      files: [{ path: 'src/a.ts', status: 'modified', staged: false }],
      additions: 1,
      deletions: 0,
      updatedAt: 100,
    });

    // 分支页
    fireEvent.mouseDown(screen.getByTestId('git-tab-branches'));
    fireEvent.click(screen.getByTestId('git-tab-branches'));
    expect(screen.getByTestId('git-branch-row-local-main')).toBeTruthy();
    expect(screen.getByTestId('git-branch-row-remote-origin/main')).toBeTruthy();

    fireEvent.change(screen.getByTestId('git-branches-new-input'), { target: { value: 'feat/new' } });
    fireEvent.click(screen.getByTestId('git-branches-new-btn'));
    expect(vscode.posted).toContainEqual({
      type: 'sourceControlCreateBranch',
      payload: { branch: 'feat/new' },
    });

    // 宿主完成建分支操作并推送新快照，解除 pendingOp 后再操作贮藏
    hydrateSourceControl({
      available: true,
      root: '/repo',
      branch: 'feat/new',
      branches: ['main', 'dev', 'feat/new'],
      remoteBranches: ['origin/main'],
      tags: ['v1.0.0'],
      branchDetails: [
        { name: 'feat/new', kind: 'local', current: true, lastCommitSubject: 'init' },
        { name: 'main', kind: 'local', ahead: 1, lastCommitSubject: 'init' },
        { name: 'dev', kind: 'local', lastCommitSubject: 'wip dev' },
        { name: 'origin/main', kind: 'remote', lastCommitSubject: 'init' },
        { name: 'v1.0.0', kind: 'tag', lastCommitSubject: 'release' },
      ],
      stashes: [{ index: 0, ref: 'stash@{0}', branch: 'main', message: 'my stash', date: Date.now() - 120_000 }],
      files: [{ path: 'src/a.ts', status: 'modified', staged: false }],
      additions: 1,
      deletions: 0,
      lastAction: { kind: 'branch', ok: true, at: 200 },
      updatedAt: 200,
    });

    // 贮藏页
    fireEvent.mouseDown(screen.getByTestId('git-tab-stash'));
    fireEvent.click(screen.getByTestId('git-tab-stash'));
    expect(screen.getByTestId('git-stash-row-0')).toBeTruthy();
    fireEvent.click(screen.getByTestId('git-stash-pop-0'));
    expect(vscode.posted).toContainEqual({
      type: 'sourceControlStashPop',
      payload: { index: 0 },
    });
  });
});
