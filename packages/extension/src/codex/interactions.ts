/**
 * Codex 反向交互请求管理：
 * - `item/commandExecution/requestApproval`：命令执行审批（支持一次允许、本次会话允许 / execpolicy 规则、拒绝）
 * - `item/fileChange/requestApproval`：文件修改审批（支持未保存脏文件拦截）
 * - `item/permissions/requestApproval`：额外沙箱/网络权限提升审批
 * - `item/tool/requestUserInput`：多选/单选/自由输入提问卡片
 * - 兼容旧版 `execCommandApproval` / `applyPatchApproval`
 * - 处理 `serverRequest/resolved` 通知，自动清理服务端已关闭的请求卡片
 */
import { isAbsolute, resolve } from 'node:path';
import type { PendingInteraction, QuestionView } from '@harness-deck/shared';
import { t } from '../i18n.ts';
import { displayPath } from '../vm/paths.ts';
import type { CodexRequestId } from './connection.ts';
import type { CodexToolState } from './projection.ts';

export type QuestionAnswerPayload =
  | { readonly id: string; readonly answers: readonly { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }[] }
  | { readonly id: string; readonly cancelled: true };

type ApprovalKind = 'command' | 'fileChange' | 'permissions' | 'legacyExec' | 'legacyPatch';

interface PendingApprovalEntry {
  readonly kind: 'approval';
  readonly approvalKind: ApprovalKind;
  readonly id: string;
  readonly serverRequestId: CodexRequestId;
  readonly threadId: string;
  readonly toolName: string;
  readonly reason: string;
  readonly subject?: string;
  readonly subjectKind?: 'command' | 'file';
  readonly filePaths: readonly string[];
  readonly proposedExecpolicyAmendment?: unknown;
  readonly requestedPermissions?: unknown;
  readonly resolve: (result: unknown) => void;
}

interface PendingQuestionEntry {
  readonly kind: 'question';
  readonly id: string;
  readonly serverRequestId: CodexRequestId;
  readonly threadId: string;
  readonly questions: readonly QuestionView[];
  readonly resolve: (result: unknown) => void;
}

type PendingEntry = PendingApprovalEntry | PendingQuestionEntry;

export class CodexInteractionManager {
  private readonly entries = new Map<string, PendingEntry>();
  private counter = 0;

  constructor(
    private readonly getWorkspacePath: () => string,
    private readonly getDirtyFiles: () => readonly string[],
    private readonly getKnownTool: (threadId: string, itemId: string) => CodexToolState | undefined,
    private readonly onChange: () => void,
  ) {}

  clear(threadId?: string): void {
    let changed = false;
    for (const [id, entry] of this.entries) {
      if (threadId !== undefined && entry.threadId !== threadId) continue;
      entry.resolve(cancelResponseFor(entry));
      this.entries.delete(id);
      changed = true;
    }
    if (changed) this.onChange();
  }

  resolveFromServer(requestId: CodexRequestId): void {
    let changed = false;
    for (const [id, entry] of this.entries) {
      if (String(entry.serverRequestId) === String(requestId)) {
        this.entries.delete(id);
        changed = true;
      }
    }
    if (changed) this.onChange();
  }

  sessionsWaiting(): Set<string> {
    return new Set([...this.entries.values()].map((e) => e.threadId));
  }

  viewsFor(threadId: string | undefined): PendingInteraction[] {
    if (!threadId) return [];
    const workspacePath = this.getWorkspacePath();
    const result: PendingInteraction[] = [];
    for (const entry of this.entries.values()) {
      if (entry.threadId !== threadId) continue;
      if (entry.kind === 'approval') {
        result.push({
          kind: 'approval',
          id: entry.id,
          toolName: entry.toolName,
          reason: entry.reason,
          ...(entry.subject && entry.subjectKind
            ? { subject: entry.subject, subjectKind: entry.subjectKind }
            : {}),
          previewable: false,
          dirtyFiles: this.dirtyTargetsFor(entry, workspacePath),
          allowAlways: t('acp.allowAlways'),
        });
      } else {
        result.push({ kind: 'question', id: entry.id, questions: entry.questions });
      }
    }
    return result;
  }

