/**
 * 定时任务状态与触发引擎（纯状态变换，便于单元测试）。
 *
 * 每条定时规则保存自身的执行历史（`runs`），产生的后台会话 id 记录在 `hiddenSessionIds` 中，
 * 确保不会进入左侧会话列表或按项目分组的会话列表。
 */
import { randomUUID } from 'node:crypto';
import type { ScheduleFrequency, ScheduleRule, ScheduleRunRecord } from '@harness-deck/shared';
import { normalizeProjectPath } from '../projects/ProjectService.ts';

export const MAX_RUNS_PER_RULE = 30;
export const MAX_HIDDEN_SESSIONS = 1_000;

export interface StoredScheduleData {
  readonly rules: readonly ScheduleRule[];
  readonly hiddenSessionIds: readonly string[];
}

export interface UpsertScheduleInput {
  readonly id?: string;
  readonly name: string;
  readonly prompt: string;
  readonly frequency: ScheduleFrequency;
  readonly backendId: string;
  readonly projectPath: string;
  readonly enabled?: boolean;
}

function parseTimeHm(time: string): { hours: number; minutes: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(time.trim());
  if (!match) return { hours: 9, minutes: 0 };
  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

function isoWeekday(date: Date): number {
  const day = date.getDay();
  return day === 0 ? 7 : day;
}

/**
 * 计算规则下一次触发时间（毫秒时间戳）。
 * - `daily`：今天（若尚未过点）或明天的 HH:mm
 * - `weekly`：未来 7 天内最近一个匹配星期几的 HH:mm（1=周一 … 7=周日）
 * - `interval`：`nowMs + minutes * 60_000`
 * - `once`：若 `runAt > nowMs` 返回 `runAt`，否则返回 `undefined`
 */
export function computeNextRunAt(frequency: ScheduleFrequency, nowMs: number): number | undefined {
  switch (frequency.kind) {
    case 'daily': {
      const { hours, minutes } = parseTimeHm(frequency.time);
      const candidate = new Date(nowMs);
      candidate.setHours(hours, minutes, 0, 0);
      if (candidate.getTime() <= nowMs) {
        candidate.setDate(candidate.getDate() + 1);
      }
      return candidate.getTime();
    }
    case 'weekly': {
      const validDays = new Set(frequency.days.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7));
      if (validDays.size === 0) validDays.add(1);
      const { hours, minutes } = parseTimeHm(frequency.time);
      for (let offset = 0; offset <= 7; offset++) {
        const candidate = new Date(nowMs);
        candidate.setDate(candidate.getDate() + offset);
        candidate.setHours(hours, minutes, 0, 0);
        if (validDays.has(isoWeekday(candidate)) && candidate.getTime() > nowMs) {
          return candidate.getTime();
        }
      }
      return undefined;
    }
    case 'interval': {
      const mins = Math.max(1, Math.min(10_080, Math.round(frequency.minutes)));
      return nowMs + mins * 60_000;
    }
    case 'once': {
      return Number.isFinite(frequency.runAt) && frequency.runAt > nowMs ? frequency.runAt : undefined;
    }
  }
}

