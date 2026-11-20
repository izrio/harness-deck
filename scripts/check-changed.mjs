#!/usr/bin/env node
/**
 * 变更检查（HD-12）：只对受影响的包跑 typecheck 与测试，减少提交前等待。
 *
 * - 改 `packages/shared`：shared + extension + webview-ui
 * - 改 `packages/extension`：extension
 * - 改 `packages/webview-ui`：webview-ui
 * - 改根配置 / lockfile：全部
 * - 只改文档、脚本、CI：不跑（返回 0）
 *
 * 用法：`pnpm check:changed`；加 `--dry-run` 只打印将执行的命令。
 */
import { spawnSync } from 'node:child_process';

const DRY_RUN = process.argv.includes('--dry-run');
const ROOT = process.cwd();

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败：${result.stderr.trim()}`);
  }
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

function changedFiles() {
  const tracked = git(['diff', '--name-only', 'HEAD']);
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  return [...new Set([...tracked, ...untracked])];
}

const ROOT_CONFIGS = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'eslint.config.mjs',
  'vitest.config.ts',
]);

const PACKAGE_LABEL = {
  'packages/shared': 'shared',
  'packages/extension': 'extension',
  'packages/webview-ui': 'webview-ui',
};

function affectedPackages(files) {
  const affected = new Set();
  let all = false;
  for (const file of files) {
    if (ROOT_CONFIGS.has(file) || file.startsWith('eslint-rules/')) {
      all = true;
      continue;
    }
    for (const [prefix, label] of Object.entries(PACKAGE_LABEL)) {
      if (file === prefix || file.startsWith(`${prefix}/`)) affected.add(label);
    }
  }
  if (all || affected.has('shared')) {
    return ['shared', 'extension', 'webview-ui'];
  }
  return [...affected];
}

function commandFor(pkg) {
  const filter = pkg === 'extension' ? 'harness-deck' : `@harness-deck/${pkg}`;
  return {
    typecheck: `pnpm --filter ${filter} run typecheck`,
    test: pkg === 'shared' ? 'pnpm test' : `pnpm exec vitest run packages/${pkg}/test`,
  };
}

const files = changedFiles();
if (files.length === 0) {
  console.log('没有未提交的改动。');
  process.exit(0);
}

const packages = affectedPackages(files);
if (packages.length === 0) {
  console.log(`改动 ${files.length} 个文件，均不影响代码包，跳过检查。`);
  process.exit(0);
}

const commands = ['pnpm lint'];
for (const pkg of packages) {
  commands.push(commandFor(pkg).typecheck);
}
if (packages.includes('shared')) {
  // shared 被两边依赖，直接跑全量测试，避免重复跑两套。
  commands.push('pnpm test');
} else {
  for (const pkg of packages) {
    commands.push(commandFor(pkg).test);
  }
}

console.log(`改动 ${files.length} 个文件，影响：${packages.join(', ')}`);
for (const command of commands) {
  console.log(`  $ ${command}`);
  if (DRY_RUN) continue;
  const result = spawnSync(command, { shell: true, stdio: 'inherit', cwd: ROOT });
  if (result.status !== 0) {
    console.error(`\n检查失败：${command}`);
    process.exit(result.status ?? 1);
  }
}

console.log(DRY_RUN ? '\n（dry-run，未执行）' : '\n变更检查通过。');
