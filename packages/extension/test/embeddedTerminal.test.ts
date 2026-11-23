import { describe, expect, it } from 'vitest';
import type { TerminalState } from '@harness-deck/shared';
import { EmbeddedTerminalManager } from '../src/terminal/EmbeddedTerminalManager.ts';

describe('EmbeddedTerminalManager (P1-4)', () => {
  it('creates, writes to, resizes, clears, and closes a terminal session', async () => {
    let latestState: TerminalState = { sessions: [] };
    let buffer = '';
    let resolveMarker: (() => void) | undefined;
    const markerSeen = new Promise<void>((resolve) => {
      resolveMarker = resolve;
    });

    const manager = new EmbeddedTerminalManager({
      onStateChange: (s) => {
        latestState = s;
      },
      onOutput: (ev) => {
        if (ev.reset) {
          buffer = ev.data;
          return;
        }
        buffer += ev.data;
        if (buffer.includes('HD_TERM_OK')) {
          resolveMarker?.();
        }
      },
    });

    try {
      const session = manager.create({ cwd: process.cwd(), title: 'test-sh', cols: 90, rows: 28 });
      expect(session.title).toBe('test-sh');
      expect(latestState.activeId).toBe(session.id);

      manager.resize(session.id, 100, 30);
      expect(manager.getState().sessions[0]?.cols).toBe(100);

      manager.write(session.id, 'echo HD_TERM_OK\n');
      await markerSeen;
      expect(buffer).toContain('HD_TERM_OK');

      manager.clear(session.id);
      expect(manager.getScrollback(session.id)).toBe('');

      manager.close(session.id);
      expect(manager.getState().sessions).toHaveLength(0);
    } finally {
      manager.dispose();
    }
  });
});
