/**
 * 交互卡片（严格对齐 Beautiful UI ApprovalCard：`primitive-card-pad` / `primitive-card-footer` / `GlideMenu` / `RollingDigits` / `Button`）。
 */
import { useEffect, useRef, useState } from 'react';
import { backendCapabilities, type PendingInteraction, type QuestionView } from '@harness-deck/shared';
import { useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { cn } from '../lib/utils.ts';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { GlideMenu, ValuePill } from './beautifului/index.ts';
import { Markdown } from './Markdown.tsx';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChatIcon,
  CheckIcon,
  CloseIcon,
  EyeIcon,
  FastForwardIcon,
  PencilIcon,
  PlanIcon,
  QuestionIcon,
  ReplyIcon,
  SaveIcon,
  SendIcon,
  ShieldIcon,
  SpinnerIcon,
} from './icons.tsx';
import { useT } from '../i18n.ts';

type Of<K extends PendingInteraction['kind']> = Extract<PendingInteraction, { kind: K }>;

export function InteractionCard({ interaction }: { interaction: PendingInteraction }) {
  if (interaction.kind === 'approval') return <ApprovalCard item={interaction} />;
  const review = interaction.questions.length === 1 ? interaction.questions[0] : undefined;
  if (review?.intent?.kind === 'plan-review') return <PlanReviewCard id={interaction.id} question={review} />;
  return <QuestionCard item={interaction} />;
}

/** Beautiful UI odometer digits */
function RollingDigits({ value }: { value: string }) {
  const prevRef = useRef(value);
  const [oldVal, setOldVal] = useState(value);
  const [newVal, setNewVal] = useState(value);
  const [rolling, setRolling] = useState(false);
  const [shifted, setShifted] = useState(false);
  const [dir, setDir] = useState<'up' | 'down'>('up');

  useEffect(() => {
    if (prevRef.current === value) return;
    const from = prevRef.current;
    prevRef.current = value;
    const fromN = Number.parseInt(/\d+/u.exec(from)?.[0] ?? '', 10);
    const toN = Number.parseInt(/\d+/u.exec(value)?.[0] ?? '', 10);
    setDir(Number.isFinite(fromN) && Number.isFinite(toN) && toN < fromN ? 'down' : 'up');
    setOldVal(from);
    setNewVal(value);
    setRolling(true);
    setShifted(false);

    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setShifted(true));
    });
    const done = setTimeout(() => {
      setRolling(false);
      setOldVal(value);
      setShifted(false);
    }, 260);

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(done);
    };
  }, [value]);

  const chars = rolling ? newVal : oldVal;
  return (
    <>
      {Array.from({ length: chars.length }, (_, i) => {
        const o = oldVal[i] ?? '';
        const n = chars[i] ?? '';
        if (!rolling || o === n) return <span key={`${i}-${n}`}>{n}</span>;
        const top = dir === 'down' ? n : o;
        const bottom = dir === 'down' ? o : n;
        const restY = dir === 'down' ? '0' : '-1em';
        const startY = dir === 'down' ? '-1em' : '0';
        return (
          <span key={`${i}-${o}-${n}-${dir}`} className="relative inline-block h-[1em] overflow-hidden align-[-0.05em] leading-[1em]">
            <span
              className="flex flex-col transition-transform duration-250"
              style={{ transform: `translateY(${shifted ? restY : startY})` }}
            >
              <span className="h-[1em] leading-[1em]">{top}</span>
              <span className="h-[1em] leading-[1em]">{bottom}</span>
            </span>
          </span>
        );
      })}
    </>
  );
}

const REPLY_RECOVERY_MS = 4_000;

/** Track a pending reply and auto-recover if Host leaves the interaction mounted. */
function usePendingReply<T extends string>(resetKey?: string) {
  const [sent, setSent] = useState<T | undefined>();
  useEffect(() => {
    setSent(undefined);
  }, [resetKey]);
  useEffect(() => {
    if (sent === undefined) return;
    const timer = setTimeout(() => setSent(undefined), REPLY_RECOVERY_MS);
    return () => clearTimeout(timer);
  }, [sent]);
  return [sent, setSent] as const;
}

