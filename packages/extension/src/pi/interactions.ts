/**
 * Pi Coding Agent（`pi --mode rpc`）Extension UI 子协议交互管理：
 * - `confirm`：投影为 `ApprovalCard`，应答 `{ confirmed: boolean }`；
 * - `select` / `input` / `editor`：投影为 `QuestionCard`，应答 `{ value: string }` 或 `{ cancelled: true }`。
 */
import type { PendingInteraction, QuestionView } from '@harness-deck/shared';
import { t } from '../i18n.ts';

export type QuestionAnswerPayload =
  | {
      readonly id: string;
      readonly answers: readonly { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }[];
    }
  | { readonly id: string; readonly cancelled: true };

interface PendingConfirmEntry {
  readonly kind: 'approval';
  readonly id: string;
  readonly sessionId: string;
  readonly title: string;
  readonly message: string;
  readonly resolve: (result: Record<string, unknown>) => void;
}

interface PendingDialogEntry {
  readonly kind: 'question';
  readonly id: string;
  readonly sessionId: string;
  readonly questions: readonly QuestionView[];
  readonly resolve: (result: Record<string, unknown>) => void;
}

type PendingEntry = PendingConfirmEntry | PendingDialogEntry;

export class PiInteractionManager {
  private readonly entries = new Map<string, PendingEntry>();
  private counter = 0;

  constructor(private readonly onChange: () => void) {}

  clear(sessionId?: string): void {
    for (const [id, entry] of this.entries) {
      if (sessionId !== undefined && entry.sessionId !== sessionId) continue;
      entry.resolve({ cancelled: true });
      this.entries.delete(id);
    }
  }

  sessionsWaiting(): Set<string> {
    return new Set([...this.entries.values()].map((e) => e.sessionId));
  }

  viewsFor(sessionId: string | undefined): PendingInteraction[] {
    if (!sessionId) return [];
    const result: PendingInteraction[] = [];
    for (const entry of this.entries.values()) {
      if (entry.sessionId !== sessionId) continue;
      if (entry.kind === 'approval') {
        result.push({
          kind: 'approval',
          id: entry.id,
          toolName: entry.title || 'Pi Extension',
          reason: entry.message,
          previewable: false,
          dirtyFiles: [],
        });
      } else {
        result.push({ kind: 'question', id: entry.id, questions: entry.questions });
      }
    }
    return result;
  }

  handleUiRequest(sessionId: string | undefined, request: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!sessionId) return Promise.resolve({ cancelled: true });
    const method = typeof request.method === 'string' ? request.method : '';
    const title = typeof request.title === 'string' ? request.title.trim() : '';

    if (method === 'confirm') {
      const message = typeof request.message === 'string' ? request.message.trim() : '';
      return new Promise((resolveConfirm) => {
        const id = `pi-confirm-${++this.counter}`;
        this.entries.set(id, {
          kind: 'approval',
          id,
          sessionId,
          title: title || 'Confirm',
          message,
          resolve: resolveConfirm,
        });
        this.onChange();
      });
    }

    if (method === 'select' || method === 'input' || method === 'editor') {
      const rawOptions = Array.isArray(request.options) ? request.options : [];
      const options = rawOptions.flatMap((o) =>
        typeof o === 'string' && o.trim() ? [{ label: o.trim() }] : [],
      );
      const detail =
        typeof request.prefill === 'string' && request.prefill.trim()
          ? request.prefill.trim()
          : typeof request.placeholder === 'string' && request.placeholder.trim()
            ? request.placeholder.trim()
            : undefined;
      const question: QuestionView = {
        id: 'q1',
        question: title || 'Input required',
        ...(detail ? { detail } : {}),
        options,
        multiSelect: false,
      };
      return new Promise((resolveQuestion) => {
        const id = `pi-q-${++this.counter}`;
        this.entries.set(id, {
          kind: 'question',
          id,
          sessionId,
          questions: [question],
          resolve: resolveQuestion,
        });
        this.onChange();
      });
    }

    return Promise.resolve({ cancelled: true });
  }

  respondApproval(
    id: string,
    decision: 'allow' | 'allowAlways' | 'reject',
  ): { readonly ok: boolean; readonly error?: string } {
    const entry = this.entries.get(id);
    if (!entry || entry.kind !== 'approval') return { ok: false, error: t('request.ended') };
    this.entries.delete(id);
    entry.resolve({ confirmed: decision !== 'reject' });
    this.onChange();
    return { ok: true };
  }

  answerQuestion(payload: QuestionAnswerPayload): boolean {
    const entry = this.entries.get(payload.id);
    if (!entry || entry.kind !== 'question') return false;
    this.entries.delete(payload.id);
    if ('cancelled' in payload) {
      entry.resolve({ cancelled: true });
    } else {
      const ans = payload.answers[0];
      const value = ans?.custom?.trim() || ans?.selected[0] || '';
      entry.resolve({ value });
    }
    this.onChange();
    return true;
  }
}
