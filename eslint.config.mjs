// ESLint：只做能发现真实问题的检查（未使用的变量、悬空的 Promise、Hooks 规则），不管排版——排版没有统一过，一刀切格式化会淹没历史。
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const WEBVIEW_RESTRICTED_PATHS = [
  {
    name: '@iconify/react',
    message: '插件 Webview 必须支持离线与严格 CSP，请改用 @iconify/react/offline 或 src/components/icons.tsx（见 AGENTS.md）。',
  },
  {
    name: 'react-icons',
    message: '项目图标统一使用 Iconify 离线方案（@iconify/react/offline + @iconify-icons/*），禁止引入其他图标库（见 AGENTS.md）。',
  },
  {
    name: '@tabler/icons-react',
    message: '项目图标统一使用 Iconify 离线方案（@iconify/react/offline + @iconify-icons/*），禁止引入其他图标库（见 AGENTS.md）。',
  },
  {
    name: 'feather-icons',
    message: '项目图标统一使用 Iconify 离线方案（@iconify/react/offline + @iconify-icons/*），禁止引入其他图标库（见 AGENTS.md）。',
  },
];

const WEBVIEW_RESTRICTED_PATTERNS = [
  {
    group: ['@mui/*', 'antd', 'antd/*', '@chakra-ui/*', '@mantine/*', '@arco-design/*', '@headlessui/*', 'naive-ui', 'primereact/*'],
    message: '项目组件库仅允许使用 shadcn-ui 与 beautifului，禁止引入其他 UI 组件库（见 AGENTS.md）。',
  },
  {
    group: ['@heroicons/*', 'react-icons/*', '@phosphor-icons/*'],
    message: '项目图标统一使用 Iconify 离线方案（@iconify/react/offline + @iconify-icons/*），禁止引入其他图标库（见 AGENTS.md）。',
  },
  {
    group: ['@iconify-json/*'],
    message: '禁止直接导入全量 @iconify-json/* 图标集 JSON，请改用按需打包的 @iconify-icons/<set>/<name> 单图标子路径（见 AGENTS.md）。',
  },
  {
    regex: '^@iconify-icons/[^/]+$',
    message: '请按单图标子路径导入（如 @iconify-icons/lucide/check），禁止引入整包图标索引（见 AGENTS.md）。',
  },
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.vsix', '.e2e-screenshots/**', 'packages/jetbrains/build/**', '**/.gradle/**', '**/.intellijPlatform/**', '**/.kotlin/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/**/*.{ts,tsx}', '*.ts'],
    languageOptions: {
      parserOptions: { projectService: { allowDefaultProject: ['vitest.config.ts'] }, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // 没有 await、也没有 void 的 Promise：出错时没人知道
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      // 下划线开头表示有意不用（解构时丢掉的字段、接口要求的参数）
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true }],
      // `a && b()`、三元表达式当语句用是这个代码库的常见写法
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
      // 终端颜色控制符的正则里需要控制字符
      'no-control-regex': 'off',
    },
  },
  {
    files: ['packages/webview-ui/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      // 这里的 effect 大多有意只在某几个值变化时运行（见各处注释），依赖检查只提示不拦
      'react-hooks/exhaustive-deps': 'off',
      // 组件库与图标边界：只允许使用 shadcn-ui（src/components/ui 小写官方组件）、beautifului 与离线 Iconify
      'no-restricted-imports': [
        'error',
        {
          paths: WEBVIEW_RESTRICTED_PATHS,
          patterns: WEBVIEW_RESTRICTED_PATTERNS,
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportDeclaration[source.value=/(?:^|\\/)ui\\/[A-Z]/]',
          message: 'src/components/ui/ 仅限通过 shadcn CLI 安装的官方小写组件文件，禁止手写新造基础组件（见 AGENTS.md）。',
        },
      ],
    },
  },
  {
    // 业务组件与 beautifului 禁止直接导入 lucide-react（仅豁免 shadcn CLI 生成的 src/components/ui/*）
    files: ['packages/webview-ui/src/**/*.{ts,tsx}'],
    ignores: ['packages/webview-ui/src/components/ui/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...WEBVIEW_RESTRICTED_PATHS,
            {
              name: 'lucide-react',
              message: '业务与 beautifului 图标统一使用离线 Iconify（src/components/icons.tsx 或 @iconify/react/offline + @iconify-icons/*），禁止直接导入 lucide-react（见 AGENTS.md）。',
            },
          ],
          patterns: WEBVIEW_RESTRICTED_PATTERNS,
        },
      ],
    },
  },
  {
    files: ['packages/extension/**/*.ts', '*.{ts,mjs}', 'packages/*/vite.config.ts', 'packages/extension/scripts/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    // 端到端脚本里有传给浏览器执行的回调
    files: ['packages/extension/scripts/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
);
