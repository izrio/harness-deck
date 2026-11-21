/**
 * CodeBuddy 原生 `stream-json` 反向交互管理：
 * - `can_use_tool`（普通工具）：投影为 `ApprovalCard`（未保存文件拦截、Diff 预览、「允许本次」/「始终允许」/「拒绝」），
 *   按 CodeBuddy 实测协议以 `{ allowed: true, updatedInput }` / `{ allowed: false, message }` 应答；
 * - `can_use_tool`（`AskUserQuestion` / `ExitPlanMode`）：投影为 `QuestionCard` / 计划审阅卡片，答案经 `updatedInput` 回传。
 */
import { isAbsolute, resolve } from 'node:path';
import type { PendingInteraction, QuestionView } from '@harness-deck/shared';
import { inputFilePath } from '../acp/projection.ts';
import { t } from '../i18n.ts';
import { displayPath } from '../vm/paths.ts';
import { canonicalTool } from '../vm/toolNames.ts';
import { parseArguments, toolVariant } from '../vm/toolRows.ts';
import { extractCodebuddyDiffs, type CodebuddyDiff } from './projection.ts';

export type QuestionAnswerPayload =
  | {
      readonly id: string;
      readonly answers: readonly { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }[];
    }
  | { readonly id: string; readonly cancelled: true };

interface PendingApprovalEntry {
  readonly kind: 'approval';
  readonly id: string;
  readonly sessionKey: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly reason: string;
  readonly diffs: readonly CodebuddyDiff[];
  readonly resolve: (result: Record<string, unknown>) => void;
}

interface PendingQuestionEntry {
  readonly kind: 'question';
  readonly id: string;
  readonly sessionKey: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly questions: readonly QuestionView[];
  readonly resolve: (result: Record<string, unknown>) => void;
}

type PendingEntry = PendingApprovalEntry | PendingQuestionEntry;

export class CodebuddyInteractionManager {
  private readonly entries = new Map<string, PendingEntry>();
  private readonly alwaysAllowedTools = new Map<string, Set<string>>();
  private counter = 0;

  constructor(
    private readonly getWorkspacePath: () => string,
    private readonly getDirtyFiles: () => readonly string[],
    private readonly onChange: () => void,
  ) {}

  clear(sessionKey?: string): void {
    for (const [id, entry] of this.entries) {
      if (sessionKey !== undefined && entry.sessionKey !== sessionKey) continue;
      entry.resolve({ allowed: false, message: 'Session closed or interrupted' });
      this.entries.delete(id);
    }
    if (sessionKey === undefined) {
      this.alwaysAllowedTools.clear();
    } else {
      this.alwaysAllowedTools.delete(sessionKey);
    }
  }

  rekeySession(oldKey: string, newKey: string): void {
    if (oldKey === newKey) return;
    const allowed = this.alwaysAllowedTools.get(oldKey);
    if (allowed) {
      this.alwaysAllowedTools.delete(oldKey);
      this.alwaysAllowedTools.set(newKey, allowed);
    }
    for (const [id, entry] of this.entries) {
      if (entry.sessionKey === oldKey) {
        this.entries.set(id, { ...entry, sessionKey: newKey });
      }
    }
  }

  sessionsWaiting(): Set<string> {
    return new Set([...this.entries.values()].map((e) => e.sessionKey));
  }

  viewsFor(sessionKey: string | undefined): PendingInteraction[] {
    if (!sessionKey) return [];
    const workspacePath = this.getWorkspacePath();
    const result: PendingInteraction[] = [];
    for (const entry of this.entries.values()) {
      if (entry.sessionKey !== sessionKey) continue;
      if (entry.kind === 'approval') {
        result.push(this.approvalView(entry, workspacePath));
      } else {
        result.push({ kind: 'question', id: entry.id, questions: entry.questions });
      }
    }
    return result;
  }

  approvalDiffs(id: string): readonly CodebuddyDiff[] {
    const entry = this.entries.get(id);
    return entry?.kind === 'approval' ? entry.diffs : [];
  }