  requestCommandApproval(
    rawParams: unknown,
    requestId: CodexRequestId,
    fallbackThreadId: string | undefined,
  ): Promise<unknown> {
    const params = asObj(rawParams);
    const threadId = str(params.threadId) || fallbackThreadId || '';
    if (!threadId) return Promise.resolve({ decision: 'decline' });
    const itemId = str(params.itemId);
    const known = itemId ? this.getKnownTool(threadId, itemId) : undefined;
    const command = str(params.command) || known?.command || '';
    const reason = str(params.reason) || '';
    return new Promise((resolveFn) => {
      const id = `cx-cmd-${++this.counter}`;
      this.entries.set(id, {
        kind: 'approval',
        approvalKind: 'command',
        id,
        serverRequestId: requestId,
        threadId,
        toolName: 'Shell',
        reason,
        ...(command ? { subject: command, subjectKind: 'command' as const } : {}),
        filePaths: [],
        ...(params.proposedExecpolicyAmendment !== undefined
          ? { proposedExecpolicyAmendment: params.proposedExecpolicyAmendment }
          : {}),
        resolve: resolveFn,
      });
      this.onChange();
    });
  }

  requestFileChangeApproval(
    rawParams: unknown,
    requestId: CodexRequestId,
    fallbackThreadId: string | undefined,
  ): Promise<unknown> {
    const params = asObj(rawParams);
    const threadId = str(params.threadId) || fallbackThreadId || '';
    if (!threadId) return Promise.resolve({ decision: 'decline' });
    const itemId = str(params.itemId);
    const known = itemId ? this.getKnownTool(threadId, itemId) : undefined;
    const filePaths = known?.changes.map((c) => c.path) ?? [];
    const workspacePath = this.getWorkspacePath();
    const subject =
      filePaths.length > 0
        ? filePaths.map((p) => displayPath(p, workspacePath)).join(', ')
        : str(params.grantRoot)
          ? displayPath(str(params.grantRoot), workspacePath)
          : undefined;
    const reason = str(params.reason) || '';
    return new Promise((resolveFn) => {
      const id = `cx-file-${++this.counter}`;
      this.entries.set(id, {
        kind: 'approval',
        approvalKind: 'fileChange',
        id,
        serverRequestId: requestId,
        threadId,
        toolName: 'Edit',
        reason,
        ...(subject ? { subject, subjectKind: 'file' as const } : {}),
        filePaths,
        resolve: resolveFn,
      });
      this.onChange();
    });
  }

  requestPermissionsApproval(
    rawParams: unknown,
    requestId: CodexRequestId,
    fallbackThreadId: string | undefined,
  ): Promise<unknown> {
    const params = asObj(rawParams);
    const threadId = str(params.threadId) || fallbackThreadId || '';
    if (!threadId) return Promise.resolve({ permissions: {}, scope: 'turn' });
    const reason = str(params.reason) || '';
    const cwd = str(params.cwd);
    const workspacePath = this.getWorkspacePath();
    return new Promise((resolveFn) => {
      const id = `cx-perm-${++this.counter}`;
      this.entries.set(id, {
        kind: 'approval',
        approvalKind: 'permissions',
        id,
        serverRequestId: requestId,
        threadId,
        toolName: 'Permissions',
        reason,
        ...(cwd ? { subject: displayPath(cwd, workspacePath), subjectKind: 'file' as const } : {}),
        filePaths: [],
        requestedPermissions: params.permissions ?? {},
        resolve: resolveFn,
      });
      this.onChange();
    });
  }

