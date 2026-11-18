// 用 esbuild 分别打包 VS Code 扩展入口（dist/extension.cjs）与无 vscode 依赖的独立守护入口（dist/sidecar.cjs）。
import { context, build } from 'esbuild';

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
};

const extensionOptions = {
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.cjs',
  // vscode 由 VS Code 宿主提供；bufferutil / utf-8-validate 是 ws 的可选原生加速依赖
  external: ['vscode', 'bufferutil', 'utf-8-validate'],
};

const sidecarOptions = {
  ...common,
  entryPoints: ['src/sidecar/entry.ts'],
  outfile: 'dist/sidecar.cjs',
  // 注意：sidecar 不包含 'vscode' external，若不慎引入 vscode 模块将在编译期立即报错拦截
  external: ['bufferutil', 'utf-8-validate'],
};

if (watch) {
  const [extCtx, sidecarCtx] = await Promise.all([context(extensionOptions), context(sidecarOptions)]);
  await Promise.all([extCtx.watch(), sidecarCtx.watch()]);
} else {
  await Promise.all([build(extensionOptions), build(sidecarOptions)]);
}
