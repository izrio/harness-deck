/**
 * 工作台 · Git 改动面板入口（已重构拆分为 `./git/*` 模块化 IDEA 风格 Git 工作台）。
 * 保持 `ChangesView` 与 `buildChangeDirTree` 导出以兼容既有引用与测试。
 */
export { GitWorkbench as ChangesView } from './git/GitWorkbench.tsx';
export { buildChangeDirTree } from './git/gitHelpers.ts';