/** 启动时恢复数据：清理上次宿主关闭时遗留的 running 状态并重算 nextRunAt。 */
export function parseStoredScheduleData(raw: unknown, nowMs: number, interruptedNote: string): StoredScheduleData {
  if (!raw || typeof raw !== 'object') {
    return { rules: [], hiddenSessionIds: [] };
  }
  const obj = raw as { rules?: unknown; hiddenSessionIds?: unknown };
  const hiddenSessionIds = Array.isArray(obj.hiddenSessionIds)
    ? obj.hiddenSessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(-MAX_HIDDEN_SESSIONS)
    : [];

  const rules: ScheduleRule[] = [];
  if (Array.isArray(obj.rules)) {
    for (const item of obj.rules) {
      if (!item || typeof item !== 'object') continue;
      const r = item as Partial<ScheduleRule>;
      if (typeof r.id !== 'string' || typeof r.name !== 'string' || typeof r.prompt !== 'string') continue;
      if (!r.frequency || typeof r.frequency !== 'object' || typeof r.backendId !== 'string' || typeof r.projectPath !== 'string') continue;
      const rawRuns = Array.isArray(r.runs) ? r.runs : [];
      const runs: ScheduleRunRecord[] = rawRuns
        .filter((run): run is ScheduleRunRecord => Boolean(run && typeof run === 'object' && typeof (run as ScheduleRunRecord).id === 'string'))
        .map((run) =>
          run.status === 'running'
            ? { ...run, status: 'failed' as const, endedAt: nowMs, error: run.error ?? interruptedNote }
            : run,
        )
        .slice(0, MAX_RUNS_PER_RULE);

      const enabled = Boolean(r.enabled);
      const lastStatus = r.lastStatus === 'running' ? 'failed' : r.lastStatus;
      // 若规则仍启用但没有有效的 nextRunAt（或为过期单次任务），保留到期时间戳以便启动后补触发一次，若原本缺失则重算
      const nextRunAt = enabled
        ? typeof r.nextRunAt === 'number' && Number.isFinite(r.nextRunAt)
          ? r.nextRunAt
          : computeNextRunAt(r.frequency, nowMs)
        : undefined;

      const projectPath = normalizeProjectPath(r.projectPath) || r.projectPath;
      rules.push({
        id: r.id,
        name: r.name,
        prompt: r.prompt,
        frequency: r.frequency,
        backendId: r.backendId,
        projectPath,
        enabled: enabled && (r.frequency.kind !== 'once' || nextRunAt !== undefined),
        createdAt: typeof r.createdAt === 'number' ? r.createdAt : nowMs,
        ...(nextRunAt !== undefined ? { nextRunAt } : {}),
        ...(typeof r.lastRunAt === 'number' ? { lastRunAt: r.lastRunAt } : {}),
        ...(lastStatus ? { lastStatus } : {}),
        runs,
      });
    }
  }
  return { rules, hiddenSessionIds };
}

export function upsertScheduleRule(
  rules: readonly ScheduleRule[],
  input: UpsertScheduleInput,
  nowMs: number,
): { readonly rules: ScheduleRule[]; readonly rule: ScheduleRule } {
  const existing = input.id ? rules.find((r) => r.id === input.id) : undefined;
  const enabled = input.enabled ?? existing?.enabled ?? true;
  const nextRunAt = enabled ? computeNextRunAt(input.frequency, nowMs) : undefined;
  const effectiveEnabled = enabled && (input.frequency.kind !== 'once' || nextRunAt !== undefined);
  const projectPath = normalizeProjectPath(input.projectPath) || input.projectPath;

  const rule: ScheduleRule = {
    id: existing?.id ?? input.id ?? `sched-${randomUUID().slice(0, 8)}`,
    name: input.name.trim(),
    prompt: input.prompt.trim(),
    frequency: input.frequency,
    backendId: input.backendId,
    projectPath,
    enabled: effectiveEnabled,
    createdAt: existing?.createdAt ?? nowMs,
    ...(effectiveEnabled && nextRunAt !== undefined ? { nextRunAt } : {}),
    ...(existing?.lastRunAt !== undefined ? { lastRunAt: existing.lastRunAt } : {}),
    ...(existing?.lastStatus ? { lastStatus: existing.lastStatus } : {}),
    runs: existing?.runs ?? [],
  };

  const nextRules = existing
    ? rules.map((r) => (r.id === rule.id ? rule : r))
    : [rule, ...rules];
  return { rules: [...nextRules], rule };
}

export function toggleScheduleRule(
  rules: readonly ScheduleRule[],
  id: string,
  enabled: boolean,
  nowMs: number,
): ScheduleRule[] {
  return rules.map((r) => {
    if (r.id !== id) return r;
    const nextRunAt = enabled
      ? computeNextRunAt(
          r.frequency.kind === 'once' && r.frequency.runAt <= nowMs
            ? { kind: 'once', runAt: nowMs + 60_000 }
            : r.frequency,
          nowMs,
        )
      : undefined;
    const { nextRunAt: _omit, ...rest } = r;
    return {
      ...rest,
      enabled: enabled && nextRunAt !== undefined,
      ...(enabled && nextRunAt !== undefined ? { nextRunAt } : {}),
    };
  });
}

