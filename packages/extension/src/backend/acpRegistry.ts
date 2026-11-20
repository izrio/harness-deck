/**
 * ACP 注册表解析（HD-21）：接受 `[...]` 或 `{ entries: [...] }`，只保留安全、完整的条目。
 *
 * 注册表只用于「发现 + 展示安装命令」；这里不执行任何安装或命令。
 */
import type { AcpRegistryEntry } from '@harness-deck/shared';

const MAX_ENTRIES = 50;
const MAX_TEXT = 2_000;

function text(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 50);
  return list.length > 0 ? list : undefined;
}

/** 解析并校验注册表。格式不对时抛出可读错误。 */
export function parseAcpRegistry(raw: unknown): AcpRegistryEntry[] {
  const source = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { entries?: unknown }).entries)
    ? (raw as { entries: unknown[] }).entries
    : undefined;
  if (!source) throw new Error('registry must be an array or { entries: [...] }');
  if (source.length > MAX_ENTRIES) throw new Error(`registry has too many entries (max ${MAX_ENTRIES})`);

  const seen = new Set<string>();
  const entries: AcpRegistryEntry[] = [];
  for (const item of source) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const id = text(obj.id, 100);
    const name = text(obj.name, 100);
    const command = text(obj.command, 1_000);
    if (!id || !name || !command || seen.has(id)) continue;
    seen.add(id);
    const args = stringList(obj.args);
    const description = text(obj.description);
    const install = text(obj.install);
    const docs = text(obj.docs);
    entries.push({
      id,
      name,
      command,
      ...(args ? { args } : {}),
      ...(description ? { description } : {}),
      ...(install ? { install } : {}),
      ...(docs ? { docs } : {}),
    });
  }
  if (entries.length === 0) throw new Error('registry has no valid entries');
  return entries;
}
