import type { BackendView, ModelState, ProjectsState, ProviderView } from '@harness-deck/shared';

/** 没有从 Host 拿到智能体列表时使用的兜底清单。 */
export const FALLBACK_BACKENDS: readonly Pick<BackendView, 'id' | 'name'>[] = [
  { id: 'dsh', name: 'DeepSeek' },
  { id: 'zcode', name: 'ZCode' },
  { id: 'pi', name: 'Pi' },
  { id: 'codebuddy', name: 'CodeBuddy' },
  { id: 'claude', name: 'Claude Code' },
  { id: 'opencode', name: 'OpenCode' },
  { id: 'antigravity', name: 'Antigravity' },
];

/** 项目下拉选项：当前工作区优先，其后是最近项目（按路径去重）。返回 `[path, name]`。 */
export function getProjectOptions(projects: Pick<ProjectsState, 'currentPath' | 'recent'>): [string, string][] {
  const map = new Map<string, string>();
  if (projects.currentPath) {
    const name =
      projects.recent.find((r) => r.path === projects.currentPath)?.name ??
      projects.currentPath.split(/[\\/]/u).pop() ??
      projects.currentPath;
    map.set(projects.currentPath, name);
  }
  for (const r of projects.recent) {
    if (!map.has(r.path)) map.set(r.path, r.name);
  }
  return [...map.entries()];
}

/** 模型下拉选项：先放绑定到当前智能体的服务商，再放其余服务商，最后是运行时的 `models.options`，按键去重。 */
export function getMergedModels(
  backendId: string,
  providers: readonly ProviderView[],
  models: Pick<ModelState, 'options'>,
): { key: string; label: string }[] {
  const seen = new Set<string>();
  const list: { key: string; label: string }[] = [];
  const orderedProviders = [
    ...providers.filter((p) => p.boundBackendIds.includes(backendId)),
    ...providers.filter((p) => !p.boundBackendIds.includes(backendId)),
  ];
  for (const p of orderedProviders) {
    for (const m of p.models) {
      const key = `${p.id}::${m.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ key, label: `${m.name || m.id} (${p.name})` });
    }
  }
  for (const m of models.options) {
    const key = `${m.provider}::${m.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ key, label: `${m.name} (${m.group})` });
  }
  return list;
}
