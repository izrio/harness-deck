/**
 * 输入框（Beautiful UI PromptBar / ChatComposer 卡片）：
 * 上面是上下文标签和图片缩略图、中间是多行输入、下面是工具条（模型、权限、上下文用量、发送/停止）。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { PromptImage } from '@harness-deck/shared';
import { IMAGE_MEDIA_TYPES, MAX_IMAGES, type ImageMediaType } from '@harness-deck/shared/limits';
import { registerLocalImage, showToast, useView } from '../store.ts';
import { ImageThumb } from './Images.tsx';
import { activeAtToken, formatFileMention, type ActiveAtToken } from '../mentions.ts';
import { loadState, postToHost, saveState } from '../vscode.ts';
import { cn } from '../lib/utils.ts';
import { Completion, type CompletionItem } from './Completion.tsx';
import { ContextChips } from './ContextChips.tsx';
import { ContextRing } from './ContextRing.tsx';
import { AgentIcon, ArrowUpIcon, CloseIcon, FileIcon, ImageIcon, PlanIcon, PlusIcon, StopIcon } from './icons.tsx';
import { ModelPicker } from './ModelPicker.tsx';
import { PermissionPicker } from './PermissionPicker.tsx';
import { MenuItem, Popover } from './Popover.tsx';
import { StatusDock } from './StatusDock.tsx';
import { GlideMenu } from './ui/GlideMenu.tsx';
import { useT } from '../i18n.ts';

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

let imageCounter = 0;
const nextImageId = () => `${Date.now().toString(36)}-${(++imageCounter).toString(36)}`;

function readImage(file: File): Promise<{ data: string; dataUrl: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      resolve({ dataUrl, data: dataUrl.slice(dataUrl.indexOf(',') + 1) });
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

const MAX_HEIGHT = 200;
const MIN_HEIGHT = 40;
const RESIZE_STEP = 16;

const resizeLimit = () => Math.max(120, Math.round(window.innerHeight * 0.7));
const clampHeight = (height: number) => Math.round(Math.min(Math.max(height, MIN_HEIGHT), resizeLimit()));
const SEARCH_DELAY_MS = 60;

type Trigger = { readonly kind: 'command'; readonly query: string } | { readonly kind: 'file'; readonly token: ActiveAtToken; readonly start: number };

export function matchCommands<T extends { readonly name: string }>(commands: readonly T[], query: string): T[] {
  const q = query.toLowerCase();
  const starts: T[] = [];
  const contains: T[] = [];
  for (const command of commands) {
    const at = command.name.toLowerCase().indexOf(q);
    if (at === 0) starts.push(command);
    else if (at > 0) contains.push(command);
  }
  return [...starts, ...contains];
}

function triggerAt(text: string, caret: number): Trigger | undefined {
  const before = text.slice(0, caret);
  const command = /^\/(\S*)$/u.exec(before);
  if (command) return { kind: 'command', query: command[1] ?? '' };
  const line = before.slice(before.lastIndexOf('\n') + 1);
  const token = activeAtToken(line);
  return token ? { kind: 'file', token, start: caret - token.prefix.length } : undefined;
}

let nextRequestId = 0;

export function Composer() {
  const session = useView((s) => s.session);
  const connected = useView((s) => s.connection === 'connected');
  const focusRequests = useView((s) => s.focusRequests);
  const prefill = useView((s) => s.prefill);
  const context = useView((s) => s.context);
  const commands = useView((s) => s.commands);
  const candidates = useView((s) => s.fileCandidates);
  const t = useT();
  const tabKey = useView((s) => s.tabs.active);
  const [images, setImages] = useState<PromptImage[]>([]);
  const imageStash = useRef(new Map<string, PromptImage[]>());
  const [text, setText] = useState(() => loadState().draft ?? '');
  const draftOwner = useRef(tabKey);
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  const [dismissedFor, setDismissedFor] = useState<string | undefined>();
  const [requestId, setRequestId] = useState(-1);
  const [toggledKey, setToggledKey] = useState<string | undefined>();
  const ref = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [inputHeight, setInputHeight] = useState<number | undefined>(() => loadState().inputHeight);

  useEffect(() => {
    saveState({ draft: text });
  }, [text]);

  useEffect(() => {
    const previous = draftOwner.current;
    draftOwner.current = tabKey;
    if (!previous || previous === tabKey) return;
    const { [tabKey]: next = '', ...rest } = loadState().drafts ?? {};
    saveState({ drafts: text.trim() ? { ...rest, [previous]: text } : rest });
    setText(next);
    imageStash.current.set(previous, images);
    setImages(imageStash.current.get(tabKey) ?? []);
    imageStash.current.delete(tabKey);
    setCaret(next.length);
  }, [tabKey]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const max = Math.max(MAX_HEIGHT, inputHeight ?? 0);
    el.style.maxHeight = `${max}px`;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, inputHeight ?? 0), max)}px`;
  }, [text, inputHeight]);

  const commitHeight = (height: number | undefined) => {
    setInputHeight(height);
    saveState({ inputHeight: height });
  };

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const startY = event.clientY;
    const startHeight = el.getBoundingClientRect().height;
    let latest = startHeight;
    let moved = false;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing');
    const move = (e: globalThis.PointerEvent) => {
      latest = clampHeight(startHeight + (startY - e.clientY));
      moved = true;
      setInputHeight(latest);
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      document.body.classList.remove('resizing');
      if (moved) saveState({ inputHeight: latest });
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  const resizeByKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const current = inputHeight ?? ref.current?.getBoundingClientRect().height ?? MIN_HEIGHT;
    commitHeight(clampHeight(current + (event.key === 'ArrowUp' ? RESIZE_STEP : -RESIZE_STEP)));
  };

  useEffect(() => {
    ref.current?.focus();
  }, [focusRequests, session.id]);

  useEffect(() => {
    if (prefill.n === 0) return;
    const current = ref.current?.value ?? '';
    const next = prefill.mode === 'restore' && current.trim() ? `${prefill.text}\n${current}` : prefill.text;
    setText(next);
    setCaret(next.length);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(next.length, next.length);
    });
  }, [prefill]);

  const trigger = dismissedFor === text ? undefined : triggerAt(text, caret);
  const fileQuery = trigger?.kind === 'file' ? trigger.token.query : undefined;

  useEffect(() => {
    if (fileQuery === undefined || !connected) return;
    const id = ++nextRequestId;
    setRequestId(id);
    const timer = setTimeout(() => {
      postToHost({ type: 'searchFiles', payload: { requestId: id, query: fileQuery } });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [fileQuery, connected]);

  const items: CompletionItem[] = useMemo(() => {
    if (trigger?.kind === 'command') {
      return matchCommands(commands, trigger.query).map((c) => ({
        key: `${c.source}:${c.name}`,
        icon: 'command',
        label: `/${c.name}`,
        ...(c.source === 'skill' ? { tag: 'skill' } : {}),
        ...(c.hint ? { hint: c.hint } : {}),
        detail: c.description,
      }));
    }
    if (trigger?.kind === 'file' && candidates.requestId >= 0) {
      return candidates.items.map((c) => {
        const slash = c.path.lastIndexOf('/');
        return {
          key: `${c.kind}:${c.path}`,
          icon: c.kind,
          label: slash >= 0 ? c.path.slice(slash + 1) : c.path,
          ...(slash >= 0 ? { detail: c.path.slice(0, slash) } : {}),
        };
      });
    }
    return [];
  }, [trigger?.kind, trigger?.kind === 'command' ? trigger.query : undefined, commands, candidates]);

  useEffect(() => setSelected(0), [items.length, trigger?.kind, fileQuery]);

  const complete =
    trigger?.kind === 'file'
      ? candidates.items.some((c) => c.kind === 'file' && c.path === trigger.token.query)
      : trigger?.kind === 'command' && commands.some((c) => c.name.toLowerCase() === trigger.query.toLowerCase());
  const menuOpen = trigger !== undefined && !complete && (items.length > 0 || trigger.kind === 'file');

  const replaceRange = (start: number, end: number, insertion: string) => {
    const next = text.slice(0, start) + insertion + text.slice(end);
    const position = start + insertion.length;
    setText(next);
    setCaret(position);
    requestAnimationFrame(() => ref.current?.setSelectionRange(position, position));
  };

  const accept = (index: number) => {
    if (!trigger) return;
    if (trigger.kind === 'command') {
      const command = matchCommands(commands, trigger.query)[index];
      if (command) replaceRange(0, caret, `/${command.name} `);
      return;
    }
    const candidate = candidates.items[index];
    if (!candidate) return;
    const mention = formatFileMention(candidate, trigger.token.quoted);
    if (!mention) return;
    replaceRange(trigger.start, caret, candidate.kind === 'file' ? `${mention} ` : mention);
  };

  const active = context.active;
  const includeActive = active ? context.includeActiveByDefault !== (toggledKey === active.key) : true;

  const addImages = async (files: readonly File[]) => {
    let room = MAX_IMAGES - images.length;
    const added: PromptImage[] = [];
    for (const file of files) {
      if (!(IMAGE_MEDIA_TYPES as readonly string[]).includes(file.type)) {
        showToast('error', t('image.unsupported', file.type || file.name));
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        showToast('error', t('image.tooLarge', file.name || t('image.label'), MAX_IMAGE_BYTES / 1024 / 1024));
        continue;
      }
      if (room <= 0) {
        showToast('error', t('image.tooMany', MAX_IMAGES));
        break;
      }
      try {
        const { data, dataUrl } = await readImage(file);
        const localId = nextImageId();
        registerLocalImage(localId, dataUrl);
        const name = file.name && file.name !== 'image.png' ? file.name : undefined;
        added.push({ localId, mediaType: file.type as ImageMediaType, data, ...(name ? { name } : {}) });
        room--;
      } catch {
        showToast('error', t('image.failed'));
      }
    }
    if (added.length) setImages((current) => [...current, ...added].slice(0, MAX_IMAGES));
  };

  const imageFiles = (list: DataTransferItemList | FileList | null | undefined): File[] => {
    if (!list) return [];
    if ('length' in list && list.length > 0 && list[0] instanceof File) return [...(list as FileList)].filter((f) => f.type.startsWith('image/'));
    return [...(list as DataTransferItemList)]
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
  };

  const readOnly = session.subagentOf !== undefined;
  const canSend = connected && !readOnly && (text.trim().length > 0 || images.length > 0);
  const send = () => {
    if (!canSend) return;
    postToHost({ type: 'sendMessage', payload: { text: text.trim(), includeActive, ...(images.length ? { images } : {}) } });
    setText('');
    setCaret(0);
    setImages([]);
    setToggledKey(undefined);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = event.nativeEvent.isComposing || event.keyCode === 229;
    if (menuOpen && !composing) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (items.length) setSelected((selected + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        if (items.length) {
          event.preventDefault();
          accept(selected);
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissedFor(text);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !composing) {
      event.preventDefault();
      send();
      return;
    }
    if (event.key === 'Escape' && !composing && session.running && !readOnly) {
      event.preventDefault();
      postToHost({ type: 'interrupt', payload: {} });
    }
  };

  const syncCaret = () => setCaret(ref.current?.selectionStart ?? 0);
  const showStop = session.running && !readOnly;
  const showSend = !showStop || text.trim().length > 0 || images.length > 0;

  return (
    <div className="content-column relative shrink-0">
      <StatusDock />
      {session.subagentOf ? (
        <div className="mb-2 flex items-center gap-2 rounded-card bg-surface px-3 py-2 text-[12px] text-ink-2 shadow-card" data-testid="subagent-strip">
          <AgentIcon className="size-3.5 shrink-0 text-ink-3" />
          <span>{t('subagent.readOnlyHint')}</span>
          <button
            type="button"
            className="ml-auto font-medium text-ink hover:underline"
            onClick={() => postToHost({ type: 'switchSession', payload: { sessionId: session.subagentOf!.parentId } })}
          >
            {t('subagent.backToParent')}
          </button>
        </div>
      ) : null}
      {menuOpen && trigger ? (
        <Completion
          items={items}
          selected={selected}
          onSelect={accept}
          onHover={setSelected}
          label={trigger.kind === 'command' ? t('completion.commands') : t('completion.files')}
          {...(trigger.kind === 'file' ? { empty: t('completion.noFiles') } : {})}
          {...(trigger.kind === 'file' && requestId !== candidates.requestId ? { loading: t('completion.searching') } : {})}
        />
      ) : null}
      <div
        className="composer relative mb-2.5 flex flex-col rounded-window bg-surface p-1.5 shadow-card transition-shadow duration-150 focus-within:shadow-[0_0_0_1px_var(--accent),var(--shadow-sm)]"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault();
        }}
        onDrop={(event) => {
          const files = imageFiles(event.dataTransfer.files);
          if (files.length === 0) return;
          event.preventDefault();
          void addImages(files);
        }}
      >
        <div
          className="composer__resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label={t('composer.resize')}
          title={t('composer.resize')}
          tabIndex={0}
          onPointerDown={startResize}
          onDoubleClick={() => commitHeight(undefined)}
          onKeyDown={resizeByKey}
          data-testid="composer-resize"
        />
        <ContextChips active={active} included={includeActive} onToggle={() => active && setToggledKey(toggledKey === active.key ? undefined : active.key)} pinned={context.pinned} />
        {images.length ? (
          <div className="composer__images flex flex-wrap gap-1.5 px-2 pt-1.5" data-testid="composer-images">
            {images.map((image) => (
              <ImageThumb key={image.localId} image={image} size="small" onRemove={() => setImages((current) => current.filter((i) => i.localId !== image.localId))} />
            ))}
          </div>
        ) : null}
        <textarea
          ref={ref}
          className="composer__input block min-h-10 w-full resize-none border-0 bg-transparent px-2 pt-1.5 pb-1 text-ink outline-none leading-[1.5] placeholder:truncate placeholder:text-ink-3"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setCaret(event.target.selectionStart);
          }}
          onSelect={syncCaret}
          onClick={syncCaret}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            const files = imageFiles(event.clipboardData.items);
            if (files.length === 0) return;
            if (!event.clipboardData.types.includes('text/plain')) event.preventDefault();
            void addImages(files);
          }}
          disabled={readOnly}
          placeholder={
            readOnly
              ? t('subagent.readOnlyHint')
              : connected
                ? session.running
                  ? t('composer.placeholderRunning')
                  : t('composer.placeholder')
                : t('composer.placeholderOffline')
          }
          rows={1}
          aria-label={t('composer.label')}
          aria-autocomplete="list"
          aria-expanded={menuOpen}
          {...(menuOpen ? { 'aria-controls': 'composer-completion', 'aria-activedescendant': `completion-${selected}` } : {})}
        />
        <div className="composer__toolbar flex min-w-0 items-center gap-1 pt-1 [&>*]:flex-none [&>.model-picker]:min-w-0 [&>.model-picker]:flex-[0_1_auto]">
          <div className="relative">
            <button
              type="button"
              data-testid="composer-attach-btn"
              disabled={!connected || readOnly}
              aria-label={t('composer.attach')}
              title={t('composer.attach')}
              aria-haspopup="menu"
              aria-expanded={attachOpen}
              className={cn(
                'inline-flex size-7 items-center justify-center rounded-[8px] text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-40',
                attachOpen && 'bg-field text-ink shadow-hairline',
              )}
              onClick={() => setAttachOpen((v) => !v)}
            >
              <PlusIcon className="size-4" />
            </button>
            <input
              ref={imageInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              className="hidden"
              data-testid="composer-image-input"
              onChange={(event) => {
                const picked = event.target.files ? [...event.target.files] : [];
                event.target.value = '';
                if (picked.length > 0) void addImages(picked);
              }}
            />
            <Popover
              open={attachOpen}
              onClose={() => setAttachOpen(false)}
              label={t('composer.attach')}
              className="top-auto bottom-[calc(100%+6px)] left-0 w-44 min-w-[168px]"
            >
              <div role="menu" data-testid="composer-attach-menu">
                <GlideMenu className="flex flex-col gap-px" highlightClassName="inset-x-0 rounded-[6px] bg-hover">
                  <MenuItem
                    icon={<FileIcon className="size-3.5" />}
                    onSelect={() => {
                      setAttachOpen(false);
                      postToHost({ type: 'pickFiles', payload: {} });
                    }}
                  >
                    {t('composer.attachFile')}
                  </MenuItem>
                  <MenuItem
                    icon={<ImageIcon className="size-3.5" />}
                    onSelect={() => {
                      setAttachOpen(false);
                      imageInputRef.current?.click();
                    }}
                  >
                    {t('composer.attachImage')}
                  </MenuItem>
                </GlideMenu>
              </div>
            </Popover>
          </div>
          <ModelPicker disabled={!connected || readOnly} />
          <PermissionPicker disabled={!connected || readOnly} />
          {session.planMode ? (
            <button
              type="button"
              className="toolbar-button plan-badge inline-flex h-7 items-center gap-1 rounded-[8px] bg-accent-tint px-2 text-[12px] font-medium text-accent-ink transition-opacity duration-150 hover:opacity-85"
              title={t('composer.planTitle')}
              onClick={() => postToHost({ type: 'sendMessage', payload: { text: '/plan off' } })}
              data-testid="plan-badge"
            >
              <PlanIcon className="size-3.5" />
              <span className="toolbar-button__text">{t('composer.plan')}</span>
              <CloseIcon className="size-3" />
            </button>
          ) : null}
          {session.contextUsage !== undefined ? <ContextRing usage={session.contextUsage} {...(session.contextTokens ? { tokens: session.contextTokens } : {})} /> : null}
          <span className="composer__spacer min-w-0 flex-1!" />
          {showStop ? (
            <button
              type="button"
              className={cn(
                'send-button send-button--stop inline-flex size-7 items-center justify-center rounded-[8px] transition-[background-color,color,transform] duration-150 active:scale-[0.95]',
                showSend
                  ? 'send-button--secondary bg-field text-ink shadow-hairline hover:bg-hover-2'
                  : 'bg-ink text-surface hover:opacity-90',
              )}
              onClick={() => postToHost({ type: 'interrupt', payload: {} })}
              aria-label={t('composer.stop')}
              title={t('composer.stopHint')}
            >
              <StopIcon className="size-3.5" />
            </button>
          ) : null}
          {showSend ? (
            <button
              type="button"
              className={cn(
                'send-button inline-flex size-7 items-center justify-center rounded-[8px] transition-[background-color,color,transform] duration-150 enabled:active:scale-[0.95] disabled:cursor-default',
                canSend ? 'bg-ink text-surface hover:opacity-90' : 'bg-line-strong text-ink-2',
              )}
              disabled={!canSend}
              onClick={send}
              aria-label={t('composer.send')}
              title={t('composer.sendTitle')}
            >
              <ArrowUpIcon className="size-4" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