  requestLegacyApproval(
    method: 'execCommandApproval' | 'applyPatchApproval',
    rawParams: unknown,
    requestId: CodexRequestId,
    fallbackThreadId: string | undefined,
  ): Promise<unknown> {
    const params = asObj(rawParams);
    const threadId = str(params.conversationId) || str(params.threadId) || fallbackThreadId || '';
    if (!threadId) return Promise.resolve({ decision: 'denied' });
    const isPatch = method === 'applyPatchApproval';
    const commandList = Array.isArray(params.command) ? (params.command as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    const command = commandList.join(' ');
    const fileMap = params.fileChanges && typeof params.fileChanges === 'object' ? Object.keys(params.fileChanges as Record<string, unknown>) : [];
    const workspacePath = this.getWorkspacePath();
    const subject = isPatch
      ? fileMap.map((p) => displayPath(p, workspacePath)).join(', ') || undefined
      : command || undefined;
    return new Promise((resolveFn) => {
      const id = `cx-leg-${++this.counter}`;
      this.entries.set(id, {
        kind: 'approval',
        approvalKind: isPatch ? 'legacyPatch' : 'legacyExec',
        id,
        serverRequestId: requestId,
        threadId,
        toolName: isPatch ? 'Edit' : 'Shell',
        reason: str(params.reason),
        ...(subject ? { subject, subjectKind: isPatch ? ('file' as const) : ('command' as const) } : {}),
        filePaths: fileMap,
        resolve: resolveFn,
      });
      this.onChange();
    });
  }

  requestUserInput(
    rawParams: unknown,
    requestId: CodexRequestId,
    fallbackThreadId: string | undefined,
  ): Promise<unknown> {
    const params = asObj(rawParams);
    const threadId = str(params.threadId) || fallbackThreadId || '';
    if (!threadId) return Promise.resolve({ answers: {} });
    const rawQuestions = Array.isArray(params.questions) ? (params.questions as Record<string, unknown>[]) : [];
    const questions: QuestionView[] = rawQuestions.flatMap((q, idx): QuestionView[] => {
      const question = str(q.question);
      if (!question) return [];
      const rawOpts = Array.isArray(q.options) ? (q.options as Record<string, unknown>[]) : [];
      const options = rawOpts.flatMap((opt) => {
        const label = str(opt?.label);
        if (!label) return [];
        const desc = str(opt?.description);
        return [{ label, ...(desc ? { description: desc } : {}) }];
      });
      const header = str(q.header);
      return [
        {
          id: str(q.id) || `q${idx + 1}`,
          ...(header ? { header } : {}),
          question,
          options,
          multiSelect: false,
        },
      ];
    });

    if (questions.length === 0) return Promise.resolve({ answers: {} });

    return new Promise((resolveFn) => {
      const id = `cx-q-${++this.counter}`;
      this.entries.set(id, {
        kind: 'question',
        id,
        serverRequestId: requestId,
        threadId,
        questions,
        resolve: resolveFn,
      });
      this.onChange();
    });
  }

  respondApproval(
    id: string,
    decision: 'allow' | 'allowAlways' | 'reject',
  ): { readonly ok: boolean; readonly error?: string } {
    const entry = this.entries.get(id);
    if (!entry || entry.kind !== 'approval') return { ok: false, error: t('request.ended') };
    if (decision !== 'reject') {
      const dirty = this.dirtyTargetsFor(entry, this.getWorkspacePath());
      if (dirty.length > 0) return { ok: false, error: t('approval.dirty') };
    }
    this.entries.delete(id);
    entry.resolve(approvalResponseFor(entry, decision));
    this.onChange();
    return { ok: true };
  }

  answerQuestion(payload: QuestionAnswerPayload): boolean {
    const entry = this.entries.get(payload.id);
    if (!entry || entry.kind !== 'question') return false;
    this.entries.delete(payload.id);
    if ('cancelled' in payload) {
      entry.resolve({ answers: {} });
    } else {
      const answers: Record<string, { answers: string[] }> = {};
      for (const a of payload.answers) {
        const values = [...a.selected, ...(a.custom?.trim() ? [a.custom.trim()] : [])];
        answers[a.id] = { answers: values };
      }
      entry.resolve({ answers });
    }
    this.onChange();
    return true;
  }

  private dirtyTargetsFor(entry: PendingApprovalEntry, workspacePath: string): string[] {
    if (entry.filePaths.length === 0) return [];
    const dirtySet = new Set(this.getDirtyFiles());
    const hits: string[] = [];
    for (const file of entry.filePaths) {
      const abs = isAbsolute(file) ? file : resolve(workspacePath, file);
      if (dirtySet.has(abs)) hits.push(displayPath(abs, workspacePath));
    }
    return hits;
  }
}

function approvalResponseFor(entry: PendingApprovalEntry, decision: 'allow' | 'allowAlways' | 'reject'): unknown {
  switch (entry.approvalKind) {
    case 'command':
      if (decision === 'reject') return { decision: 'decline' };
      if (decision === 'allowAlways') {
        if (entry.proposedExecpolicyAmendment) {
          return {
            decision: {
              acceptWithExecpolicyAmendment: { execpolicy_amendment: entry.proposedExecpolicyAmendment },
            },
          };
        }
        return { decision: 'acceptForSession' };
      }
      return { decision: 'accept' };
    case 'fileChange':
      if (decision === 'reject') return { decision: 'decline' };
      return { decision: decision === 'allowAlways' ? 'acceptForSession' : 'accept' };
    case 'permissions':
      if (decision === 'reject') return { permissions: {}, scope: 'turn' };
      return {
        permissions: entry.requestedPermissions ?? {},
        scope: decision === 'allowAlways' ? 'session' : 'turn',
      };
    case 'legacyExec':
    case 'legacyPatch':
      if (decision === 'reject') return { decision: 'denied' };
      return { decision: decision === 'allowAlways' ? 'approved_for_session' : 'approved' };
  }
}

function cancelResponseFor(entry: PendingEntry): unknown {
  if (entry.kind === 'question') return { answers: {} };
  switch (entry.approvalKind) {
    case 'command':
    case 'fileChange':
      return { decision: 'cancel' };
    case 'permissions':
      return { permissions: {}, scope: 'turn' };
    case 'legacyExec':
    case 'legacyPatch':
      return { decision: 'abort' };
  }
}

function asObj(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
