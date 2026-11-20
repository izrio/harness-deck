/**
 * 短期命令回执（HD-16）：同一个 commandId 在 TTL 内只执行一次。
 * 只做内存去重；进程重启后回执清空，符合「重试不重复执行」而不是「跨重启幂等」的定位。
 */
export class CommandReceipts {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = 5 * 60_000,
    private readonly maxEntries = 500,
  ) {}

  /** 返回 true 表示首次见到，应当执行；false 表示重复，直接忽略。 */
  accept(key: string, now = Date.now()): boolean {
    this.prune(now);
    if (this.seen.has(key)) return false;
    this.seen.set(key, now);
    if (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  private prune(now: number): void {
    for (const [key, at] of this.seen) {
      if (now - at > this.ttlMs) this.seen.delete(key);
    }
  }
}
