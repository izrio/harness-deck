/**
 * 设置 -> 会话 -> 聊天命令：
 * 去线留白：移除行间横线与冗余「提示词」胶囊，让 /命令名 与正文预览直接自解释。
 */
import { useState } from 'react';
import type { ChatCommand } from '@harness-deck/shared';
import { SettingsSection } from './SettingsSection.tsx';
import { useT } from '../../i18n.ts';
import { closeSettingsPage, requestPrefill, setPreferencesLocal, useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import { MoreIcon, PencilIcon, PlusIcon, SendIcon, SlashIcon, TrashIcon } from '../icons.tsx';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
    <div className="flex flex-col gap-8" data-testid="settings-chat-commands">
      <SettingsSection
        title={t('settings.commands.title')}
        actions={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="chat-command-add-btn"
            onClick={openAdd}
          >
            <PlusIcon className="size-3.5" />
            <span>{t('settings.commands.add')}</span>
          </Button>
        }
      >
        {chatCommands.length === 0 ? (
          <div
            className="px-4 py-10 text-center text-[12px] text-ink-3"
            data-testid="chat-commands-empty"
          >
            {t('settings.commands.empty')}
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-line/55 px-4">
            {chatCommands.map((cmd) => (
              <div
                key={cmd.name}
                className="flex items-start justify-between gap-4 py-3.5"
                data-testid={`chat-command-item-${cmd.name}`}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="font-mono text-[13px] font-semibold text-ink">/{cmd.name}</span>
                    {cmd.description ? (
                      <span className="truncate text-[12px] text-ink-2">{cmd.description}</span>
                    ) : null}
                  </div>
                  <p className="m-0 line-clamp-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-3">
                    {cmd.prompt}
                  </p>
                </div>

                <div className="shrink-0">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="shrink-0 text-ink-2 hover:text-ink"
                        data-testid={`chat-command-actions-${cmd.name}`}
                        aria-label={t('common.moreActions')}
                        title={t('common.moreActions')}
                      >
                        <MoreIcon className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-40">
                      <DropdownMenuItem
                        className="gap-2 text-[12.5px]"
                        data-testid={`use-chat-command-${cmd.name}`}
                        onSelect={() => fillIntoComposer(cmd.prompt)}
                      >
                        <SendIcon className="size-3.5 text-ink-2" />
                        <span>{t('settings.commands.use')}</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="gap-2 text-[12.5px]"
                        data-testid={`edit-chat-command-${cmd.name}`}
                        onSelect={() => openEdit(cmd)}
                      >
                        <PencilIcon className="size-3.5 text-ink-2" />
                        <span>{t('common.edit')}</span>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        className="gap-2 text-[12.5px]"
                        data-testid={`delete-chat-command-${cmd.name}`}
                        onSelect={() => deleteCommand(cmd.name)}
                      >
                        <TrashIcon className="size-3.5" />
                        <span>{t('common.delete')}</span>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

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
    </div>
  );
}