function ApprovalCard({ item }: { item: Of<'approval'> }) {
  const dirtyKey = item.dirtyFiles.join('\0');
  const [sent, setSent] = usePendingReply<'allow' | 'allowAlways' | 'reject'>(`${item.id}\0${dirtyKey}`);
  const t = useT();
  const blocked = item.dirtyFiles.length > 0;
  const showApprovalHint = useView((s) => {
    const backend = s.backends.items.find((b) => b.id === s.backends.active);
    return backend ? (backend.capabilities ?? backendCapabilities(backend)).approvalHint : false;
  });
  const respond = (decision: 'allow' | 'allowAlways' | 'reject') => {
    setSent(decision);
    postToHost({ type: 'respondApproval', commandId: `approval:${item.id}:${decision}`, payload: { id: item.id, decision } });
  };
  const title = item.subjectKind === 'command' ? t('approval.command') : item.subjectKind === 'file' ? t('approval.file') : t('approval.tool', item.toolName);
  return (
    <section
      className="interaction interaction--approval overflow-hidden rounded-card bg-surface shadow-card"
      aria-label={t('approval.label')}
      data-testid="approval-card"
      style={{ animation: 'fade-up 340ms cubic-bezier(0.23,1,0.32,1) both' }}
    >
      <div className="primitive-card-pad flex flex-col gap-2.5">
        <header className="interaction__header flex items-center gap-2 text-[14px] font-medium text-ink">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-orange-tint text-orange">
            <ShieldIcon className="size-3.5" />
          </span>
          <span>{title}</span>
        </header>
        {item.subjectKind === 'command' && item.subject ? (
          <pre className="interaction__command terminal-surface m-0 max-h-40 overflow-auto rounded-control bg-field px-3 py-2 whitespace-pre-wrap text-ink shadow-hairline [overflow-wrap:anywhere]">
            {item.subject}
          </pre>
        ) : null}
        {item.subjectKind === 'file' && item.subject ? (
          <button
            type="button"
            className="self-start rounded-chip bg-field px-2 py-1 font-mono text-[12px] text-accent-ink shadow-hairline hover:underline [overflow-wrap:anywhere]"
            onClick={() => postToHost({ type: 'openFile', payload: { path: item.subject ?? '' } })}
          >
            {item.subject}
          </button>
        ) : null}
        {item.reason && item.reason !== item.subject ? <p className="interaction__reason m-0 text-[13px] text-ink">{item.reason}</p> : null}
        {showApprovalHint ? <p className="m-0 text-[12px] text-ink-2">{t('approval.hint')}</p> : null}
        {blocked ? (
          <div className="flex flex-wrap items-center gap-2 rounded-control bg-orange-tint px-2.5 py-2 text-[12px] text-orange shadow-[0_0_0_1px_color-mix(in_srgb,var(--orange)_28%,transparent)]" role="alert">
            <span>{t('approval.dirty', item.dirtyFiles.join(', '))}</span>
            <button type="button" className="inline-flex items-center gap-1 font-medium text-accent-ink hover:underline" onClick={() => postToHost({ type: 'saveAll', payload: {} })}>
              <SaveIcon className="size-3.5" />
              {t('dirty.saveAll')}
            </button>
          </div>
        ) : null}
      </div>
      <div className="interaction__actions primitive-card-footer flex flex-wrap items-center gap-1.5 border-t border-line">
        {item.previewable ? (
          <Button type="button" variant="ghost" size="sm" className="interaction__preview mr-auto text-ink-2" onClick={() => postToHost({ type: 'previewApproval', payload: { id: item.id } })}>
            <EyeIcon className="size-3.5" />
            <span>{t('approval.preview')}</span>
          </Button>
        ) : (
          <span className="mr-auto" />
        )}
        <Button type="button" variant="ghost" size="sm" disabled={sent !== undefined} onClick={() => respond('reject')}>
          {sent === 'reject' ? <SpinnerIcon className="size-3.5" /> : <CloseIcon className="size-3.5" />}
          {t('approval.reject')}
        </Button>
        {item.allowAlways ? (
          <Button type="button" variant="outline" size="sm" disabled={sent !== undefined || blocked} title={t('approval.allowAlwaysTitle')} onClick={() => respond('allowAlways')}>
            {sent === 'allowAlways' ? <SpinnerIcon className="size-3.5" /> : null}
            {item.allowAlways}
          </Button>
        ) : null}
        <Button type="button" size="sm" className="bg-brand text-brand-foreground hover:opacity-90" disabled={sent !== undefined || blocked} onClick={() => respond('allow')}>
          {sent === 'allow' ? <SpinnerIcon className="size-3.5" /> : <CheckIcon className="size-3.5" />}
          {t('approval.allow')}
        </Button>
      </div>
    </section>
  );
}

