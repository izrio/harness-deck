/**
 * Harness Deck Oxlint JS 插件（迁移自 eslint-rules/test-discipline.mjs + UI 边界约束）：
 * - `no-sleep-in-tests`：测试里不要用 sleep / 定时器等真实时间
 * - `no-wall-clock-in-tests`：不要用 Date.now() / performance.now() 的差值做断言
 * - `quarantine-needs-issue`：it.skip / describe.skip / it.todo 必须在上方写 `// quarantine: #<issue> <原因>`
 * - `no-uppercase-ui-import`：禁止从 `ui/[A-Z]*` 导入非 shadcn 官方小写组件
 * - `no-iconify-root-import`：禁止整包导入 `@iconify-icons/<set>` 索引，必须按单图标子路径导入
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
    const sourceCode = context.sourceCode;
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
        const ancestors =
          typeof sourceCode?.getAncestors === 'function'
            ? sourceCode.getAncestors(node)
            : (() => {
                const list = [];
                let cur = node.parent;
                while (cur) {
                  list.push(cur);
                  cur = cur.parent;
                }
                return list;
              })();
        const inExpect = ancestors.some(
          (ancestor) => ancestor.type === 'CallExpression' && calleeName(ancestor.callee) === 'expect',
        );
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
    const sourceCode = context.sourceCode;
    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (name !== 'skip' && name !== 'todo') return;
        const root = memberRootName(node.callee);
        if (root !== 'it' && root !== 'test' && root !== 'describe') return;
        const line = node.loc?.start.line ?? 0;
        const previous = line > 1 ? (sourceCode?.lines?.[line - 2] ?? '') : '';
        if (!QUARANTINE.test(previous)) {
          context.report({ node, messageId: 'missing' });
        }
      },
    };
  },
};

const UPPERCASE_UI_IMPORT = /(?:^|\/)ui\/[A-Z]/u;

const noUppercaseUiImport = {
  meta: {
    type: 'problem',
    docs: { description: 'src/components/ui/ 仅限通过 shadcn CLI 安装的官方小写组件文件' },
    schema: [],
    messages: {
      uppercaseUi: 'src/components/ui/ 仅限通过 shadcn CLI 安装的官方小写组件文件，禁止手写新造基础组件（见 AGENTS.md）。',
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const value = node.source?.value;
        if (typeof value === 'string' && UPPERCASE_UI_IMPORT.test(value)) {
          context.report({ node, messageId: 'uppercaseUi' });
        }
      },
    };
  },
};

const ICONIFY_ROOT_IMPORT = /^@iconify-icons\/[^/]+$/u;

const noIconifyRootImport = {
  meta: {
    type: 'problem',
    docs: { description: '禁止整包导入 @iconify-icons/<set> 索引，必须按单图标子路径导入' },
    schema: [],
    messages: {
      rootImport: '请按单图标子路径导入（如 @iconify-icons/lucide/check），禁止引入整包图标索引（见 AGENTS.md）。',
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const value = node.source?.value;
        if (typeof value === 'string' && ICONIFY_ROOT_IMPORT.test(value)) {
          context.report({ node, messageId: 'rootImport' });
        }
      },
    };
  },
};

export default {
  meta: { name: 'harness-deck' },
  rules: {
    'no-sleep-in-tests': noSleepInTests,
    'no-wall-clock-in-tests': noWallClockInTests,
    'quarantine-needs-issue': quarantineNeedsIssue,
    'no-uppercase-ui-import': noUppercaseUiImport,
    'no-iconify-root-import': noIconifyRootImport,
  },
};
