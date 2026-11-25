// 打包 VS Code 插件，产物统一命名为 Halo-<version>-vscode.vsix（保持扩展 ID izrio.harness-deck 不变）。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
const outFile = `Halo-${version}-vscode.vsix`;

const binName = process.platform === 'win32' ? 'vsce.cmd' : 'vsce';
const localBin = join(root, 'node_modules', '.bin', binName);
const vsceCmd = existsSync(localBin) ? localBin : binName;

execFileSync(
  vsceCmd,
  ['package', '--no-dependencies', '--skip-license', '-o', outFile, ...process.argv.slice(2)],
  {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
);
