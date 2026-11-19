/**
 * 设置 -> 会话 -> 聊天命令：
 * 保存常用提示词，在输入框输入 / 选用，填入后可改再发；所有 Agent 通用。
 */
import { useState } from 'react';
import type { ChatCommand } from '@harness-deck/shared';
import { useT } from '../../i18n.ts';
import { closeSettingsPage, requestPrefill, setPreferencesLocal, useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import { PencilIcon, PlusIcon, SendIcon, SlashIcon, TrashIcon } from '../icons.tsx';
import { ValuePill } from '../beautifului/index.ts';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

interface CommandFormState {
  readonly editingName?: string;
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
}

function emptyForm(): CommandFormState {
  return { name: '', description: '', prompt: '' };
}

function formFromCommand(cmd: ChatCommand): CommandFormState {
  return {
    editingName: cmd.name,
    name: cmd.name,
    description: cmd.description ?? '',
    prompt: cmd.prompt,
  };
}

export function ChatCommandSettings() {
  const t = useT();
  const preferences = useView((s) => s.preferences);
  const chatCommands = preferences.chatCommands ?? [];

  const [form, setForm] = useState<CommandFormState | undefined>();
  const [formError, setFormError] = useState<string | undefined>();

  const commitCommands = (next: readonly ChatCommand[]) => {
    setPreferencesLocal({ ...preferences, chatCommands: next });
    postToHost({ type: 'setPreferences', payload: { chatCommands: [...next] } });
  };

  const openAdd = () => {
    setFormError(undefined);
    setForm(emptyForm());
  };

  const openEdit = (cmd: ChatCommand) => {
    setFormError(undefined);
    setForm(formFromCommand(cmd));
  };

  const closeForm = () => {
    setForm(undefined);
    setFormError(undefined);
  };

  const submitForm = () => {
    if (!form) return;
    const cleanName = form.name.trim().replace(/^\/+/u, '');
    const cleanDesc = form.description.trim();
    const prompt = form.prompt;
    if (!cleanName || /\s/u.test(cleanName) || !prompt.trim()) {
      setFormError(t('settings.commands.form.validation'));
      return;
    }

    const nextCmd: ChatCommand = {
      name: cleanName,
      prompt,
      ...(cleanDesc ? { description: cleanDesc } : {}),
    };

    const editingKey = form.editingName?.toLowerCase();
    const nextKey = cleanName.toLowerCase();
    const nextList: ChatCommand[] = [];
    let replaced = false;

    for (const item of chatCommands) {
      const itemKey = item.name.toLowerCase();
      if (editingKey !== undefined && itemKey === editingKey) {
        if (!replaced) {
          nextList.push(nextCmd);
          replaced = true;
        }
        continue;
      }
      if (itemKey === nextKey) {
        if (!replaced) {
          nextList.push(nextCmd);
          replaced = true;
        }
        continue;
      }
      nextList.push(item);
    }

    if (!replaced) {
      nextList.push(nextCmd);
    }

    commitCommands(nextList);
    setForm(undefined);
    setFormError(undefined);
  };

  const deleteCommand = (name: string) => {
    const target = name.toLowerCase();
    commitCommands(chatCommands.filter((item) => item.name.toLowerCase() !== target));
    if (form?.editingName?.toLowerCase() === target) {
      setForm(undefined);
      setFormError(undefined);
    }
  };

  const fillIntoComposer = (prompt: string) => {
    requestPrefill(prompt, 'replace');
    closeSettingsPage();
  };

  return (
    <div className="flex flex-col gap-3" data-testid="settings-chat-commands">
      <section className="flex flex-col overflow-hidden rounded-card bg-surface shadow-card">
        <div className="primitive-card-bar flex flex-wrap items-start justify-between gap-2 border-b border-line bg-inset/50">
          <div className="flex min-w-0 items-start gap-2">
            <SlashIcon className="mt-0.5 size-3.5 shrink-0 text-accent-ink" />
            <div className="min-w-0">
              <h3 className="m-0 text-[13px] font-semibold text-ink">{t('settings.commands.title')}</h3>
              <p className="mt-0.5 mb-0 text-[11.5px] leading-relaxed text-ink-3">{t('settings.commands.desc')}</p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="xs"
            data-testid="chat-command-add-btn"
            onClick={openAdd}
          >
            <PlusIcon className="size-3" />
            <span>{t('settings.commands.add')}</span>
          </Button>
        </div>

        <div className="primitive-card-pad flex flex-col gap-2.5">
          <Dialog open={Boolean(form)} onOpenChange={(open) => !open && closeForm()}>
            {form ? (
              <DialogContent data-testid="chat-command-form" aria-modal="true" className="sm:max-w-[520px]">
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2 text-[14px]">
                    <SlashIcon className="size-4 text-accent-ink" />
                    <span>
                      {form.editingName
                        ? t('settings.commands.form.editTitle', form.editingName)
                        : t('settings.commands.form.addTitle')}
                    </span>
                  </DialogTitle>
                  <DialogDescription className="sr-only">{t('settings.commands.desc')}</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-3">
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    <label className="flex flex-col gap-1">
                      <span className="text-[12px] font-medium text-ink-2">{t('settings.commands.form.name')}</span>
                      <Input
                        size="sm"
                        data-testid="chat-command-form-name"
                        className="font-mono text-[12px]"
                        value={form.name}
                        placeholder={t('settings.commands.form.namePlaceholder')}
                        onChange={(e) => setForm({ ...form, name: e.target.value })}
                      />
                    </label>

                    <label className="flex flex-col gap-1">
                      <span className="text-[12px] font-medium text-ink-2">{t('settings.commands.form.desc')}</span>
                      <Input
                        size="sm"
                        data-testid="chat-command-form-desc"
                        className="text-[12px]"
                        value={form.description}
                        placeholder={t('settings.commands.form.descPlaceholder')}
                        onChange={(e) => setForm({ ...form, description: e.target.value })}
                      />
                    </label>
                  </div>

                  <label className="flex flex-col gap-1">
                    <span className="text-[12px] font-medium text-ink-2">{t('settings.commands.form.prompt')}</span>
                    <Textarea
                      data-testid="chat-command-form-prompt"
                      rows={4}
                      className="text-[12px] leading-relaxed"
                      value={form.prompt}
                      placeholder={t('settings.commands.form.promptPlaceholder')}
                      onChange={(e) => setForm({ ...form, prompt: e.target.value })}
                    />
                  </label>

                  {formError ? (
                    <div className="text-[11.5px] text-red" role="alert">
                      {formError}
                    </div>
                  ) : null}
                </div>

                <DialogFooter>
                  <Button type="button" variant="outline" size="sm" data-testid="chat-command-form-cancel" onClick={closeForm}>
                    {t('common.cancel')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    data-testid="chat-command-form-save"
                    onClick={submitForm}
                  >
                    {t('settings.commands.form.save')}
                  </Button>
                </DialogFooter>
              </DialogContent>
            ) : null}
          </Dialog>

          {chatCommands.length === 0 ? (
            <div
              className="rounded-control bg-field px-3 py-5 text-center text-[12px] text-ink-3 shadow-hairline"
              data-testid="chat-commands-empty"
            >
              {t('settings.commands.empty')}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {chatCommands.map((cmd) => (
                <div
                  key={cmd.name}
                  className="flex flex-col gap-2 rounded-card bg-field p-3 shadow-hairline"
                  data-testid={`chat-command-item-${cmd.name}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="inline-flex items-center rounded-chip bg-surface px-2 py-0.5 font-mono text-[12px] font-semibold text-ink shadow-hairline">
                          /{cmd.name}
                        </span>
                        <ValuePill tone="accent" className="text-[10.5px]">
                          {t('settings.commands.badge')}
                        </ValuePill>
                        {cmd.description ? (
                          <span className="truncate text-[12px] text-ink-2">{cmd.description}</span>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        data-testid={`use-chat-command-${cmd.name}`}
                        onClick={() => fillIntoComposer(cmd.prompt)}
                      >
                        <SendIcon className="size-3" />
                        <span>{t('settings.commands.use')}</span>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t('common.edit')}
                        data-testid={`edit-chat-command-${cmd.name}`}
                        onClick={() => openEdit(cmd)}
                      >
                        <PencilIcon className="size-3" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="text-red hover:bg-red-tint hover:text-red"
                        aria-label={t('common.delete')}
                        data-testid={`delete-chat-command-${cmd.name}`}
                        onClick={() => deleteCommand(cmd.name)}
                      >
                        <TrashIcon className="size-3" />
                      </Button>
                    </div>
                  </div>

                  <p className="m-0 line-clamp-3 rounded-control bg-surface/80 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-2 shadow-hairline">
                    {cmd.prompt}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
