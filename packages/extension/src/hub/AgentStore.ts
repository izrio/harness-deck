/**
 * 智能体（AgentProfile）预设存储与提示词组装。
 *
 * 保存每个智能体的专长（specialty）、系统指令（instructions）、底层与模型偏好、工具开关与权限预设；
 * 支持直接开始会话（应用模型与权限预设，并携带智能体角色指令）或接受任务委派。
 */
import { randomUUID } from 'node:crypto';
import type { AgentProfile, AgentToolConfig } from '@harness-deck/shared';

export interface UpsertAgentInput {
  readonly id?: string;
  readonly name: string;
  readonly specialty: string;
  readonly instructions: string;
  readonly backendId: string;
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly tools: AgentToolConfig;
}

export interface StoredAgentData {
  readonly items: readonly AgentProfile[];
  readonly deletedBuiltinIds: readonly string[];
}

export function builtinAgentProfiles(locale: 'zh' | 'en'): AgentProfile[] {
  if (locale === 'en') {
    return [
      {
        id: 'builtin-architect',
        name: 'System Architect',
        specialty: 'Architecture design, module boundaries & technical planning',
        instructions:
          'Analyze codebase architecture, data flow, and edge cases before proposing solutions. Output clear trade-offs, module contracts, and step-by-step execution plans without modifying files unless asked.',
        backendId: 'dsh',
        tools: {
          permissionPreset: 'read-only',
          readSearch: true,
          editWrite: false,
          bashCommand: false,
          webFetch: true,
          mcpTools: true,
        },
        builtin: true,
        updatedAt: 0,
      },
      {
        id: 'builtin-builder',
        name: 'Full-Stack Builder',
        specialty: 'End-to-end feature implementation, refactoring & verification',
        instructions:
          'Implement features cleanly following existing repository patterns and strict TypeScript types. Run typecheck, lint, and unit tests to verify all changes before finishing.',
        backendId: 'dsh',
        tools: {
          permissionPreset: 'workspace-write',
          readSearch: true,
          editWrite: true,
          bashCommand: true,
          webFetch: true,
          mcpTools: true,
        },
        builtin: true,
        updatedAt: 0,
      },
      {
        id: 'builtin-reviewer',
        name: 'Code Reviewer',
        specialty: 'Security, concurrency, lifecycle & UI consistency audit',
        instructions:
          'Perform a thorough code review focusing on correctness, race conditions, resource leaks, security boundaries, accessibility, and design consistency. Group findings by severity with exact file paths and fixes.',
        backendId: 'dsh',
        tools: {
          permissionPreset: 'read-only',
          readSearch: true,
          editWrite: false,
          bashCommand: true,
          webFetch: false,
          mcpTools: false,
        },
        builtin: true,
        updatedAt: 0,
      },
      {
        id: 'builtin-debugger',
        name: 'Bug Investigator',
        specialty: 'Root-cause diagnosis, reproduction tests & minimal fixes',
        instructions:
          'Reproduce the issue first, trace the root cause in code and logs, add a regression test, and apply a minimal, surgical fix.',
        backendId: 'dsh',
        tools: {
          permissionPreset: 'workspace-write',
          readSearch: true,
          editWrite: true,
          bashCommand: true,
          webFetch: false,
          mcpTools: true,
        },
        builtin: true,
        updatedAt: 0,
      },
    ];
  }

  return [
    {
      id: 'builtin-architect',
      name: '架构规划师',
      specialty: '架构设计、模块边界梳理与分步实施计划',
      instructions:
        '先深入阅读相关模块与数据流，梳理边界条件与潜在风险，给出清晰的方案对比、接口契约与分步实施计划；未获明确指令前不直接改动代码。',
      backendId: 'dsh',
      tools: {
        permissionPreset: 'read-only',
        readSearch: true,
        editWrite: false,
        bashCommand: false,
        webFetch: true,
        mcpTools: true,
      },
      builtin: true,
      updatedAt: 0,
    },
    {
      id: 'builtin-builder',
      name: '全栈工程师',
      specialty: '端到端功能开发、重构与自动化测试验证',
      instructions:
        '严格遵循仓库既有架构、代码风格与类型约束完成实现；完成后主动运行类型检查、Lint 与单元测试，确保零回归。',
      backendId: 'dsh',
      tools: {
        permissionPreset: 'workspace-write',
        readSearch: true,
        editWrite: true,
        bashCommand: true,
        webFetch: true,
        mcpTools: true,
      },
      builtin: true,
      updatedAt: 0,
    },
    {
      id: 'builtin-reviewer',
      name: '代码审查官',
      specialty: '架构合理性、并发安全、生命周期与 UI 一致性审查',
      instructions:
        '对代码变更进行全面审查，重点关注边界条件、竞态与资源泄漏、安全隔离、无障碍与视觉一致性；按严重程度列出问题位置与修复建议。',
      backendId: 'dsh',
      tools: {
        permissionPreset: 'read-only',
        readSearch: true,
        editWrite: false,
        bashCommand: true,
        webFetch: false,
        mcpTools: false,
      },
      builtin: true,
      updatedAt: 0,
    },
    {
      id: 'builtin-debugger',
      name: '故障排查专家',
      specialty: '根因定位、最小复现测试与精准修复',
      instructions:
        '先复现故障并顺着调用链定位根因，编写回归测试覆盖该场景，再以最小改动完成修复并验证通过。',
      backendId: 'dsh',
      tools: {
        permissionPreset: 'workspace-write',
        readSearch: true,
        editWrite: true,
        bashCommand: true,
        webFetch: false,
        mcpTools: true,
      },
      builtin: true,
      updatedAt: 0,
    },
  ];
}