function PlanReviewCard({ id, question }: { id: string; question: QuestionView }) {
  const t = useT();
  const [feedback, setFeedback] = useState<string | undefined>();
  const [sent, setSent] = usePendingReply<'approve' | 'keep' | 'reply'>(id);
  const intent = question.intent!;
  const answer = (selected: string, custom?: string) => {
    setSent(selected === intent.approve ? 'approve' : 'keep');
    postToHost({ type: 'answerQuestion', payload: { id, answers: [{ id: question.id, selected: [selected], ...(custom ? { custom } : {}) }] } });
  };
  const keep = intent.keepPlanning ?? question.options.find((o) => o.label !== intent.approve)?.label ?? t('plan.keep');
  return (
    <section
      className="interaction overflow-hidden rounded-card bg-surface shadow-card"
      aria-label={t('plan.label')}
      data-testid="plan-review-card"
      style={{ animation: 'fade-up 340ms var(--ease-out-strong) both' }}
    >
      <div className="primitive-card-pad flex flex-col gap-2.5">
        <header className="flex items-center gap-2 text-[14px] font-medium text-ink">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-tint text-accent-ink">
            <PlanIcon className="size-3.5" />
          </span>
          <span>{t('plan.title')}</span>
        </header>
        {question.detail ? (
          <div className="max-h-80 overflow-auto rounded-control bg-inset/60 p-3 shadow-hairline">
            <Markdown text={question.detail} />
          </div>
        ) : null}
        {feedback !== undefined ? (
          <Textarea
            className="resize-y text-[13px]"
            rows={3}
            autoFocus
            value={feedback}
            placeholder={t('plan.feedbackPlaceholder')}
            aria-label={t('plan.feedbackLabel')}
            disabled={sent !== undefined}
            onChange={(event) => setFeedback(event.target.value)}
          />
        ) : null}
      </div>
      <div className="interaction__actions primitive-card-footer flex flex-wrap items-center gap-1.5 border-t border-line">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="interaction__skip mr-auto text-ink-2"
          disabled={sent !== undefined}
          title={t('plan.replyTitle')}
          onClick={() => {
            setSent('reply');
            postToHost({ type: 'answerQuestion', commandId: `question:${id}:cancel`, payload: { id, cancelled: true } });
          }}
        >
          {sent === 'reply' ? <SpinnerIcon className="size-3.5" /> : <ChatIcon className="size-3.5" />}
          {t('plan.reply')}
        </Button>
        {feedback === undefined ? (
          <>
            <Button type="button" variant="ghost" size="sm" disabled={sent !== undefined} onClick={() => setFeedback('')}>
              <PencilIcon className="size-3.5" />
              {t('plan.keep')}
            </Button>
            <Button type="button" size="sm" className="bg-brand text-brand-foreground hover:opacity-90" disabled={sent !== undefined} onClick={() => answer(intent.approve)}>
              {sent === 'approve' ? <SpinnerIcon className="size-3.5" /> : <CheckIcon className="size-3.5" />}
              {t('plan.approve')}
            </Button>
          </>
        ) : (
          <>
            <Button type="button" variant="ghost" size="sm" disabled={sent !== undefined} onClick={() => setFeedback(undefined)}>
              <ReplyIcon className="size-3.5" />
              {t('plan.back')}
            </Button>
            <Button type="button" size="sm" className="bg-brand text-brand-foreground hover:opacity-90" disabled={sent !== undefined} onClick={() => answer(keep, feedback.trim() || undefined)}>
              {sent === 'keep' ? <SpinnerIcon className="size-3.5" /> : <SendIcon className="size-3.5" />}
              {t('plan.sendFeedback')}
            </Button>
          </>
        )}
      </div>
    </section>
  );
}

interface Draft {
  readonly selected: readonly string[];
  readonly custom: string;
}

const ADVANCE_DELAY_MS = 220;

