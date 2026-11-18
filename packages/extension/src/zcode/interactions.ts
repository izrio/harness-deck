/**
 * ZCode 反向交互请求管理：
 * - `session/requestRuntimePreferences`：立即应答运行时偏好，防止会话握手挂起（-32022）；
 * - `interaction/requestPermission`：工具执行审批（支持未保存文件拦截、「始终允许」、以及重复广播合并）；
 * - `interaction/requestUserInput`：提问卡片与计划审阅（`AskUserQuestion` / `ExitPlanMode`）。
 */
import { isAbsolute, resolve } from 'node:path';
import type { PendingInteraction, QuestionView } from '@harness-deck/shared';
import { inputFilePath } from '../acp/projection.ts';
import { t } from '../i18n.ts';
import { displayPath } from '../vm/paths.ts';
import { canonicalTool } from '../vm/toolNames.ts';
import { parseArguments, toolVariant } from '../vm/toolRows.ts';
import type { ZcodeToolState } from './projection.ts';

export interface RuntimePreferencesResponse {
  readonly nativeSearchEnhancementsEnabled: boolean;
  readonly memoryEnabled: boolean;
  readonly askUserQuestionAutoResolutionEnabled: boolean;
  readonly modelContextBudgetStrategy: string;
}

export function defaultRuntimePreferences(unattended = false): RuntimePreferencesResponse {
  return {
    nativeSearchEnhancementsEnabled: true,
    memoryEnabled: true,
    askUserQuestionAutoResolutionEnabled: unattended,
    modelContextBudgetStrategy: 'auto',
  };
}

export type QuestionAnswerPayload =
  | { readonly id: string; readonly answers: readonly { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }[] }
  | { readonly id: string; readonly cancelled: true };

interface PendingApprovalEntry {
  readonly kind: 'approval';
  readonly id: string;
  readonly dedupeKey?: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly reason: string;
  readonly permissionUpdates?: unknown;
  readonly resolvers: ((result: unknown) => void)[];
}

interface PendingQuestionEntry {
  readonly kind: 'question';
  readonly id: string;
  readonly dedupeKey?: string;
  readonly sessionId: string;
  readonly questions: readonly QuestionView[];
  readonly resolvers: ((result: unknown) => void)[];
}

type PendingEntry = PendingApprovalEntry | PendingQuestionEntry;

export class ZcodeInteractionManager {
  private readonly entries = new Map<string, PendingEntry>();
  private counter = 0;

  constructor(
    private readonly getWorkspacePath: () => string,
    private readonly getDirtyFiles: () => readonly string[],
    private readonly getKnownTool: (sessionId: string, callId: string) => ZcodeToolState | undefined,
    private readonly onChange: () => void,
  ) {}

  clear(sessionId?: string): void {
    for (const [id, entry] of this.entries) {
      if (sessionId !== undefined && entry.sessionId !== sessionId) continue;
      const cancelResult =
        entry.kind === 'approval' ? { decision: 'deny', cancelled: true } : { action: 'cancel', cancelled: true };
      for (const resolveFn of entry.resolvers) resolveFn(cancelResult);
      this.entries.delete(id);
    }
  }

  sessionsWaiting(): Set<string> {
    return new Set([...this.entries.values()].map((e) => e.sessionId));
  }

  viewsFor(sessionId: string | undefined): PendingInteraction[] {
    if (!sessionId) return [];
    const workspacePath = this.getWorkspacePath();
    const result: PendingInteraction[] = [];
    for (const entry of this.entries.values()) {
      if (entry.sessionId !== sessionId) continue;
      if (entry.kind === 'approval') {
        result.push(this.approvalView(entry, workspacePath));
      } else {
        result.push({ kind: 'question', id: entry.id, questions: entry.questions });
      }
    }
    return result;
  }