export function deleteScheduleRule(rules: readonly ScheduleRule[], id: string): ScheduleRule[] {
  return rules.filter((r) => r.id !== id);
}

/** 找出当前到点且不在运行中的规则。 */
export function findDueRules(rules: readonly ScheduleRule[], nowMs: number, runningRuleIds: ReadonlySet<string>): ScheduleRule[] {
  return rules.filter(
    (r) =>
      r.enabled &&
      r.lastStatus !== 'running' &&
      !runningRuleIds.has(r.id) &&
      r.nextRunAt !== undefined &&
      r.nextRunAt <= nowMs,
  );
}

export function beginScheduleRun(
  rules: readonly ScheduleRule[],
  ruleId: string,
  nowMs: number,
): { readonly rules: ScheduleRule[]; readonly run: ScheduleRunRecord | undefined } {
  const target = rules.find((r) => r.id === ruleId);
  if (!target) return { rules: [...rules], run: undefined };
  const run: ScheduleRunRecord = {
    id: `run-${randomUUID().slice(0, 8)}`,
    ruleId: target.id,
    startedAt: nowMs,
    status: 'running',
    backendId: target.backendId,
    projectPath: target.projectPath,
  };
  const nextRules = rules.map((r) => {
    if (r.id !== ruleId) return r;
    // 单次规则一旦触发立即关闭后续自动触发；周期规则先推进 nextRunAt，避免重复触发
    const nextEnabled = r.frequency.kind === 'once' ? false : r.enabled;
    const nextRunAt = nextEnabled ? computeNextRunAt(r.frequency, nowMs) : undefined;
    const { nextRunAt: _omit, ...rest } = r;
    return {
      ...rest,
      enabled: nextEnabled,
      ...(nextRunAt !== undefined ? { nextRunAt } : {}),
      lastRunAt: nowMs,
      lastStatus: 'running' as const,
      runs: [run, ...r.runs].slice(0, MAX_RUNS_PER_RULE),
    };
  });
  return { rules: nextRules, run };
}

export function attachRunSessionId(
  rules: readonly ScheduleRule[],
  ruleId: string,
  runId: string,
  sessionId: string,
): ScheduleRule[] {
  return rules.map((r) =>
    r.id === ruleId
      ? {
          ...r,
          runs: r.runs.map((run) => (run.id === runId ? { ...run, sessionId } : run)),
        }
      : r,
  );
}

export function finishScheduleRun(
  rules: readonly ScheduleRule[],
  ruleId: string,
  runId: string,
  outcome: {
    readonly status: 'succeeded' | 'failed';
    readonly endedAt: number;
    readonly sessionId?: string;
    readonly output?: string;
    readonly error?: string;
  },
): ScheduleRule[] {
  return rules.map((r) => {
    if (r.id !== ruleId) return r;
    const nextRunAt = r.enabled ? computeNextRunAt(r.frequency, outcome.endedAt) : undefined;
    const { nextRunAt: _omit, ...rest } = r;
    return {
      ...rest,
      ...(nextRunAt !== undefined ? { nextRunAt } : {}),
      lastStatus: outcome.status,
      runs: r.runs.map((run) =>
        run.id === runId
          ? {
              ...run,
              status: outcome.status,
              endedAt: outcome.endedAt,
              ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
              ...(outcome.output ? { output: outcome.output } : {}),
              ...(outcome.error ? { error: outcome.error } : {}),
              unread: true,
            }
          : run,
      ),
    };
  });
}

export function markScheduleRunAsRead(
  rules: readonly ScheduleRule[],
  ruleId?: string,
  runId?: string,
): ScheduleRule[] {
  return rules.map((r) => {
    if (ruleId && r.id !== ruleId) return r;
    const changed = r.runs.some((run) => (!runId || run.id === runId) && run.unread);
    if (!changed) return r;
    return {
      ...r,
      runs: r.runs.map((run) => {
        if (runId && run.id !== runId) return run;
        const { unread: _omit, ...rest } = run;
        return rest;
      }),
    };
  });
}

export function appendHiddenSessionId(existing: readonly string[], sessionId: string): string[] {
  if (!sessionId || existing.includes(sessionId)) return [...existing];
  return [...existing, sessionId].slice(-MAX_HIDDEN_SESSIONS);
}
