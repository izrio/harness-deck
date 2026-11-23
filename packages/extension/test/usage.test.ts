import { describe, expect, it } from 'vitest';
import { TurnTimingTracker, UsageTracker } from '../src/vm/usage.ts';

describe('TurnTimingTracker / UsageTracker 响应性能统计', () => {
  it('按 start → firstToken → finish 计算首字耗时（TTFT）与生成速度（tokens/s）', () => {
    const tracker = new TurnTimingTracker();
    tracker.start(1_000);
    tracker.markFirstToken(2_200);
    tracker.markFirstToken(2_800); // 仅首次生效
    tracker.finish(250, 7_200); // 生成耗时 5000ms → 50.0 tok/s

    expect(tracker.performance()).toEqual({
      ttftMs: 1_200,
      tokensPerSec: 50,
      durationMs: 6_200,
    });
  });

  it('兼容先 finish 后到达 usage 的事件顺序（通过 attachOutputTokens 补算速度）', () => {
    const tracker = new UsageTracker();
    tracker.startRequest(10_000);
    tracker.markFirstToken(10_500);
    tracker.finishRequest(undefined, 12_500); // 生成耗时 2000ms

    expect(tracker.detail()?.performance).toEqual({
      ttftMs: 500,
      durationMs: 2_500,
    });

    tracker.addRequest({ input: 1_000, cacheRead: 9_000, cacheWrite: 0, output: 120 });
    expect(tracker.detail()?.performance).toEqual({
      ttftMs: 500,
      tokensPerSec: 60,
      durationMs: 2_500,
    });
  });

  it('兼容先到达 usage 后 finish 的事件顺序，并在 reset 时清空', () => {
    const tracker = new UsageTracker();
    tracker.startRequest(1_000);
    tracker.markFirstToken(1_400);
    tracker.addRequest({ input: 500, cacheRead: 4_500, cacheWrite: 0, output: 80 });
    tracker.finishRequest(undefined, 2_400); // 生成耗时 1000ms → 80.0 tok/s

    expect(tracker.detail()?.performance).toEqual({
      ttftMs: 400,
      tokensPerSec: 80,
      durationMs: 1_400,
    });

    tracker.reset();
    expect(tracker.detail()).toBeUndefined();
  });

  it('生成耗时过短（<50ms）时不输出异常极值速度', () => {
    const tracker = new TurnTimingTracker();
    tracker.start(1_000);
    tracker.markFirstToken(1_300);
    tracker.finish(100, 1_320);

    expect(tracker.performance()).toEqual({
      ttftMs: 300,
      durationMs: 320,
    });
  });
});
