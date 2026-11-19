/**
 * 设置 -> Agent -> 智能体配置：
 * Node.js/npm 运行环境、内置智能体安装/版本切换/密钥配置、以及外部 ACP 智能体管理（新增/编辑/删除）。
 */
import { useEffect, useRef, useState } from 'react';
import type { BackendView } from '@harness-deck/shared';
import { useT } from '../../i18n.ts';
import { useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import { AgentIcon, PlusIcon, RefreshIcon } from '../icons.tsx';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { NodeEnvBanner } from './agents/NodeEnvBanner.tsx';
import { BackendCard } from './agents/BackendCard.tsx';

interface AgentFormState {
  readonly isNew: boolean;
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly argsText: string;
  readonly envText: string;
  readonly installHint: string;
  readonly singleSession: boolean;
}

function emptyForm(): AgentFormState {
  return {
    isNew: true,
    id: '',
    name: '',
    command: '',
    argsText: '',
    envText: '',
    installHint: '',
    singleSession: false,
  };
}

function formFromBackend(backend: BackendView): AgentFormState {
  const envEntries = Object.entries(backend.env ?? {}).map(([k, v]) => `${k}=${v}`);
  return {
    isNew: false,
    id: backend.id,
    name: backend.name,
    command: backend.executable ?? '',
    argsText: (backend.args ?? []).join(' '),
    envText: envEntries.join('\n'),
    installHint: backend.installHint ?? '',
    singleSession: backend.singleSession === true,
  };
}

function parseEnvText(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1);
    if (key) env[key] = val;
  }
  return env;
}