  requestPermission(rawParams: unknown, fallbackSessionId: string | undefined): Promise<unknown> {
    const params = rawParams && typeof rawParams === 'object' ? (rawParams as Record<string, unknown>) : {};
    const sessionId = typeof params.sessionId === 'string' && params.sessionId ? params.sessionId : (fallbackSessionId ?? '');
    if (!sessionId) return Promise.resolve({ decision: 'deny' });

    const callId =
      typeof params.toolCallId === 'string'
        ? params.toolCallId
        : typeof params.callId === 'string'
          ? params.callId
          : typeof params.requestId === 'string'
            ? params.requestId
            : undefined;
    const dedupeKey = callId ? `perm:${sessionId}:${callId}` : undefined;
    if (dedupeKey) {
      const existing = [...this.entries.values()].find((e) => e.dedupeKey === dedupeKey);
      if (existing) {
        return new Promise((res) => {
          existing.resolvers.push(res);
        });
      }
    }

    const known = callId ? this.getKnownTool(sessionId, callId) : undefined;
    const toolName =
      typeof params.toolName === 'string'
        ? params.toolName
        : typeof params.tool === 'string'
          ? params.tool
          : (known?.toolName ?? 'tool');
    const parsedInput = parseArguments(params.input ?? params.arguments ?? params.args);
    const input = Object.keys(parsedInput).length > 0 ? parsedInput : (known?.input ?? {});
    const reason =
      typeof params.reason === 'string'
        ? params.reason
        : typeof params.description === 'string'
          ? params.description
          : typeof params.message === 'string'
            ? params.message
            : '';

    return new Promise((resolvePermission) => {
      const id = `zc-perm-${++this.counter}`;
      this.entries.set(id, {
        kind: 'approval',
        id,
        ...(dedupeKey ? { dedupeKey } : {}),
        sessionId,
        toolName,
        input,
        reason,
        ...(params.permissionUpdates !== undefined ? { permissionUpdates: params.permissionUpdates } : {}),
        resolvers: [resolvePermission],
      });
      this.onChange();
    });
  }

  requestUserInput(rawParams: unknown, fallbackSessionId: string | undefined): Promise<unknown> {
    const params = rawParams && typeof rawParams === 'object' ? (rawParams as Record<string, unknown>) : {};
    const sessionId = typeof params.sessionId === 'string' && params.sessionId ? params.sessionId : (fallbackSessionId ?? '');
    if (!sessionId) return Promise.resolve({ action: 'cancel', cancelled: true });

    const reqId = typeof params.requestId === 'string' ? params.requestId : typeof params.toolCallId === 'string' ? params.toolCallId : undefined;
    const dedupeKey = reqId ? `q:${sessionId}:${reqId}` : undefined;
    if (dedupeKey) {
      const existing = [...this.entries.values()].find((e) => e.dedupeKey === dedupeKey);
      if (existing) {
        return new Promise((res) => {
          existing.resolvers.push(res);
        });
      }
    }

    const questions = parseQuestions(params);
    if (questions.length === 0) {
      return Promise.resolve({ action: 'cancel', cancelled: true });
    }

    return new Promise((resolveQuestion) => {
      const id = `zc-q-${++this.counter}`;
      this.entries.set(id, {
        kind: 'question',
        id,
        ...(dedupeKey ? { dedupeKey } : {}),
        sessionId,
        questions,
        resolvers: [resolveQuestion],
      });
      this.onChange();
    });
  }

  respondApproval(id: string, decision: 'allow' | 'allowAlways' | 'reject'): { readonly ok: boolean; readonly error?: string } {
    const entry = this.entries.get(id);
    if (!entry || entry.kind !== 'approval') return { ok: false, error: t('request.ended') };
    if (decision !== 'reject') {
      const dirty = this.dirtyTargetsFor(entry, this.getWorkspacePath());
      if (dirty.length > 0) return { ok: false, error: t('approval.dirty') };
    }
    this.entries.delete(id);
    const payload =
      decision === 'reject'
        ? { decision: 'deny' }
        : decision === 'allowAlways'
          ? {
              decision: 'allow',
              remember: true,
              scope: 'session',
              ...(entry.permissionUpdates !== undefined ? { permissionUpdates: entry.permissionUpdates } : {}),
            }
          : { decision: 'allow' };
    for (const resolveFn of entry.resolvers) resolveFn(payload);
    this.onChange();
    return { ok: true };
  }

