/**
 * 跨智能体统一会话标签模型（由 HarnessHostRuntime 持有）：
 *
 * 顶部标签栏不再按单个智能体隔离——不同智能体（如 DeepSeek、Claude Code、Pi、ZCode、ACP）
 * 的会话可以同时并排打开在顶部标签栏中，切换智能体或新开会话切换智能体时不会清空已有标签。
 *
 * 规则：
 * - 每个标签归属一个智能体（`backendId`），可选关联一个会话（`sessionId`；`undefined` 表示新对话）；
 * - 同一 `(backendId, sessionId)` 不同时出现在两个标签里；
 * - 最多保留一个空的新对话标签：再点「新建」时切过去并更新为当前智能体；
 * - 新开的标签一律追加到最右侧，已有标签的顺序只受拖动影响；
 * - 空的新对话标签上切换智能体时，就地更新该标签的 `backendId`，保留其他所有标签；
 * - 关掉最后一个标签时换成同智能体的新对话标签。
 */
import type { TabsState, TabView } from '@harness-deck/shared';

export interface UnifiedTab {
  readonly key: string;
  backendId: string;
  sessionId: string | undefined;
  /** 最近已知的会话标题（冷启动时目标智能体尚未启动也可正确展示）。 */
  cachedTitle?: string;
  /** 独立 worktree 路径（支持多 worktree 并行标签，P1-5）。 */
  worktreePath?: string;
  /** 独立 worktree 分支名。 */
  worktreeBranch?: string;
}

export interface PersistedUnifiedTab {
  readonly backendId: string;
  readonly sessionId: string;
  readonly title?: string;
  readonly worktreePath?: string;
  readonly worktreeBranch?: string;
}

export interface PersistedUnifiedTabs {
  readonly items: readonly PersistedUnifiedTab[];
  readonly active?: {
    readonly backendId: string;
    readonly sessionId?: string;
  };
}

export interface UnifiedTabsOptions {
  readonly load: () => unknown;
  readonly save: (state: PersistedUnifiedTabs) => void;
}

export interface RestoreUnifiedTabsOptions {
  readonly defaultBackendId: string;
  readonly validBackendIds: ReadonlySet<string>;
  readonly fallbackTabs?: readonly { readonly sessionId?: string; readonly title?: string }[];
  readonly fallbackActiveSessionId?: string;
}

export interface CloseUnifiedTabResult {
  readonly closed: UnifiedTab;
  readonly nextActive: UnifiedTab;
  readonly activeChanged: boolean;
}

export interface CloseManyUnifiedTabsResult {
  readonly closed: readonly UnifiedTab[];
  readonly nextActive: UnifiedTab;
  readonly activeChanged: boolean;
}

function isPendingSessionId(sessionId: string | undefined): boolean {
  return Boolean(sessionId?.startsWith('pending:'));
}

export function parsePersistedUnifiedTabs(raw: unknown): PersistedUnifiedTabs | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.items)) return undefined;
  const items: PersistedUnifiedTab[] = [];
  for (const entry of obj.items) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const backendId = typeof item.backendId === 'string' ? item.backendId.trim() : '';
    const sessionId = typeof item.sessionId === 'string' ? item.sessionId.trim() : '';
    const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : undefined;
    const worktreePath =
      typeof item.worktreePath === 'string' && item.worktreePath.trim() ? item.worktreePath.trim() : undefined;
    const worktreeBranch =
      typeof item.worktreeBranch === 'string' && item.worktreeBranch.trim() ? item.worktreeBranch.trim() : undefined;
    if (!backendId || !sessionId || isPendingSessionId(sessionId)) continue;
    items.push({
      backendId,
      sessionId,
      ...(title ? { title } : {}),
      ...(worktreePath ? { worktreePath } : {}),
      ...(worktreeBranch ? { worktreeBranch } : {}),
    });
  }
  let active: PersistedUnifiedTabs['active'];
  if (obj.active && typeof obj.active === 'object') {
    const rawActive = obj.active as Record<string, unknown>;
    const backendId = typeof rawActive.backendId === 'string' ? rawActive.backendId.trim() : '';
    const sessionId =
      typeof rawActive.sessionId === 'string' && rawActive.sessionId.trim() && !isPendingSessionId(rawActive.sessionId)
        ? rawActive.sessionId.trim()
        : undefined;
    if (backendId) {
      active = { backendId, ...(sessionId ? { sessionId } : {}) };
    }
  }
  return { items, ...(active ? { active } : {}) };
}