export function AgentSettings() {
  const t = useT();
  const backends = useView((s) => s.backends);
  const providers = useView((s) => s.providers.items);
  const nodeEnv = backends.nodeEnv;
  const requestedVersionsRef = useRef(new Set<string>());
  const [form, setForm] = useState<AgentFormState | undefined>();
  const [formError, setFormError] = useState<string | undefined>();

  useEffect(() => {
    if (!nodeEnv?.checked) {
      postToHost({ type: 'checkBackendEnv', payload: {} });
    }
  }, [nodeEnv?.checked]);

  useEffect(() => {
    if (!nodeEnv?.checked || !nodeEnv.hasNpm) return;
    for (const item of backends.items) {
      if (!item.npmPackage) continue;
      if (item.versions !== undefined || item.versionsLoading || item.versionsError) continue;
      if (requestedVersionsRef.current.has(item.id)) continue;
      requestedVersionsRef.current.add(item.id);
      postToHost({ type: 'fetchBackendVersions', payload: { id: item.id } });
    }
  }, [backends.items, nodeEnv]);

  const refreshAll = () => {
    requestedVersionsRef.current.clear();
    postToHost({ type: 'checkBackendEnv', payload: {} });
    if (nodeEnv?.hasNpm) {
      for (const item of backends.items) {
        if (item.npmPackage) {
          requestedVersionsRef.current.add(item.id);
          postToHost({ type: 'fetchBackendVersions', payload: { id: item.id } });
        }
      }
    }
  };

  const openAdd = () => {
    setFormError(undefined);
    setForm(emptyForm());
  };

  const openEdit = (backend: BackendView) => {
    setFormError(undefined);
    setForm(formFromBackend(backend));
  };

  const closeForm = () => {
    setForm(undefined);
    setFormError(undefined);
  };

  const submitForm = () => {
    if (!form) return;
    const name = form.name.trim();
    const command = form.command.trim();
    if (!name || !command) {
      setFormError(t('settings.agents.form.validation'));
      return;
    }
    const rawId = (form.id.trim() || name).toLowerCase().replace(/[^a-z0-9._-]+/gu, '-');
    const id = rawId === 'dsh' || rawId === 'zcode' ? `${rawId}-acp` : rawId || 'custom-agent';
    const args = form.argsText
      .split(/\s+/u)
      .map((s) => s.trim())
      .filter(Boolean);
    const env = parseEnvText(form.envText);
    postToHost({
      type: 'upsertBackendProfile',
      payload: {
        id,
        name,
        command,
        args,
        env,
        ...(form.installHint.trim() ? { installHint: form.installHint.trim() } : {}),
        ...(form.singleSession ? { singleSession: true } : {}),
      },
    });
    setForm(undefined);
    setFormError(undefined);
  };

  return (
    <section className="flex flex-col overflow-hidden rounded-card bg-surface shadow-card" data-testid="settings-backends">
      <div className="primitive-card-bar flex items-center justify-between gap-2 border-b border-line bg-inset/50">
        <div className="min-w-0">
          <h3 className="m-0 text-[13px] font-semibold text-ink">{t('settings.backends')}</h3>
          <p className="mt-0.5 mb-0 text-[11.5px] text-ink-3">{t('settings.backendsHint')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button type="button" variant="outline" size="xs" data-testid="agent-add-btn" onClick={openAdd}>
            <PlusIcon className="size-3" />
            <span>{t('settings.agents.add')}</span>
          </Button>
          <Button type="button" variant="ghost" size="icon-xs" data-testid="settings-refresh-env" title={t('settings.refresh')} aria-label={t('settings.refresh')} onClick={refreshAll}>
            <RefreshIcon className="size-3.5 text-ink-2" />
          </Button>
        </div>
      </div>

      <div className="primitive-card-pad flex flex-col gap-2.5">
        <NodeEnvBanner nodeEnv={nodeEnv} />

        <Dialog open={Boolean(form)} onOpenChange={(open) => !open && closeForm()}>
          {form ? (
            <DialogContent data-testid="agent-form" aria-modal="true" className="sm:max-w-[520px]">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-[14px]">
                  <AgentIcon className="size-4 text-accent-ink" />
                  <span>
                    {form.isNew
                      ? t('settings.agents.form.addTitle')
                      : t('settings.agents.form.editTitle', form.name || form.id)}
                  </span>
                </DialogTitle>
                <DialogDescription className="sr-only">{t('settings.backendsHint')}</DialogDescription>
              </DialogHeader>

              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-[12px] font-medium text-ink-2">{t('settings.agents.form.name')}</span>
                    <Input
                      size="sm"
                      data-testid="agent-form-name"
                      value={form.name}
                      placeholder={t('settings.agents.form.namePlaceholder')}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-[12px] font-medium text-ink-2">{t('settings.agents.form.id')}</span>
                    <Input
                      size="sm"
                      data-testid="agent-form-id"
                      disabled={!form.isNew}
                      className="font-mono text-[12px]"
                      value={form.id}
                      placeholder={t('settings.agents.form.idPlaceholder')}
                      onChange={(e) => setForm({ ...form, id: e.target.value })}
                    />
                  </label>
                </div>

                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-[12px] font-medium text-ink-2">{t('settings.agents.form.command')}</span>
                    <Input
                      size="sm"
                      data-testid="agent-form-command"
                      className="font-mono text-[12px]"
                      value={form.command}
                      placeholder={t('settings.agents.form.commandPlaceholder')}
                      onChange={(e) => setForm({ ...form, command: e.target.value })}
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-[12px] font-medium text-ink-2">{t('settings.agents.form.args')}</span>
                    <Input
                      size="sm"
                      data-testid="agent-form-args"
                      className="font-mono text-[12px]"
                      value={form.argsText}
                      placeholder={t('settings.agents.form.argsPlaceholder')}
                      onChange={(e) => setForm({ ...form, argsText: e.target.value })}
                    />
                  </label>
                </div>

                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-ink-2">{t('settings.agents.form.env')}</span>
                  <Textarea
                    data-testid="agent-form-env"
                    rows={2}
                    className="py-1.5 font-mono text-[12px]"
                    value={form.envText}
                    placeholder={t('settings.agents.form.envPlaceholder')}
                    onChange={(e) => setForm({ ...form, envText: e.target.value })}
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-ink-2">{t('settings.agents.form.installHint')}</span>
                  <Input
                    size="sm"
                    data-testid="agent-form-install-hint"
                    className="text-[12px]"
                    value={form.installHint}
                    placeholder={t('settings.agents.form.installHintPlaceholder')}
                    onChange={(e) => setForm({ ...form, installHint: e.target.value })}
                  />
                </label>

                <div className="flex items-center justify-between gap-3 rounded-control border border-line bg-field/60 px-3 py-2">
                  <span className="flex flex-col text-[12px]">
                    <span className="font-medium text-ink">{t('settings.agents.form.singleSession')}</span>
                    <span className="text-[11px] text-ink-3">{t('settings.agents.form.singleSessionHint')}</span>
                  </span>
                  <Switch
                    data-testid="agent-form-single-session"
                    aria-label={t('settings.agents.form.singleSession')}
                    checked={form.singleSession}
                    onCheckedChange={(checked) => setForm({ ...form, singleSession: checked })}
                  />
                </div>

                {formError ? (
                  <div className="text-[11.5px] text-red" role="alert">
                    {formError}
                  </div>
                ) : null}
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" size="sm" data-testid="agent-form-cancel" onClick={closeForm}>
                  {t('common.cancel')}
                </Button>
                <Button type="button" size="sm" data-testid="agent-form-save" onClick={submitForm}>
                  {t('settings.agents.form.save')}
                </Button>
              </DialogFooter>
            </DialogContent>
          ) : null}
        </Dialog>

        <div className="flex flex-col gap-2">
          {backends.items.map((backend) => (
            <BackendCard
              key={backend.id}
              backend={backend}
              active={backend.id === backends.active}
              isDefault={backend.id === (backends.defaultBackend ?? backends.active)}
              nodeEnv={nodeEnv}
              boundProvider={providers.find(
                (p) =>
                  p.boundBackendIds.includes(backend.id) ||
                  (backend.id === 'pi' && p.boundBackendIds.includes('oh-my-pi')),
              )}
              onEdit={() => openEdit(backend)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
