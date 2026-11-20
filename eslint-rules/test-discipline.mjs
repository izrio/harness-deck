/**
 * 测试纪律规则（HD-03）：
 * - `no-sleep-in-tests`：测试里不要用 sleep / 定时器等真实时间（先 warn，清理存量后改 error）
 * - `no-wall-clock-in-tests`：不要用 Date.now() / performance.now() 的差值做断言
 * - `quarantine-needs-issue`：it.skip / describe.skip / it.todo 必须在上方写 `// quarantine: #<issue> <原因>`
 *
 * 只作用于测试文件；`test/mock-model/` 这类夹具不是测试文件，不受影响。
 */

const TEST_FILE = /(?:^|\/)test\/.*\.(?:test|spec)\.(?:ts|tsx)$|(?:^|\/)src\/.*\.(?:test|spec)\.(?:ts|tsx)$/u;

function isTestFile(filename) {
  return TEST_FILE.test(filename.replace(/\\/gu, '/'));
}

function calleeName(callee) {
  if (!callee) return undefined;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
    return callee.property.name;
  }
  return undefined;
}

function memberRootName(node) {
  if (!node) return undefined;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression') return memberRootName(node.object);
  return undefined;
}

const noSleepInTests = {
  meta: {
    type: 'suggestion',
    docs: { description: '测试里不要用真实时间等待，改为等待具体事件或 promise' },
    schema: [],
    messages: {
      sleep: '测试里不要用 setTimeout / sleep 等真实时间等待；改为等待具体事件、promise 或可 drain 的队列（见 AGENTS.md 测试规则）。',
    },
  },
  create(context) {
    if (!isTestFile(context.filename)) return {};
    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (name === 'setTimeout' || name === 'setInterval' || name === 'sleep' || name === 'delay') {
          context.report({ node, messageId: 'sleep' });
        }
      },
    };
  },
};

const noWallClockInTests = {
  meta: {
    type: 'suggestion',
    docs: { description: '不要用墙上时钟的差值做断言' },
    schema: [],
    messages: {
      wallClock: '不要用 Date.now() / performance.now() 的差值做断言；断言事件、次数或持久化状态（见 AGENTS.md 测试规则）。',
    },
  },
  create(context) {
    if (!isTestFile(context.filename)) return {};
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        const root = memberRootName(node.callee);
        const isClock =
          (name === 'now' && (root === 'Date' || root === 'performance')) ||
          (name === 'now' && node.callee.type === 'Identifier' && node.callee.name === 'now');
        if (!isClock) return;
        const parent = node.parent;
        const inDifference = parent?.type === 'BinaryExpression' && parent.operator === '-';
        if (!inDifference) return;
        const inExpect = sourceCode
          .getAncestors(node)
          .some((ancestor) => ancestor.type === 'CallExpression' && calleeName(ancestor.callee) === 'expect');
        if (inExpect) context.report({ node, messageId: 'wallClock' });
      },
    };
  },
};

const QUARANTINE = /\/\/\s*quarantine:\s*#\d+/u;

const quarantineNeedsIssue = {
  meta: {
    type: 'problem',
    docs: { description: '跳过的测试必须带 tracking issue' },
    schema: [],
    messages: {
      missing: '跳过的测试必须在上方写 `// quarantine: #<issue> <原因>`，否则会变成永久遗忘的用例。',
    },
  },
  create(context) {
    if (!isTestFile(context.filename)) return {};
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (name !== 'skip' && name !== 'todo') return;
        const root = memberRootName(node.callee);
        if (root !== 'it' && root !== 'test' && root !== 'describe') return;
        const line = node.loc?.start.line ?? 0;
        const previous = line > 1 ? sourceCode.lines[line - 2] ?? '' : '';
        if (!QUARANTINE.test(previous)) {
          context.report({ node, messageId: 'missing' });
        }
      },
    };
  },
};

export default {
  rules: {
    'no-sleep-in-tests': noSleepInTests,
    'no-wall-clock-in-tests': noWallClockInTests,
    'quarantine-needs-issue': quarantineNeedsIssue,
  },
};
