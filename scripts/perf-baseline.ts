/**
 * 性能基线（HD-17）：不启动 IDE，只测三件容易随会话增长退化的事。
 *
 * 1. 快照 JSON 大小（会话列表 + 当前会话条目）
 * 2. `deriveTurns` 处理长会话的耗时
 * 3. `buildThreadRows` 合并工具行的耗时
 *
 * 默认超预算只警告、不失败；加 `--strict` 才返回非零。CI 用默认模式。
 */
import { performance } from 'node:perf_hooks';
import type { HostSnapshot, Item } from '../packages/shared/src/index.ts';
import { deriveTurns } from '../packages/shared/src/turns.ts';
import { buildThreadRows } from '../packages/webview-ui/src/threadRows.ts';

const strict = process.argv.includes('--strict');

const BUDGETS = {
  snapshotBytes: 2_000_000,
  turnsMs: 25,
  rowsMs: 25,
};

function makeItems(count: number): Item[] {
  const items: Item[] = [];
  for (let i = 0; i < count; i++) {
    const slot = i % 10;
    if (slot === 0) items.push({ kind: 'user', id: `u${i}`, text: `任务 ${i}` });
    else if (slot === 9) items.push({ kind: 'turnDone', id: `t${i}`, durationMs: 1_234, completed: true });
    else if (slot % 2 === 0)
      items.push({ kind: 'activity', id: `a${i}`, tool: 'bash', variant: 'command', label: `pnpm test ${i}`, status: 'ok' });
    else items.push({ kind: 'assistant', id: `m${i}`, markdown: 'x'.repeat(200), streaming: false });
  }
  return items;
}

function averageMs(fn: () => void, runs = 5): number {
  fn(); // 预热
  const started = performance.now();
  for (let i = 0; i < runs; i++) fn();
  return (performance.now() - started) / runs;
}

const items = makeItems(2_000);
const sessions = Array.from({ length: 50 }, (_, i) => ({
  id: `s${i}`,
  title: `会话 ${i}`,
  updatedAt: Date.now() - i * 1_000,
  running: i === 0,
}));
const snapshot: HostSnapshot = {
  runtime: { kind: 'connected', version: '0.0.0', newerThanTested: false },
  connection: 'connected',
  sessions,
  tabs: { items: [{ key: 't1', sessionId: 's0', title: '会话 0' }], active: 't1' },
  session: { id: 's0', title: '会话 0', running: true, hasOlder: false, loadingOlder: false, sync: 'live' },
  items,
  models: { options: [], current: { provider: 'deepseek', model: 'deepseek-flash' } },
  interactions: [],
  permissions: { options: ['read-only', 'workspace-write', 'danger-full-access'] },
  workspace: { dirtyFiles: 0 },
  context: { includeActiveByDefault: true, pinned: [] },
  commands: [],
  locale: 'zh',
  appearance: {},
  backends: { items: [], active: 'dsh' },
};

const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
const turnsMs = averageMs(() => void deriveTurns(items, true));
const rowsMs = averageMs(() => void buildThreadRows(items));

const rows = [
  { name: 'snapshot bytes', value: snapshotBytes, budget: BUDGETS.snapshotBytes, unit: 'B' },
  { name: 'deriveTurns', value: turnsMs, budget: BUDGETS.turnsMs, unit: 'ms' },
  { name: 'buildThreadRows', value: rowsMs, budget: BUDGETS.rowsMs, unit: 'ms' },
];

let over = false;
for (const row of rows) {
  const exceeded = row.value > row.budget;
  over ||= exceeded;
  const status = exceeded ? 'WARN' : 'ok';
  console.log(
    `${status.padEnd(4)} ${row.name.padEnd(16)} ${row.value.toFixed(1).padStart(9)} ${row.unit}  (budget ${row.budget} ${row.unit})`,
  );
}

if (over) {
  console.log('\n有指标超过预算；默认不阻塞，加 --strict 可让 CI 失败。');
  if (strict) process.exitCode = 1;
} else {
  console.log('\n全部指标在预算内。');
}