  handleControlRequest(
    sessionKey: string,
    request: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const subtype = typeof request.subtype === 'string' ? request.subtype : '';
    if (subtype !== 'can_use_tool') {
      return Promise.resolve({});
    }

    const toolName =
      typeof request.tool_name === 'string'
        ? request.tool_name
        : typeof request.toolName === 'string'
          ? request.toolName
          : typeof request.tool === 'string'
            ? request.tool
            : 'tool';
    const input = parseArguments(request.input);
    const canon = canonicalTool(toolName);

    if (canon === 'ask_user_question' || canon === 'exit_plan_mode') {
      const questions = parseCodebuddyQuestions(canon, input);
      if (questions.length > 0) {
        return new Promise((resolveQuestion) => {
          const id = `cb-q-${++this.counter}`;
          this.entries.set(id, {
            kind: 'question',
            id,
            sessionKey,
            toolName,
            input,
            questions,
            resolve: resolveQuestion,
          });
          this.onChange();
        });
      }
    }

    // 若用户已对当前会话该工具点过「始终允许」，且无未保存文件冲突，直接放行
    if (this.alwaysAllowedTools.get(sessionKey)?.has(toolName)) {
      const dirty = this.dirtyTargetsFor(toolName, input, this.getWorkspacePath());
      if (dirty.length === 0) {
        return Promise.resolve({ allowed: true, updatedInput: input });
      }
    }

    const reason =
      typeof request.decision_reason === 'string'
        ? request.decision_reason
        : typeof request.description === 'string'
          ? request.description
          : '';
    const diffs = extractCodebuddyDiffs(toolName, input);

    return new Promise((resolveApproval) => {
      const id = `cb-perm-${++this.counter}`;
      this.entries.set(id, {
        kind: 'approval',
        id,
        sessionKey,
        toolName,
        input,
        reason,
        diffs,
        resolve: resolveApproval,
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
      const dirty = this.dirtyTargetsFor(entry.toolName, entry.input, this.getWorkspacePath());
      if (dirty.length > 0) return { ok: false, error: t('approval.dirty') };
    }
    this.entries.delete(id);

    if (decision === 'reject') {
      entry.resolve({ allowed: false, message: 'Rejected by user' });
    } else if (decision === 'allowAlways') {
      let set = this.alwaysAllowedTools.get(entry.sessionKey);
      if (!set) {
        set = new Set<string>();
        this.alwaysAllowedTools.set(entry.sessionKey, set);
      }
      set.add(entry.toolName);
      entry.resolve({ allowed: true, updatedInput: entry.input });
    } else {
      entry.resolve({ allowed: true, updatedInput: entry.input });
    }
    this.onChange();
    return { ok: true };
  }

  answerQuestion(payload: QuestionAnswerPayload): boolean {
    const entry = this.entries.get(payload.id);
    if (!entry || entry.kind !== 'question') return false;
    this.entries.delete(payload.id);

    if ('cancelled' in payload) {
      entry.resolve({ allowed: false, message: 'Cancelled by user' });
      this.onChange();
      return true;
    }

    const canon = canonicalTool(entry.toolName);
    if (canon === 'exit_plan_mode') {
      const first = payload.answers[0];
      const approveLabel = t('plan.approved');
      const customNote = first?.custom?.trim();
      const approved = Boolean(first?.selected.includes(approveLabel)) && !customNote;
      if (approved) {
        entry.resolve({ allowed: true, updatedInput: entry.input });
      } else {
        entry.resolve({
          allowed: false,
          message: customNote || 'Please keep planning and refine the plan.',
        });
      }
      this.onChange();
      return true;
    }

    const answersByQuestion: Record<string, string> = {};
    for (const q of entry.questions) {
      const matched = payload.answers.find((a) => a.id === q.id);
      if (!matched) continue;
      const parts = [...matched.selected, ...(matched.custom?.trim() ? [matched.custom.trim()] : [])];
      answersByQuestion[q.question] = parts.join(', ');
    }
    entry.resolve({
      allowed: true,
      updatedInput: {
        ...entry.input,
        answers: answersByQuestion,
      },
    });
    this.onChange();
    return true;
  }

  private dirtyTargetsFor(toolName: string, input: Record<string, unknown>, workspacePath: string): string[] {
    if (toolVariant(toolName) !== 'edit') return [];
    const target = inputFilePath(input);
    if (!target) return [];
    const abs = isAbsolute(target) ? target : resolve(workspacePath, target);
    return this.getDirtyFiles().includes(abs) ? [displayPath(abs, workspacePath)] : [];
  }

  private approvalView(entry: PendingApprovalEntry, workspacePath: string): PendingInteraction {
    const cmd =
      typeof entry.input.command === 'string' && entry.input.command.trim() ? entry.input.command.trim() : undefined;
    const file = inputFilePath(entry.input);
    const subject = cmd
      ? { subject: cmd, subjectKind: 'command' as const }
      : file
        ? {
            subject: displayPath(isAbsolute(file) ? file : resolve(workspacePath, file), workspacePath),
            subjectKind: 'file' as const,
          }
        : undefined;
    return {
      kind: 'approval',
      id: entry.id,
      toolName: entry.toolName,
      reason: entry.reason,
      ...(subject ?? {}),
      previewable: entry.diffs.length > 0,
      dirtyFiles: this.dirtyTargetsFor(entry.toolName, entry.input, workspacePath),
      allowAlways: t('acp.allowAlways'),
    };
  }
}

function parseCodebuddyQuestions(canon: string, input: Record<string, unknown>): QuestionView[] {
  if (canon === 'exit_plan_mode') {
    const planText = typeof input.plan === 'string' ? input.plan : '';
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

  const rawQuestions = Array.isArray(input.questions) ? (input.questions as Record<string, unknown>[]) : [];
  return rawQuestions.flatMap((q, idx): QuestionView[] => {
    const question = typeof q?.question === 'string' ? q.question : '';
    if (!question.trim()) return [];
    const optionsRaw = Array.isArray(q.options) ? (q.options as Record<string, unknown>[]) : [];
    const options = optionsRaw.flatMap((opt) => {
      if (typeof opt === 'string') return [{ label: opt }];
      const label = typeof opt?.label === 'string' ? opt.label : '';
      if (!label) return [];
      return [{ label, ...(typeof opt?.description === 'string' ? { description: opt.description } : {}) }];
    });
    return [
      {
        id: typeof q.id === 'string' && q.id ? q.id : `q${idx + 1}`,
        ...(typeof q.header === 'string' && q.header ? { header: q.header } : {}),
        question,
        options,
        multiSelect: q.multiSelect === true,
      },
    ];
  });
}
