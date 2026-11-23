import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GLOBAL_SHORTCUT,
  DEFAULT_WINDOW_BOUNDS,
  parsePairingUrlFromLog,
  resolveDesktopConfig,
  sanitizeWindowBounds,
} from '../src/config.ts';

describe('Desktop Electron Shell Config (P3-11)', () => {
  it('resolves CLI args and env overrides with sane defaults', () => {
    const cfg = resolveDesktopConfig(['/tmp/my-repo'], {
      HARNESS_DECK_CONFIG_ROOT: '/tmp/hd-cfg',
      HARNESS_DECK_DESKTOP_PORT: '41234',
    });
    expect(cfg.configRoot).toBe('/tmp/hd-cfg');
    expect(cfg.projectPath).toContain('my-repo');
    expect(cfg.port).toBe(41234);
    expect(cfg.globalShortcut).toBe(DEFAULT_GLOBAL_SHORTCUT);
    expect(cfg.sidecarEntry).toContain('sidecar.cjs');
  });

  it('clamps invalid or out-of-range persisted window bounds', () => {
    expect(sanitizeWindowBounds(null)).toEqual(DEFAULT_WINDOW_BOUNDS);
    expect(sanitizeWindowBounds({ width: 200, height: 99999, x: 10, y: 20 })).toEqual({
      width: 720,
      height: 2160,
      x: 10,
      y: 20,
    });
  });

  it('extracts pairing URL from headless server log line', () => {
    expect(parsePairingUrlFromLog('pairing URL: http://127.0.0.1:37890/pair?code=abc')).toBe(
      'http://127.0.0.1:37890/pair?code=abc',
    );
    expect(parsePairingUrlFromLog('other log line')).toBeUndefined();
  });
});
