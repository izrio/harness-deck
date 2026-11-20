import { describe, expect, it } from 'vitest';
import { CommandReceipts } from '../src/host/receipts.ts';

describe('CommandReceipts', () => {
  it('TTL 内重复的 commandId 只执行一次', () => {
    const receipts = new CommandReceipts(1_000);
    expect(receipts.accept('sendMessage:abc', 0)).toBe(true);
    expect(receipts.accept('sendMessage:abc', 500)).toBe(false);
    expect(receipts.accept('sendMessage:abc', 1_001)).toBe(true);
  });

  it('不同命令与不同 id 互不影响', () => {
    const receipts = new CommandReceipts();
    expect(receipts.accept('respondApproval:a', 0)).toBe(true);
    expect(receipts.accept('respondApproval:b', 0)).toBe(true);
    expect(receipts.accept('answerQuestion:a', 0)).toBe(true);
  });

  it('超过上限时淘汰最旧的条目', () => {
    const receipts = new CommandReceipts(60_000, 2);
    expect(receipts.accept('a', 0)).toBe(true);
    expect(receipts.accept('b', 1)).toBe(true);
    expect(receipts.accept('c', 2)).toBe(true);
    expect(receipts.accept('a', 3)).toBe(true);
  });
});
