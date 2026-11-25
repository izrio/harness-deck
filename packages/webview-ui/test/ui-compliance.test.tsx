// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Item } from '@harness-deck/shared';
import { App } from '../src/App.tsx';
import { ItemView } from '../src/components/Items.tsx';
import { InteractionCard } from '../src/components/Interactions.tsx';
import { ModelPicker } from '../src/components/ModelPicker.tsx';
import { applyHostMessage, resetStoreForTests } from '../src/store.ts';
import { makeSnapshot, mockVsCodeApi } from './setup.ts';

const vscode = mockVsCodeApi();

beforeEach(() => {
  vscode.reset();
  resetStoreForTests();
});

describe('AGENTS.md UI 合规', () => {
  it('技能安装弹窗里发现的技能使用 shadcn Checkbox 并可勾选', () => {
    render(<App />);
    act(() => applyHostMessage({ type: 'snapshot', payload: makeSnapshot() }));
    fireEvent.click(screen.getByTestId('settings-button'));
    fireEvent.click(screen.getByTestId('settings-tab-skills'));
    fireEvent.click(screen.getByTestId('skill-install-btn'));
    act(() =>
      applyHostMessage({
        type: 'extensions',
        payload: {
          skills: {
            items: [],
            scanned: {
              repoUrl: 'https://github.com/anthropics/skills.git',
              ref: 'main',
              skills: [{ name: 'frontend-design', description: 'UI', subpath: 'skills/frontend-design' }],
            },
          },
          mcp: { servers: [] },
        },
      }),
    );

    const row = screen.getByTestId('discovered-skill-frontend-design');
    const box = row.querySelector('[data-slot="checkbox"]') as HTMLElement;
    expect(box).toBeTruthy();
    expect(box.getAttribute('role')).toBe('checkbox');
    const before = box.getAttribute('aria-checked');
    fireEvent.click(box);
    expect(box.getAttribute('aria-checked')).not.toBe(before);
  });

  it('MCP 导入候选使用 shadcn Checkbox 并可勾选', () => {
    render(<App />);
    act(() => applyHostMessage({ type: 'snapshot', payload: makeSnapshot() }));
    fireEvent.click(screen.getByTestId('settings-button'));
    fireEvent.click(screen.getByTestId('settings-tab-mcp'));
    fireEvent.click(screen.getByTestId('mcp-import-btn'));
    act(() =>
      applyHostMessage({
        type: 'extensions',
        payload: {
          skills: { items: [] },
          mcp: {
            servers: [],
            scannedSources: ['/home/user/.claude.json'],
            importCandidates: [
              {
                key: 'claude:/home/user/.claude.json:context7',
                name: 'context7',
                transport: 'http',
                url: 'https://mcp.context7.com/mcp',
                sourceAgentId: 'claude',
                sourceAgentName: 'Claude Code',
                sourcePath: '/home/user/.claude.json',
              },
            ],
          },
        },
      }),
    );

    const box = screen.getByTestId('mcp-candidate-check-context7');
    expect(box.getAttribute('data-slot')).toBe('checkbox');
    const before = box.getAttribute('aria-checked');
    fireEvent.click(box);
    expect(box.getAttribute('aria-checked')).not.toBe(before);
  });

  it('排队消息编辑器保留 textbox 可访问名称与 queue-editor 类名', () => {
    act(() => applyHostMessage({ type: 'snapshot', payload: makeSnapshot() }));
    const queued: Extract<Item, { kind: 'user' }> = {
      kind: 'user',
      id: 'u-queued',
      text: '稍后再说',
      pending: 'queued',
      queue: { itemId: 'q1', target: 'next-turn' },
    };
    render(<ItemView item={queued} />);
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const editor = screen.getByRole('textbox', { name: '编辑排队的消息' });
    expect(editor.classList.contains('queue-editor')).toBe(true);
    expect(editor.getAttribute('data-slot')).toBe('textarea');
  });

  it('审批卡主按钮使用语义前景色而非写死的 text-white', () => {
    act(() => applyHostMessage({ type: 'snapshot', payload: makeSnapshot() }));
    render(
      <InteractionCard
        interaction={{
          kind: 'approval',
          id: 'a1',
          toolName: 'bash',
          reason: '运行测试',
          subjectKind: 'command',
          subject: 'echo hi',
          dirtyFiles: [],
          previewable: false,
        }}
      />,
    );
    const allow = screen.getByRole('button', { name: '允许本次' });
    expect(allow.className).toContain('text-brand-foreground');
    expect(allow.className).not.toContain('text-white');
  });

  it('模型下拉列表使用 shadcn-ui ScrollArea 替代系统原生滚动条', () => {
    act(() =>
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          models: {
            current: { provider: 'antigravity', model: 'gemini-4-neon' },
            options: [
              { provider: 'antigravity', model: 'gemini-4-neon', name: 'Gemini 4 Neon', group: 'Gemini', efforts: [] },
              { provider: 'antigravity', model: 'gemini-4-carbon', name: 'Gemini 4 Carbon', group: 'Gemini', efforts: [] },
            ],
          },
        }),
      }),
    );
    render(<ModelPicker disabled={false} />);
    fireEvent.click(screen.getByTestId('model-picker'));
    const list = screen.getByTestId('model-list');
    const scrollArea = list.closest('[data-slot="scroll-area"]');
    const viewport = list.closest('[data-slot="scroll-area-viewport"]');
    expect(scrollArea).toBeTruthy();
    expect(viewport).toBeTruthy();
  });
});