  answerQuestion(payload: QuestionAnswerPayload): boolean {
    const entry = this.entries.get(payload.id);
    if (!entry || entry.kind !== 'question') return false;
    this.entries.delete(payload.id);
    if ('cancelled' in payload) {
      for (const resolveFn of entry.resolvers) resolveFn({ action: 'cancel', cancelled: true });
    } else {
      const answerMap: Record<string, string> = {};
      for (const a of payload.answers) {
        const parts = [...a.selected, ...(a.custom?.trim() ? [a.custom.trim()] : [])];
        answerMap[a.id] = parts.join(', ');
      }
      const firstAnswer = Object.values(answerMap)[0] ?? '';
      const response = {
        action: 'submit',
        answers: payload.answers,
        content: {
          answer: firstAnswer,
          answers: answerMap,
        },
      };
      for (const resolveFn of entry.resolvers) resolveFn(response);
    }
    this.onChange();
    return true;
  }

  private dirtyTargetsFor(entry: PendingApprovalEntry, workspacePath: string): string[] {
    if (toolVariant(entry.toolName) !== 'edit') return [];
    const target = inputFilePath(entry.input);
    if (!target) return [];
    const abs = isAbsolute(target) ? target : resolve(workspacePath, target);
    return this.getDirtyFiles().includes(abs) ? [displayPath(abs, workspacePath)] : [];
  }

  private approvalView(entry: PendingApprovalEntry, workspacePath: string): PendingInteraction {
    const cmd = typeof entry.input.command === 'string' && entry.input.command.trim() ? entry.input.command.trim() : undefined;
    const file = inputFilePath(entry.input);
    const subject = cmd
      ? { subject: cmd, subjectKind: 'command' as const }
      : file
        ? { subject: displayPath(isAbsolute(file) ? file : resolve(workspacePath, file), workspacePath), subjectKind: 'file' as const }
        : undefined;
    return {
      kind: 'approval',
      id: entry.id,
      toolName: entry.toolName,
      reason: entry.reason,
      ...(subject ?? {}),
      previewable: false,
      dirtyFiles: this.dirtyTargetsFor(entry, workspacePath),
      allowAlways: t('acp.allowAlways'),
    };
  }
}

function parseQuestions(params: Record<string, unknown>): QuestionView[] {
  const toolName = typeof params.toolName === 'string' ? canonicalTool(params.toolName) : '';
  if (toolName === 'exit_plan_mode' || typeof params.plan === 'string') {
    const planText =
      typeof params.plan === 'string'
        ? params.plan
        : typeof (params.input as { plan?: unknown } | undefined)?.plan === 'string'
          ? (params.input as { plan: string }).plan
          : '';
    const approveLabel = t('plan.approved');
    const keepLabel = t('plan.keepPlanning');
    return [
      {
        id: 'plan',
        header: t('plan.label'),
        question: t('plan.untitled'),
        detail: planText,
        options: [{ label: approveLabel }, { label: keepLabel }],
        multiSelect: false,
        intent: { kind: 'plan-review', approve: approveLabel, keepPlanning: keepLabel },
      },
    ];
  }

  const rawInput = params.input && typeof params.input === 'object' ? (params.input as Record<string, unknown>) : params;
  const rawList = Array.isArray(params.questions)
    ? params.questions
    : Array.isArray(rawInput.questions)
      ? rawInput.questions
      : typeof params.question === 'string' || typeof params.prompt === 'string'
        ? [params]
        : [];

  return (rawList as Record<string, unknown>[]).flatMap((q, idx): QuestionView[] => {
    const question =
      typeof q?.question === 'string'
        ? q.question
        : typeof q?.prompt === 'string'
          ? q.prompt
          : typeof q?.title === 'string'
            ? q.title
            : '';
    if (!question.trim()) return [];
    const optionsRaw = Array.isArray(q.options) ? (q.options as Record<string, unknown>[]) : [];
    const options = optionsRaw.flatMap((opt) => {
      if (typeof opt === 'string') return [{ label: opt }];
      const label = typeof opt?.label === 'string' ? opt.label : typeof opt?.value === 'string' ? opt.value : '';
      if (!label) return [];
      return [{ label, ...(typeof opt?.description === 'string' ? { description: opt.description } : {}) }];
    });
    return [
      {
        id: typeof q.id === 'string' && q.id ? q.id : `q${idx + 1}`,
        ...(typeof q.header === 'string' && q.header ? { header: q.header } : {}),
        question,
        ...(typeof q.detail === 'string' && q.detail ? { detail: q.detail } : {}),
        options,
        multiSelect: q.multiSelect === true || q.multi_select === true,
      },
    ];
  });
}