export class UnifiedTabsModel {
  private tabs: UnifiedTab[] = [];
  private activeKey = '';
  private counter = 0;

  constructor(private readonly options: UnifiedTabsOptions) {}

  get items(): readonly UnifiedTab[] {
    return this.tabs;
  }

  get activeTabKey(): string {
    return this.activeKey;
  }

  get current(): UnifiedTab | undefined {
    return this.tabs.find((tab) => tab.key === this.activeKey);
  }

  /**
   * 恢复跨智能体标签：
   * - 已有统一持久化数据时恢复所有智能体的标签，并按 `defaultBackendId` 决定初始激活标签；
   * - 首次升级尚无统一持久化数据时，从初始智能体原有的单智能体标签平滑迁移。
   */
  restore(opts: RestoreUnifiedTabsOptions): { readonly restoredFromPersisted: boolean } {
    const saved = parsePersistedUnifiedTabs(this.options.load());
    this.tabs = [];
    this.activeKey = '';

    if (saved) {
      const seen = new Set<string>();
      for (const item of saved.items) {
        if (!opts.validBackendIds.has(item.backendId)) continue;
        const dedupeKey = `${item.backendId}:${item.sessionId}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        this.tabs.push({
          key: this.nextKey(),
          backendId: item.backendId,
          sessionId: item.sessionId,
          ...(item.title ? { cachedTitle: item.title } : {}),
          ...(item.worktreePath ? { worktreePath: item.worktreePath } : {}),
          ...(item.worktreeBranch ? { worktreeBranch: item.worktreeBranch } : {}),
        });
      }

      let activeTab: UnifiedTab | undefined;
      if (saved.active?.backendId === opts.defaultBackendId) {
        if (saved.active.sessionId) {
          activeTab = this.tabs.find(
            (t) => t.backendId === opts.defaultBackendId && t.sessionId === saved.active?.sessionId,
          );
          if (!activeTab) {
            activeTab = {
              key: this.nextKey(),
              backendId: opts.defaultBackendId,
              sessionId: saved.active.sessionId,
            };
            this.tabs.push(activeTab);
          }
        } else {
          activeTab = {
            key: this.nextKey(),
            backendId: opts.defaultBackendId,
            sessionId: undefined,
          };
          this.tabs.push(activeTab);
        }
      } else {
        if (opts.fallbackActiveSessionId) {
          activeTab = this.tabs.find(
            (t) => t.backendId === opts.defaultBackendId && t.sessionId === opts.fallbackActiveSessionId,
          );
        }
        if (!activeTab) {
          activeTab = this.findLastByBackend(opts.defaultBackendId);
        }
        if (!activeTab) {
          activeTab = {
            key: this.nextKey(),
            backendId: opts.defaultBackendId,
            sessionId: undefined,
          };
          this.tabs.push(activeTab);
        }
      }

      this.activeKey = activeTab.key;
      return { restoredFromPersisted: true };
    }

    // 首次升级迁移：沿用当前默认智能体已打开的标签
    const seen = new Set<string>();
    for (const item of opts.fallbackTabs ?? []) {
      if (!item.sessionId || isPendingSessionId(item.sessionId)) continue;
      if (seen.has(item.sessionId)) continue;
      seen.add(item.sessionId);
      this.tabs.push({
        key: this.nextKey(),
        backendId: opts.defaultBackendId,
        sessionId: item.sessionId,
        ...(item.title ? { cachedTitle: item.title } : {}),
      });
    }
    if (opts.fallbackActiveSessionId && !isPendingSessionId(opts.fallbackActiveSessionId) && !seen.has(opts.fallbackActiveSessionId)) {
      this.tabs.push({
        key: this.nextKey(),
        backendId: opts.defaultBackendId,
        sessionId: opts.fallbackActiveSessionId,
      });
    }
    let activeTab = opts.fallbackActiveSessionId
      ? this.tabs.find((t) => t.backendId === opts.defaultBackendId && t.sessionId === opts.fallbackActiveSessionId)
      : undefined;
    if (!activeTab) {
      activeTab = {
        key: this.nextKey(),
        backendId: opts.defaultBackendId,
        sessionId: undefined,
      };
      this.tabs.push(activeTab);
    }
    this.activeKey = activeTab.key;
    return { restoredFromPersisted: false };
  }

  /** 新建对话标签：若指定 worktree 则始终新开独立标签以支持多 worktree 并行；否则复用空标签。 */
  openNew(backendId: string, worktree?: { readonly path: string; readonly branch?: string }): UnifiedTab {
    if (!worktree) {
      const blank = this.tabs.find((tab) => !tab.sessionId && !tab.worktreePath);
      if (blank) {
        blank.backendId = backendId;
        this.activeKey = blank.key;
        this.persist();
        return blank;
      }
    }
    const created: UnifiedTab = {
      key: this.nextKey(),
      backendId,
      sessionId: undefined,
      ...(worktree ? { worktreePath: worktree.path } : {}),
      ...(worktree?.branch ? { worktreeBranch: worktree.branch } : {}),
    };
    this.append(created);
    return created;
  }

  /** 打开指定智能体的会话：已在标签里时切过去；当前为空标签时就地打开；否则追加到最右侧。 */
  open(backendId: string, sessionId: string, title?: string): UnifiedTab {
    const existing = this.tabs.find((tab) => tab.backendId === backendId && tab.sessionId === sessionId);
    if (existing) {
      if (title) existing.cachedTitle = title;
      this.activeKey = existing.key;
      this.persist();
      return existing;
    }
    const cur = this.current;
    if (cur && !cur.sessionId) {
      cur.backendId = backendId;
      cur.sessionId = sessionId;
      if (title) cur.cachedTitle = title;
      this.persist();
      return cur;
    }
    const created: UnifiedTab = {
      key: this.nextKey(),
      backendId,
      sessionId,
      ...(title ? { cachedTitle: title } : {}),
    };
    this.append(created);
    return created;
  }

  /** 将指定标签（通常为空的新对话标签）切换到另一个智能体，不清空其他标签。 */
  setTabBackend(key: string, backendId: string): UnifiedTab | undefined {
    const tab = this.tabs.find((t) => t.key === key);
    if (!tab) return undefined;
    tab.backendId = backendId;
    this.activeKey = key;
    this.persist();
    return tab;
  }

  /** 激活指定标签。 */
  setActive(key: string): UnifiedTab | undefined {
    const tab = this.tabs.find((t) => t.key === key);
    if (!tab) return undefined;
    this.activeKey = key;
    this.persist();
    return tab;
  }

  /** 关闭标签：关掉最后一个会话标签时换成同智能体的空新对话标签；唯一空标签不可关闭。 */
  close(key: string): CloseUnifiedTabResult | undefined {
    const index = this.tabs.findIndex((t) => t.key === key);
    const tab = this.tabs[index];
    if (!tab) return undefined;
    if (this.tabs.length === 1 && !tab.sessionId) return undefined;

    if (this.tabs.length === 1) {
      const replacement: UnifiedTab = {
        key: this.nextKey(),
        backendId: tab.backendId,
        sessionId: undefined,
      };
      this.tabs = [replacement];
      this.activeKey = replacement.key;
      this.persist();
      return { closed: tab, nextActive: replacement, activeChanged: true };
    }

    this.tabs.splice(index, 1);
    const activeChanged = key === this.activeKey;
    if (activeChanged) {
      const next = (this.tabs[index] ?? this.tabs[index - 1])!;
      this.activeKey = next.key;
      this.persist();
      return { closed: tab, nextActive: next, activeChanged: true };
    }
    this.persist();
    return { closed: tab, nextActive: this.current!, activeChanged: false };
  }

  /** 拖动排序：把标签移到目标位置，越界时夹到首尾；顺序会写入持久化数据。 */
  move(key: string, toIndex: number): boolean {
    const from = this.tabs.findIndex((tab) => tab.key === key);
    if (from < 0) return false;
    const to = Math.max(0, Math.min(this.tabs.length - 1, toIndex));
    if (from === to) return false;
    const [tab] = this.tabs.splice(from, 1);
    this.tabs.splice(to, 0, tab!);
    this.persist();
    return true;
  }

  /**
   * 批量关闭标签（右键菜单的「关闭其他 / 关闭左侧 / 关闭右侧 / 关闭全部」）。
   * 与单个关闭一致：活动标签被关掉时优先接管它右侧的标签，没有右侧时接管左侧；
   * 全部关掉时补一个空的新对话标签。
   */
  closeMany(keys: readonly string[]): CloseManyUnifiedTabsResult | undefined {
    const remove = new Set(keys);
    const closed = this.tabs.filter((tab) => remove.has(tab.key));
    if (closed.length === 0) return undefined;

    const activeIndex = this.tabs.findIndex((tab) => tab.key === this.activeKey);
    const activeChanged = remove.has(this.activeKey);
    const survivorAfter = this.tabs.slice(activeIndex + 1).find((tab) => !remove.has(tab.key));
    const survivorBefore = this.tabs
      .slice(0, Math.max(activeIndex, 0))
      .reverse()
      .find((tab) => !remove.has(tab.key));

    this.tabs = this.tabs.filter((tab) => !remove.has(tab.key));
    if (this.tabs.length === 0) {
      const replacement: UnifiedTab = {
        key: this.nextKey(),
        backendId: closed[closed.length - 1]!.backendId,
        sessionId: undefined,
      };
      this.tabs = [replacement];
      this.activeKey = replacement.key;
      this.persist();
      return { closed, nextActive: replacement, activeChanged: true };
    }

    if (activeChanged) {
      this.activeKey = (survivorAfter ?? survivorBefore ?? this.tabs[0]!).key;
    }
    this.persist();
    return { closed, nextActive: this.current!, activeChanged };
  }

  /** 当前标签发出首条消息后绑定到新创建的会话 id；若该会话已在其他标签则去重。 */
  bindCurrentSession(backendId: string, sessionId: string, title?: string): boolean {
    const cur = this.current;
    if (!cur || cur.backendId !== backendId) return false;
    if (cur.sessionId === sessionId) {
      if (title && title !== cur.cachedTitle) {
        cur.cachedTitle = title;
        this.persist();
      }
      return false;
    }
    this.tabs = this.tabs.filter((t) => t === cur || !(t.backendId === backendId && t.sessionId === sessionId));
    cur.sessionId = sessionId;
    if (title) cur.cachedTitle = title;
    this.persist();
    return true;
  }

  /** 临时会话 key（如 Claude 的 pending:*）替换为真实 sessionId，前台与后台标签均适用。 */
  rekeySession(backendId: string, oldSessionId: string, newSessionId: string): boolean {
    if (oldSessionId === newSessionId) return false;
    const target = this.tabs.find((t) => t.backendId === backendId && t.sessionId === oldSessionId);
    if (!target) return false;
    this.tabs = this.tabs.filter((t) => t === target || !(t.backendId === backendId && t.sessionId === newSessionId));
    target.sessionId = newSessionId;
    this.persist();
    return true;
  }

  /** 更新某个会话标签的缓存标题，用于重启后未启动智能体时仍可显示上次标题。 */
  updateCachedTitle(backendId: string, sessionId: string, title: string): void {
    const trimmed = title.trim();
    if (!trimmed) return;
    const tab = this.tabs.find((t) => t.backendId === backendId && t.sessionId === sessionId);
    if (!tab || tab.cachedTitle === trimmed) return;
    tab.cachedTitle = trimmed;
    this.persist();
  }

  /** 某个自定义智能体从设置中被删除时，清理归属它的标签。 */
  removeBackend(backendId: string, fallbackBackendId: string): { readonly activeChanged: boolean; readonly nextActive: UnifiedTab } {
    const prevActiveKey = this.activeKey;
    const before = this.tabs.length;
    this.tabs = this.tabs.filter((t) => t.backendId !== backendId);
    if (this.tabs.length === 0) {
      const replacement: UnifiedTab = {
        key: this.nextKey(),
        backendId: fallbackBackendId,
        sessionId: undefined,
      };
      this.tabs = [replacement];
      this.activeKey = replacement.key;
      this.persist();
      return { activeChanged: true, nextActive: replacement };
    }
    if (!this.tabs.some((t) => t.key === this.activeKey)) {
      this.activeKey = this.tabs[this.tabs.length - 1]!.key;
    }
    if (this.tabs.length !== before || this.activeKey !== prevActiveKey) {
      this.persist();
    }
    return { activeChanged: this.activeKey !== prevActiveKey, nextActive: this.current! };
  }

  findLastByBackend(backendId: string): UnifiedTab | undefined {
    for (let i = this.tabs.length - 1; i >= 0; i--) {
      if (this.tabs[i]!.backendId === backendId) return this.tabs[i];
    }
    return undefined;
  }

  hasSession(backendId: string, sessionId: string): boolean {
    return this.tabs.some((t) => t.backendId === backendId && t.sessionId === sessionId);
  }

  view(describe: (tab: UnifiedTab, isActive: boolean) => Omit<TabView, 'key' | 'sessionId' | 'backendId'>): TabsState {
    const items: TabView[] = this.tabs.map((tab) => ({
      key: tab.key,
      backendId: tab.backendId,
      ...(tab.sessionId ? { sessionId: tab.sessionId } : {}),
      ...(tab.worktreePath ? { worktreePath: tab.worktreePath } : {}),
      ...(tab.worktreeBranch ? { worktreeBranch: tab.worktreeBranch } : {}),
      ...describe(tab, tab.key === this.activeKey),
    }));
    return { items, active: this.activeKey };
  }

  /** 新开的标签一律追加到最右侧，不挤动已有标签的位置。 */
  private append(tab: UnifiedTab): void {
    this.tabs.push(tab);
    this.activeKey = tab.key;
    this.persist();
  }

  private nextKey(): string {
    return `utab-${++this.counter}`;
  }

  private persist(): void {
    const items: PersistedUnifiedTab[] = [];
    for (const tab of this.tabs) {
      if (!tab.sessionId || isPendingSessionId(tab.sessionId)) continue;
      items.push({
        backendId: tab.backendId,
        sessionId: tab.sessionId,
        ...(tab.cachedTitle ? { title: tab.cachedTitle } : {}),
        ...(tab.worktreePath ? { worktreePath: tab.worktreePath } : {}),
        ...(tab.worktreeBranch ? { worktreeBranch: tab.worktreeBranch } : {}),
      });
    }
    const cur = this.current;
    const active = cur
      ? {
          backendId: cur.backendId,
          ...(cur.sessionId && !isPendingSessionId(cur.sessionId) ? { sessionId: cur.sessionId } : {}),
        }
      : undefined;
    this.options.save({ items, ...(active ? { active } : {}) });
  }
}