function sanitizeTools(raw: unknown): AgentToolConfig {
  const t = (raw ?? {}) as Partial<AgentToolConfig>;
  const preset =
    t.permissionPreset === 'read-only' || t.permissionPreset === 'danger-full-access'
      ? t.permissionPreset
      : 'workspace-write';
  return {
    permissionPreset: preset,
    readSearch: t.readSearch !== false,
    editWrite: t.editWrite !== false,
    bashCommand: t.bashCommand !== false,
    webFetch: Boolean(t.webFetch),
    mcpTools: Boolean(t.mcpTools),
  };
}

export function parseStoredAgentData(raw: unknown): StoredAgentData {
  if (!raw || typeof raw !== 'object') {
    return { items: [], deletedBuiltinIds: [] };
  }
  const obj = raw as { items?: unknown; deletedBuiltinIds?: unknown };
  const deletedBuiltinIds = Array.isArray(obj.deletedBuiltinIds)
    ? obj.deletedBuiltinIds.filter((id): id is string => typeof id === 'string')
    : [];
  const items: AgentProfile[] = [];
  if (Array.isArray(obj.items)) {
    for (const entry of obj.items) {
      if (!entry || typeof entry !== 'object') continue;
      const a = entry as Partial<AgentProfile>;
      if (typeof a.id !== 'string' || typeof a.name !== 'string' || typeof a.specialty !== 'string' || typeof a.backendId !== 'string') {
        continue;
      }
      items.push({
        id: a.id,
        name: a.name,
        specialty: a.specialty,
        instructions: typeof a.instructions === 'string' ? a.instructions : '',
        backendId: a.backendId,
        ...(typeof a.provider === 'string' && a.provider ? { provider: a.provider } : {}),
        ...(typeof a.model === 'string' && a.model ? { model: a.model } : {}),
        ...(typeof a.reasoningEffort === 'string' && a.reasoningEffort ? { reasoningEffort: a.reasoningEffort } : {}),
        tools: sanitizeTools(a.tools),
        ...(a.builtin ? { builtin: true } : {}),
        updatedAt: typeof a.updatedAt === 'number' ? a.updatedAt : 0,
      });
    }
  }
  return { items, deletedBuiltinIds };
}

