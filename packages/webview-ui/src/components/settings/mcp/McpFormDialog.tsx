import type { McpTransport } from '@harness-deck/shared';
import { CheckIcon, PlugIcon } from '../../icons.tsx';
import { BackendLogo } from '../../BackendLogo.tsx';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { McpFormState } from './mcpParsers.ts';
import type { BackendView } from '@harness-deck/shared';
import type { Dispatch, SetStateAction } from 'react';
import { useT } from '../../../i18n.ts';

export function McpFormDialog({ agents, form, setForm, formError, showJsonPaste, setShowJsonPaste, jsonText, setJsonText, closeForm, applyPastedJson, toggleFormAgent, submitForm }: { agents: readonly Pick<BackendView, 'id' | 'name'>[]; form: McpFormState | undefined; setForm: (form: McpFormState | undefined) => void; formError: string | undefined; showJsonPaste: boolean; setShowJsonPaste: Dispatch<SetStateAction<boolean>>; jsonText: string; setJsonText: (text: string) => void; closeForm: () => void; applyPastedJson: () => void; toggleFormAgent: (agentId: string) => void; submitForm: () => void }) {
  const t = useT();
  return (
    <Dialog open={Boolean(form)} onOpenChange={(open) => !open && closeForm()}>
      {form ? (
        <DialogContent data-testid="mcp-form-dialog" aria-modal="true" className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between gap-2 text-[14px]">
              <span className="flex min-w-0 items-center gap-2">
                <PlugIcon className="size-4 shrink-0 text-accent-ink" />
                <span className="truncate">
                  {form.id ? t('settings.mcp.form.editTitle', form.name) : t('settings.mcp.form.addTitle')}
                </span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                data-testid="mcp-paste-json-toggle"
                onClick={() => setShowJsonPaste((prev) => !prev)}
              >
                {t('settings.mcp.form.pasteJson')}
              </Button>
            </DialogTitle>
            <DialogDescription className="sr-only">{t('settings.mcp.desc')}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            {showJsonPaste ? (
              <div className="flex flex-col gap-2 rounded-control border border-line bg-field p-2.5">
                <Textarea
                  rows={3}
                  data-testid="mcp-paste-json-input"
                  className="font-mono text-[11.5px]"
                  value={jsonText}
                  placeholder={t('settings.mcp.form.pasteJsonPlaceholder')}
                  onChange={(e) => setJsonText(e.target.value)}
                />
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    data-testid="mcp-paste-json-apply"
                    onClick={applyPastedJson}
                  >
                    {t('settings.mcp.form.applyJson')}
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className="text-[12px] font-medium text-ink-2">{t('settings.mcp.form.name')}</span>
                <Input
                  size="sm"
                  data-testid="mcp-form-name"
                  className="font-mono text-[12px]"
                  value={form.name}
                  placeholder={t('settings.mcp.form.namePlaceholder')}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>

              <div className="flex flex-col gap-1">
                <span className="text-[12px] font-medium text-ink-2">{t('settings.mcp.form.transport')}</span>
                <Select
                  value={form.transport}
                  onValueChange={(value) => setForm({ ...form, transport: value as McpTransport })}
                >
                  <SelectTrigger
                    size="sm"
                    data-testid="mcp-form-transport"
                    aria-label={t('settings.mcp.form.transport')}
                    className="w-full text-[12px]"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stdio">{t('settings.mcp.form.transportStdio')}</SelectItem>
                    <SelectItem value="http">{t('settings.mcp.form.transportHttp')}</SelectItem>
                    <SelectItem value="sse">{t('settings.mcp.form.transportSse')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {form.transport === 'stdio' ? (
              <>
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-ink-2">{t('settings.mcp.form.command')}</span>
                  <Input
                    size="sm"
                    data-testid="mcp-form-command"
                    className="font-mono text-[12px]"
                    value={form.command}
                    placeholder={t('settings.mcp.form.commandPlaceholder')}
                    onChange={(e) => setForm({ ...form, command: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-ink-2">{t('settings.mcp.form.args')}</span>
                  <Input
                    size="sm"
                    data-testid="mcp-form-args"
                    className="font-mono text-[12px]"
                    value={form.argsText}
                    placeholder={t('settings.mcp.form.argsPlaceholder')}
                    onChange={(e) => setForm({ ...form, argsText: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-ink-2">{t('settings.mcp.form.env')}</span>
                  <Textarea
                    rows={3}
                    data-testid="mcp-form-env"
                    className="font-mono text-[11.5px]"
                    value={form.envText}
                    placeholder={t('settings.mcp.form.envPlaceholder')}
                    onChange={(e) => setForm({ ...form, envText: e.target.value })}
                  />
                </label>
              </>
            ) : (
              <>
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-ink-2">{t('settings.mcp.form.url')}</span>
                  <Input
                    size="sm"
                    data-testid="mcp-form-url"
                    className="font-mono text-[12px]"
                    value={form.url}
                    placeholder={t('settings.mcp.form.urlPlaceholder')}
                    onChange={(e) => setForm({ ...form, url: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-ink-2">{t('settings.mcp.form.headers')}</span>
                  <Textarea
                    rows={3}
                    data-testid="mcp-form-headers"
                    className="font-mono text-[11.5px]"
                    value={form.headersText}
                    placeholder={t('settings.mcp.form.headersPlaceholder')}
                    onChange={(e) => setForm({ ...form, headersText: e.target.value })}
                  />
                </label>
              </>
            )}

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-medium text-ink-2">{t('settings.mcp.form.agents')}</span>
                <div className="flex items-center gap-1.5 text-[11px]">
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    className="h-auto p-0 text-[11px] text-accent-ink"
                    onClick={() => setForm({ ...form, agents: agents.map((a) => a.id) })}
                  >
                    {t('settings.mcp.form.selectAllAgents')}
                  </Button>
                  <span className="text-ink-4">·</span>
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    className="h-auto p-0 text-[11px] text-ink-3"
                    onClick={() => setForm({ ...form, agents: [] })}
                  >
                    {t('settings.mcp.form.clearAgents')}
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {agents.map((agent) => {
                  const selected = form.agents.includes(agent.id);
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      data-testid={`mcp-form-agent-${agent.id}`}
                      onClick={() => toggleFormAgent(agent.id)}
                      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-chip border px-2.5 py-1 text-[11.5px] transition-colors ${
                        selected
                          ? 'border-brand bg-accent-tint font-medium text-accent-ink'
                          : 'border-line bg-field text-ink-2 hover:bg-hover'
                      }`}
                    >
                      <BackendLogo backend={agent} size="sm" />
                      <span>{agent.name}</span>
                      {selected ? <CheckIcon className="size-3" /> : null}
                    </button>
                  );
                })}
              </div>
            </div>

            {formError ? (
              <div className="text-[11.5px] text-red" role="alert" data-testid="mcp-form-error">
                {formError}
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" size="sm" data-testid="mcp-form-cancel" onClick={closeForm}>
              {t('common.cancel')}
            </Button>
            <Button type="button" size="sm" data-testid="mcp-form-save" onClick={submitForm}>
              {t('settings.mcp.form.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