/** 对齐 Beautiful UI ApprovalCard 提问流。 */
function QuestionCard({ item }: { item: Of<'question'> }) {
  const t = useT();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [step, setStep] = useState(0);
  const [sent, setSent] = usePendingReply<'submit' | 'skip'>(item.id);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(advanceTimer.current), []);

  const questions = item.questions;
  const total = questions.length;
  if (total === 0) return null;
  const index = Math.min(step, total - 1);
  const q = questions[index]!;
  const last = index === total - 1;
  const draftOf = (question: QuestionView): Draft => drafts[question.id] ?? { selected: [], custom: '' };
  const answered = (question: QuestionView) => draftOf(question).selected.length > 0 || draftOf(question).custom.trim().length > 0;
  const complete = questions.every(answered);
  const draft = draftOf(q);

  const goTo = (next: number) => {
    clearTimeout(advanceTimer.current);
    setStep(Math.max(0, Math.min(total - 1, next)));
  };

  const submit = () => {
    if (!complete || sent) {
      const missing = questions.findIndex((question) => !answered(question));
      if (missing >= 0) goTo(missing);
      return;
    }
    setSent('submit');
    postToHost({
      type: 'answerQuestion',
      commandId: `question:${item.id}:submit`,
      payload: {
        id: item.id,
        answers: questions.map((question) => {
          const d = draftOf(question);
          const custom = d.custom.trim();
          return { id: question.id, selected: [...d.selected], ...(custom ? { custom } : {}) };
        }),
      },
    });
  };
  const skip = () => {
    setSent('skip');
    postToHost({ type: 'answerQuestion', commandId: `question:${item.id}:cancel`, payload: { id: item.id, cancelled: true } });
  };
  const next = () => (last ? submit() : answered(q) ? goTo(index + 1) : undefined);

  const toggle = (label: string) => {
    const has = draft.selected.includes(label);
    const selected = q.multiSelect ? (has ? draft.selected.filter((l) => l !== label) : [...draft.selected, label]) : has ? [] : [label];
    setDrafts({ ...drafts, [q.id]: { ...draft, selected } });
    if (!q.multiSelect && !has && !last) {
      clearTimeout(advanceTimer.current);
      advanceTimer.current = setTimeout(() => setStep(index + 1), ADVANCE_DELAY_MS);
    }
  };

  const summary = (question: QuestionView) => {
    const d = draftOf(question);
    const answer = [...d.selected, d.custom.trim()].filter(Boolean).join(t('question.separator'));
    return answer ? `${question.header ?? question.question}${t('question.summaryColon')}${answer}` : (question.header ?? question.question);
  };

  return (
    <section
      className="interaction interaction--question overflow-hidden rounded-card bg-surface shadow-card"
      aria-label={t('question.label')}
      data-testid="question-card"
      style={{ animation: 'fade-up 340ms cubic-bezier(0.23,1,0.32,1) both' }}
    >
      <div className="primitive-card-pad">
        <header className="interaction__header question-card__header mb-2 flex items-center gap-2 text-[12.5px] font-medium text-ink-2">
          <QuestionIcon className="size-3.5 shrink-0 text-accent-ink" />
          <span className="question-card__title min-w-0 flex-1">{t('question.title')}</span>
          {total > 1 ? (
            <span className="question-card__count inline-flex items-center text-[12px] font-medium text-ink-3 tabular-nums" data-testid="question-step">
              <RollingDigits value={t('question.step', index + 1, total)} />
            </span>
          ) : null}
        </header>
        {total > 1 ? (
          <div className="question-steps mb-2.5 flex gap-1" role="tablist" aria-label={t('question.steps')}>
            {questions.map((question, i) => (
              <button
                key={question.id}
                type="button"
                role="tab"
                aria-selected={i === index}
                aria-label={t('question.goTo', i + 1)}
                title={summary(question)}
                className={cn(
                  'question-steps__dot h-1 flex-1 rounded-full transition-colors duration-150 disabled:cursor-default',
                  i === index
                    ? 'question-steps__dot--current bg-ink'
                    : answered(question)
                      ? 'question-steps__dot--done bg-[color-mix(in_srgb,var(--ink)_35%,transparent)]'
                      : 'bg-line-strong',
                )}
                disabled={sent !== undefined}
                onClick={() => goTo(i)}
              />
            ))}
          </div>
        ) : null}
        <fieldset key={q.id} className="question m-0 min-w-0 border-0 p-0" disabled={sent !== undefined} style={{ animation: 'fade-in 200ms ease-out both' }}>
          <legend className="question__title mb-2 flex flex-wrap items-baseline gap-1.5 p-0">
            {q.header ? <ValuePill className="question__header text-[11px]">{q.header}</ValuePill> : null}
            <span className="question__text text-[14px] font-medium text-ink">{q.question}</span>
          </legend>
          {q.detail ? <p className="question__detail mt-0 mb-2 text-[12.5px] text-ink-2">{q.detail}</p> : null}
          {q.multiSelect ? <p className="question__mode mt-0 mb-1.5 text-[11.5px] text-ink-3">{t('question.multi')}</p> : null}
          {q.options.length > 0 ? (
            <GlideMenu className="question__options mb-1 flex flex-col gap-1" highlightClassName="inset-x-0 rounded-control bg-hover">
              <div role={q.multiSelect ? 'group' : 'radiogroup'} className="flex flex-col gap-1">
                {q.options.map((option) => {
                  const active = draft.selected.includes(option.label);
                  return (
                    <button
                      key={option.label}
                      type="button"
                      data-menu-row
                      role={q.multiSelect ? 'checkbox' : 'radio'}
                      aria-checked={active}
                      className={cn(
                        'question__option relative z-10 flex items-center gap-2 rounded-control py-1.5 pr-2 pl-1.5 text-left transition-colors duration-100',
                        active && 'question__option--active',
                      )}
                      onClick={() => toggle(option.label)}
                    >
                      <span
                        className={cn(
                          'question__mark flex size-4 shrink-0 items-center justify-center transition-colors duration-200',
                          q.multiSelect ? 'question__mark--box rounded-[5px]' : 'rounded-full',
                          active ? 'bg-ink text-canvas' : 'text-transparent shadow-[inset_0_0_0_1.5px_var(--line-strong)]',
                        )}
                        aria-hidden
                      >
                        {q.multiSelect ? (
                          <CheckIcon className="size-3" strokeWidth={2.8} />
                        ) : (
                          <span className="size-1.5 rounded-full bg-canvas transition-transform duration-200" style={{ transform: active ? 'scale(1)' : 'scale(0)' }} />
                        )}
                      </span>
                      <span className="question__body flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className={cn('question__label text-[13px] leading-none transition-colors duration-200', active ? 'text-ink' : 'text-ink-2')}>
                          {option.label}
                        </span>
                        {option.description ? <span className="question__description text-[11.5px] text-ink-3">{option.description}</span> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            </GlideMenu>
          ) : null}
          <label className="relative z-10 flex items-center rounded-control px-1.5 py-1 transition-colors duration-100 hover:bg-hover">
            <Input
              className="question__custom h-auto min-w-0 flex-1 border-0 bg-transparent px-0 py-0 text-[13px] text-ink shadow-none focus-visible:ring-0 placeholder:text-ink-3 dark:bg-transparent"
              value={draft.custom}
              placeholder={q.options.length > 0 ? t('question.other') : t('question.answer')}
              aria-label={t('question.answerLabel', q.question)}
              autoFocus={index > 0 && q.options.length === 0}
              onChange={(event) => setDrafts({ ...drafts, [q.id]: { ...draft, custom: event.target.value } })}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) next();
              }}
            />
          </label>
        </fieldset>
      </div>
      <div className="interaction__actions question-card__actions primitive-card-footer flex items-center justify-between gap-2 border-t border-line">
        <Button type="button" variant="ghost" size="sm" className="question-card__skip" disabled={sent !== undefined} onClick={skip}>
          {sent === 'skip' ? <SpinnerIcon className="size-3.5" /> : <FastForwardIcon className="size-3.5" />}
          {total > 1 ? t('question.skipAll') : t('question.skip')}
        </Button>
        <div className="flex items-center gap-1.5">
          {total > 1 && index > 0 ? (
            <Button type="button" variant="outline" size="sm" disabled={sent !== undefined} onClick={() => goTo(index - 1)}>
              <ArrowLeftIcon className="size-3.5" />
              {t('question.prev')}
            </Button>
          ) : null}
          {last ? (
            <Button type="button" size="sm" className="bg-brand text-brand-foreground hover:opacity-90" disabled={!complete || sent !== undefined} onClick={submit}>
              {sent === 'submit' ? <SpinnerIcon className="size-3.5" /> : <SendIcon className="size-3.5" />}
              {t('question.submit')}
            </Button>
          ) : (
            <Button type="button" size="sm" className="bg-brand text-brand-foreground hover:opacity-90" disabled={!answered(q) || sent !== undefined} onClick={next}>
              {t('question.next')}
              <ArrowRightIcon className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
