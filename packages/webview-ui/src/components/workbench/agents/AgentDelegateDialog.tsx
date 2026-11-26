/**
 * 委派任务弹窗：Modal + 会话输入框卡片。
 *
 * 与「新建任务」「新建智能体」一致，复用会话输入框（`composer` 卡片）的样式与交互：
 * 支持 @ 引用文件、附件选择（与任务输入框共用 pendingTaskFiles 通道）以及 Cmd/Ctrl+Enter 提交。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { AgentProfile } from '@harness-deck/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useT } from '@/i18n';
import { activeAtToken, formatFileMention, type ActiveAtToken } from '../../../mentions.ts';
import { useView } from '../../../store.ts';
import { postToHost } from '../../../vscode.ts';
import { Completion, type CompletionItem } from '../../Completion.tsx';
import { AgentIcon, PaperclipIcon, SendIcon } from '../../icons.tsx';

const SEARCH_DELAY_MS = 60;

let nextDelegateSearchId = 600_000;

function fileTriggerAt(text: string, caret: number): { readonly token: ActiveAtToken; readonly start: number } | undefined {
  const before = text.slice(0, caret);
  const line = before.slice(before.lastIndexOf('\n') + 1);
  const token = activeAtToken(line);
  return token ? { token, start: caret - token.prefix.length } : undefined;
}

function formatPickedMention(path: string): string {
  return /\s/u.test(path) ? `@"${path}"` : `@${path}`;
}

export function AgentDelegateDialog({
  agent,
  projectOptions,
  onClose,
  onSubmit,
}: {
  readonly agent: AgentProfile;
  readonly projectOptions: readonly (readonly [string, string])[];
  readonly onClose: () => void;
  readonly onSubmit: (payload: { readonly agentId: string; readonly prompt: string; readonly projectPath: string }) => void;
}) {
  const t = useT();
  const connected = useView((s) => s.connection === 'connected');
  const candidates = useView((s) => s.fileCandidates);
  const pendingTaskFiles = useView((s) => s.pendingTaskFiles);
  const projects = useView((s) => s.projects);

  const [prompt, setPrompt] = useState('');
  const [projectPath, setProjectPath] = useState(projects.currentPath ?? projects.recent[0]?.path ?? '');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const handledFilesRef = useRef(pendingTaskFiles.n);
  const [caret, setCaret] = useState(0);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [dismissedFor, setDismissedFor] = useState<string | undefined>();
  const [requestId, setRequestId] = useState(-1);

  const trigger = dismissedFor !== prompt ? fileTriggerAt(prompt, caret) : undefined;
  const fileQuery = trigger?.token.query;

  useEffect(() => {
    if (pendingTaskFiles.n === handledFilesRef.current || pendingTaskFiles.paths.length === 0) return;
    handledFilesRef.current = pendingTaskFiles.n;
    const insertion = pendingTaskFiles.paths.map(formatPickedMention).join(' ');
    const el = textareaRef.current;
    const start = el?.selectionStart ?? prompt.length;
    const end = el?.selectionEnd ?? prompt.length;
    const needLeadingSpace = start > 0 && !/\s/u.test(prompt[start - 1] ?? '');
    const chunk = `${needLeadingSpace ? ' ' : ''}${insertion} `;
    const next = prompt.slice(0, start) + chunk + prompt.slice(end);
    const nextCaret = start + chunk.length;
    setPrompt(next);
    setCaret(nextCaret);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  }, [pendingTaskFiles, prompt]);

  useEffect(() => {
    if (fileQuery === undefined || !connected) return;
    const id = ++nextDelegateSearchId;
    setRequestId(id);
    const timer = setTimeout(() => {
      postToHost({ type: 'searchFiles', payload: { requestId: id, query: fileQuery } });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [fileQuery, connected]);

  const completionItems: CompletionItem[] = useMemo(() => {
    if (!trigger || candidates.requestId < 0) return [];
    return candidates.items.map((c) => {
      const slash = c.path.lastIndexOf('/');
      return {
        key: `${c.kind}:${c.path}`,
        icon: c.kind,
        label: slash >= 0 ? c.path.slice(slash + 1) : c.path,
        ...(slash >= 0 ? { detail: c.path.slice(0, slash) } : {}),
      };
    });
  }, [trigger, candidates]);

  useEffect(() => setSelectedIdx(0), [completionItems.length, fileQuery]);

  const complete = trigger ? candidates.items.some((c) => c.kind === 'file' && c.path === trigger.token.query) : false;
  const menuOpen = trigger !== undefined && !complete && (completionItems.length > 0 || connected);
  const canSubmit = prompt.trim().length > 0;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit({ agentId: agent.id, prompt: prompt.trim(), projectPath });
  };

  const acceptCandidate = (index: number) => {
    if (!trigger) return;
    const candidate = candidates.items[index];
    if (!candidate) return;
    const mention = formatFileMention(candidate, trigger.token.quoted);
    if (!mention) return;
    const insertion = candidate.kind === 'file' ? `${mention} ` : mention;
    const next = prompt.slice(0, trigger.start) + insertion + prompt.slice(caret);
    const nextPos = trigger.start + insertion.length;
    setPrompt(next);
    setCaret(nextPos);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextPos, nextPos);
    });
  };

  const onPromptKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = e.nativeEvent.isComposing || e.keyCode === 229;
    if (menuOpen && !composing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (completionItems.length > 0) {
          setSelectedIdx((selectedIdx + (e.key === 'ArrowDown' ? 1 : completionItems.length - 1)) % completionItems.length);
        }
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        if (completionItems.length > 0) {
          e.preventDefault();
          acceptCandidate(selectedIdx);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setDismissedFor(prompt);
        return;
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };

  const syncCaret = () => setCaret(textareaRef.current?.selectionStart ?? 0);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="agent-delegate-dialog" aria-modal="true" className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[14px]">
            <AgentIcon className="size-4 text-accent-ink" />
            <span>{t('wb.agents.delegate')}</span>
            <span className="truncate text-ink-3">{agent.name}</span>
          </DialogTitle>
          <DialogDescription className="sr-only">{agent.specialty}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="relative" data-testid="agent-delegate-composer">
            {menuOpen && trigger ? (
              <Completion
                items={completionItems}
                selected={selectedIdx}
                onSelect={acceptCandidate}
                onHover={setSelectedIdx}
                label={t('completion.files')}
                empty={t('completion.noFiles')}
                {...(requestId !== candidates.requestId ? { loading: t('completion.searching') } : {})}
              />
            ) : null}

            <div className="composer surface-glass relative flex flex-col rounded-2xl border border-black/8 p-1.5 shadow-[var(--shadow-composer)] transition-[border-color,box-shadow] duration-150 focus-within:border-ring/45 focus-within:shadow-[0_0_0_1px_color-mix(in_oklch,var(--accent)_30%,transparent),var(--shadow-composer)] dark:border-white/[0.07] dark:inset-shadow-[0_1px_rgb(255_255_255/3%)]">
              <textarea
                ref={textareaRef}
                data-testid={`agent-delegate-input-${agent.id}`}
                rows={6}
                value={prompt}
                placeholder={t('wb.agents.delegatePromptPlaceholder')}
                aria-label={t('wb.agents.delegatePromptPlaceholder')}
                aria-autocomplete="list"
                aria-expanded={menuOpen}
                className="composer__input block max-h-72 min-h-36 w-full resize-none overflow-y-auto border-0 bg-transparent px-2 pt-1.5 pb-1 text-[13px] leading-[1.5] text-ink outline-none placeholder:text-ink-3"
                onChange={(e) => {
                  setPrompt(e.target.value);
                  setCaret(e.target.selectionStart);
                }}
                onSelect={syncCaret}
                onClick={syncCaret}
                onKeyDown={onPromptKeyDown}
              />

              <div className="composer__toolbar flex min-w-0 items-center gap-1 pt-1">
                <button
                  type="button"
                  data-testid={`agent-delegate-attach-${agent.id}`}
                  aria-label={t('composer.attach')}
                  title={t('composer.attach')}
                  onClick={() => postToHost({ type: 'pickTaskFiles', payload: { projectPath } })}
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-[8px] text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink"
                >
                  <PaperclipIcon className="size-4" />
                </button>

                {projectOptions.length > 0 ? (
                  <div className="min-w-0 flex-[0_1_220px]">
                    <Select value={projectPath || undefined} onValueChange={setProjectPath}>
                      <SelectTrigger
                        size="xs"
                        className="w-full"
                        data-testid="agent-delegate-project"
                        aria-label={t('wb.tasks.selectProject')}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {projectOptions.map(([path, label]) => (
                          <SelectItem key={path} value={path}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}

                <span className="composer__spacer min-w-0 flex-1!" />
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" data-testid="agent-delegate-cancel" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid={`agent-delegate-submit-${agent.id}`}
            disabled={!canSubmit}
            onClick={submit}
          >
            <SendIcon className="size-3" />
            <span>{t('wb.agents.delegateConfirm')}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default AgentDelegateDialog;
