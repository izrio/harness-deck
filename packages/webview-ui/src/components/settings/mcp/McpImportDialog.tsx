import type { McpImportCandidate } from '@harness-deck/shared';
import { postToHost } from '../../../vscode.ts';
import { CheckIcon, DownloadIcon, FolderIcon, RefreshIcon, SpinnerIcon } from '../../icons.tsx';
import { BackendLogo } from '../../BackendLogo.tsx';
import { ValuePill } from '../../beautifului/index.ts';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { serverSummary } from './mcpParsers.ts';
import type { BackendView, ExtensionsState } from '@harness-deck/shared';
import { useT } from '../../../i18n.ts';

export function McpImportDialog({ agents, mcp, importOpen, setImportOpen, selectedCandidateKeys, setSelectedCandidateKeys, importAgents, toggleCandidate, toggleImportAgent, candidates, selectedCandidates, submitImport }: { agents: readonly Pick<BackendView, 'id' | 'name'>[]; mcp: ExtensionsState['mcp']; importOpen: boolean; setImportOpen: (open: boolean) => void; selectedCandidateKeys: readonly string[]; setSelectedCandidateKeys: (keys: string[]) => void; importAgents: readonly string[]; toggleCandidate: (key: string) => void; toggleImportAgent: (agentId: string) => void; candidates: readonly McpImportCandidate[]; selectedCandidates: readonly McpImportCandidate[]; submitImport: () => void }) {
  const t = useT();
  return (
    <Dialog open={importOpen} onOpenChange={(open) => !open && setImportOpen(false)}>
      {importOpen ? (
        <DialogContent data-testid="mcp-import-dialog" aria-modal="true" className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[14px]">
              <DownloadIcon className="size-4 text-accent-ink" />
              <span>{t('settings.mcp.import.title')}</span>
            </DialogTitle>
            <DialogDescription className="sr-only">{t('settings.mcp.import.desc')}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11.5px] text-ink-3">
                {mcp.scanningImport
                  ? t('settings.mcp.import.scanning')
                  : candidates.length > 0
                    ? t('settings.mcp.import.foundCount', mcp.scannedSources?.length ?? 1, candidates.length)
                    : ''}
              </span>
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={Boolean(mcp.scanningImport)}
                  data-testid="mcp-import-rescan"
                  onClick={() => postToHost({ type: 'scanAgentMcpConfigs', payload: {} })}
                >
                  {mcp.scanningImport ? <SpinnerIcon className="size-3" /> : <RefreshIcon className="size-3" />}
                  <span>{t('settings.mcp.import.rescan')}</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="mcp-import-pick-file"
                  onClick={() => postToHost({ type: 'pickMcpConfigFile', payload: {} })}
                >
                  <FolderIcon className="size-3" />
                  <span>{t('settings.mcp.import.pickFile')}</span>
                </Button>
              </div>
            </div>

            {mcp.scanningImport ? (
              <div className="flex items-center justify-center gap-2 rounded-control bg-field py-6 text-[12px] text-ink-3">
                <SpinnerIcon className="size-4" />
                <span>{t('settings.mcp.import.scanning')}</span>
              </div>
            ) : candidates.length === 0 ? (
              <div
                className="rounded-xl bg-field/60 px-3 py-6 text-center text-[12px] text-ink-3"
                data-testid="mcp-import-empty"
              >
                {t('settings.mcp.import.empty')}
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <div className="flex justify-end gap-1.5 text-[11px]">
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    className="h-auto p-0 text-[11px] text-accent-ink"
                    onClick={() => setSelectedCandidateKeys(candidates.map((c) => c.key))}
                  >
                    {t('settings.skills.dialog.selectAll')}
                  </Button>
                  <span className="text-ink-4">·</span>
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    className="h-auto p-0 text-[11px] text-ink-3"
                    onClick={() => setSelectedCandidateKeys([])}
                  >
                    {t('settings.skills.dialog.selectNone')}
                  </Button>
                </div>

                <div
                  className="flex max-h-56 flex-col gap-1.5 overflow-y-auto rounded-xl bg-field/55 p-2"
                  data-testid="mcp-import-candidates"
                >
                  {candidates.map((item) => {
                    const checked = selectedCandidateKeys.includes(item.key);
                    return (
                      <label
                        key={item.key}
                        className="flex cursor-pointer items-start gap-2 rounded-lg bg-canvas/85 px-2.5 py-2 transition-colors hover:bg-canvas dark:bg-page/55"
                        data-testid={`mcp-candidate-${item.name}`}
                      >
                        <Checkbox
                          data-testid={`mcp-candidate-check-${item.name}`}
                          className="mt-0.5"
                          checked={checked}
                          onCheckedChange={() => toggleCandidate(item.key)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono text-[12px] font-semibold text-ink">{item.name}</span>
                            <ValuePill className="font-mono text-[10px] uppercase">{item.transport}</ValuePill>
                            <ValuePill tone="accent" className="text-[10px]">
                              {item.sourceAgentName}
                            </ValuePill>
                            {item.conflict ? (
                              <ValuePill className="text-[10px] text-ink-3">
                                {t('settings.mcp.import.existsBadge')}
                              </ValuePill>
                            ) : null}
                          </div>
                          <div className="mt-0.5 truncate font-mono text-[11px] text-ink-2">
                            {serverSummary(item)}
                          </div>
                          <div className="truncate font-mono text-[10.5px] text-ink-4" title={item.sourcePath}>
                            {item.sourcePath}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-ink-2">{t('settings.mcp.import.targetAgents')}</span>
              <div className="flex flex-wrap items-center gap-1.5">
                {agents.map((agent) => {
                  const selected = importAgents.includes(agent.id);
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      data-testid={`mcp-import-agent-${agent.id}`}
                      onClick={() => toggleImportAgent(agent.id)}
                      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11.5px] transition-colors ${
                        selected
                          ? 'bg-accent-tint font-medium text-accent-ink'
                          : 'bg-field/60 text-ink-2 hover:bg-hover hover:text-ink'
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
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="mcp-import-cancel"
              onClick={() => setImportOpen(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={selectedCandidates.length === 0}
              data-testid="mcp-import-submit"
              onClick={submitImport}
            >
              {t('settings.mcp.import.submit', selectedCandidates.length)}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