/** 合并内置智能体与用户自定义/覆盖项。 */
export function resolveAgentProfiles(stored: StoredAgentData, locale: 'zh' | 'en'): AgentProfile[] {
  const builtins = builtinAgentProfiles(locale);
  const deleted = new Set(stored.deletedBuiltinIds);
  const byId = new Map<string, AgentProfile>();
  for (const b of builtins) {
    if (!deleted.has(b.id)) byId.set(b.id, b);
  }
  const customOrder: AgentProfile[] = [];
  for (const item of stored.items) {
    if (byId.has(item.id)) {
      byId.set(item.id, { ...item, builtin: true });
    } else if (!builtins.some((b) => b.id === item.id)) {
      customOrder.push(item);
    } else if (!deleted.has(item.id)) {
      byId.set(item.id, { ...item, builtin: true });
    }
  }
  return [
    ...customOrder,
    ...builtins.filter((b) => byId.has(b.id)).map((b) => byId.get(b.id)!),
  ];
}

export function upsertStoredAgent(
  stored: StoredAgentData,
  input: UpsertAgentInput,
  nowMs: number,
  locale: 'zh' | 'en',
): { readonly stored: StoredAgentData; readonly agent: AgentProfile } {
  const builtins = builtinAgentProfiles(locale);
  const id = input.id?.trim() || `agent-${randomUUID().slice(0, 8)}`;
  const isBuiltin = builtins.some((b) => b.id === id);
  const agent: AgentProfile = {
    id,
    name: input.name.trim(),
    specialty: input.specialty.trim(),
    instructions: input.instructions.trim(),
    backendId: input.backendId,
    ...(input.provider?.trim() ? { provider: input.provider.trim() } : {}),
    ...(input.model?.trim() ? { model: input.model.trim() } : {}),
    ...(input.reasoningEffort?.trim() ? { reasoningEffort: input.reasoningEffort.trim() } : {}),
    tools: sanitizeTools(input.tools),
    ...(isBuiltin ? { builtin: true } : {}),
    updatedAt: nowMs,
  };
  const existingIdx = stored.items.findIndex((a) => a.id === id);
  const nextItems =
    existingIdx >= 0
      ? stored.items.map((a, idx) => (idx === existingIdx ? agent : a))
      : [agent, ...stored.items];
  const nextDeleted = stored.deletedBuiltinIds.filter((d) => d !== id);
  return {
    stored: { items: nextItems, deletedBuiltinIds: nextDeleted },
    agent,
  };
}

export function deleteStoredAgent(stored: StoredAgentData, id: string, locale: 'zh' | 'en'): StoredAgentData {
  const isBuiltin = builtinAgentProfiles(locale).some((b) => b.id === id);
  const nextItems = stored.items.filter((a) => a.id !== id);
  const nextDeleted =
    isBuiltin && !stored.deletedBuiltinIds.includes(id)
      ? [...stored.deletedBuiltinIds, id]
      : [...stored.deletedBuiltinIds];
  return { items: nextItems, deletedBuiltinIds: nextDeleted };
}

/**
 * 将智能体的专长、指令与工具边界组合成会话首轮上下文指令，兼容 dsh 与所有外部 ACP 底层。
 */
export function composeAgentPrompt(agent: AgentProfile, taskPrompt: string): string {
  const allowed: string[] = [];
  const disallowed: string[] = [];
  const pushTool = (enabled: boolean, label: string) => (enabled ? allowed.push(label) : disallowed.push(label));
  pushTool(agent.tools.readSearch, 'read/search files');
  pushTool(agent.tools.editWrite, 'edit/write files');
  pushTool(agent.tools.bashCommand, 'terminal/shell commands');
  pushTool(agent.tools.webFetch, 'web search/fetch');
  pushTool(agent.tools.mcpTools, 'MCP tools');

  const headerLines = [
    `<agent_profile name="${agent.name.replace(/"/gu, "'")}">`,
    `Specialty: ${agent.specialty}`,
    ...(agent.instructions ? [`Instructions:\n${agent.instructions}`] : []),
    `Allowed capabilities: ${allowed.length > 0 ? allowed.join(', ') : 'conversation only'}`,
    ...(disallowed.length > 0 ? [`Restricted capabilities (do NOT invoke unless explicitly approved): ${disallowed.join(', ')}`] : []),
    `</agent_profile>`,
  ];
  const trimmedTask = taskPrompt.trim();
  return trimmedTask ? `${headerLines.join('\n')}\n\n${trimmedTask}` : headerLines.join('\n');
}
