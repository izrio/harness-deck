/**
 * 工作台 · 改动模块（ChangesView）
 *
 * 只读展示当前工作区的 Git 分支、远程与未提交改动；提交、推送、创建 PR 都是显式动作。
 * 推送与创建 PR 均需二次确认，不做 force push，不切换分支，不保存任何 token（HD-09 / HD-10）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { deriveTurns } from '@harness-deck/shared';
import type { MessageKey } from '../../i18n.ts';
import { useT } from '../../i18n.ts';
import { useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import { FileIcon, GitBranchIcon, RefreshIcon } from '../icons.tsx';
import { ValuePill } from '../beautifului/index.ts';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

function post(message: Parameters<typeof postToHost>[0]): void {
  postToHost(message);
}

export function ChangesView({ compact = false }: { readonly compact?: boolean } = {}) {
  const t = useT();
  const state = useView((s) => s.workbench.sourceControl);
  const session = useView((s) => s.session);
  const items = useView((s) => s.items);
  const remoteReadOnly = useView((s) => s.clientSurface === 'mobile-web' && s.clientScope === 'read-only');
  const [commitMessage, setCommitMessage] = useState('');
  const [stageAll, setStageAll] = useState(true);
  const [sessionOnly, setSessionOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);
  const [prOpen, setPrOpen] = useState(false);
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  const lastActionAtRef = useRef<number | undefined>(undefined);

  const sessionPaths = useMemo(() => {
    const turns = session.turns ?? deriveTurns(items, session.running);
    const set = new Set<string>();
    for (const turn of turns) {
      for (const path of turn.authoredPaths) set.add(path.replace(/\\/gu, '/'));
    }
    return set;
  }, [session.turns, items, session.running]);

  const refresh = (): void => {
    setBusy(true);
    post({ type: 'refreshSourceControl', payload: {} });
  };

  useEffect(() => {
    refresh();
  }, []);

  // 宿主每次刷新（含 commit / push / pr 完成或失败）都会更新 updatedAt：解除本地忙碌状态，并根据 lastAction 决定清空或保留草稿。
  useEffect(() => {
    setBusy(false);
    const action = state?.lastAction;
    if (!action || action.at === lastActionAtRef.current) return;
    lastActionAtRef.current = action.at;
    if (action.kind === 'commit' && action.ok) {
      setCommitMessage('');
    } else if (action.kind === 'pr' && action.ok) {
      setPrOpen(false);
      setPrTitle('');
      setPrBody('');
    }
  }, [state?.updatedAt, state?.lastAction]);

  const hasStaged = Boolean(state?.files.some((file) => file.staged));
  const hasUnstaged = Boolean(state?.files.some((file) => !file.staged));
  const showStageToggle = hasStaged && hasUnstaged;

  const visibleFiles = useMemo(() => {
    const files = state?.files ?? [];
    if (!sessionOnly || sessionPaths.size === 0) return files;
    return files.filter((file) => {
      const normalized = file.path.replace(/\\/gu, '/');
      for (const authored of sessionPaths) {
        if (normalized === authored || normalized.endsWith(`/${authored}`) || authored.endsWith(`/${normalized}`)) {
          return true;
        }
      }
      return false;
    });
  }, [state?.files, sessionOnly, sessionPaths]);

  const commit = (): void => {
    if (!commitMessage.trim()) return;
    setBusy(true);
    post({
      type: 'sourceControlCommit',
      payload: { message: commitMessage.trim(), stageAll: showStageToggle ? stageAll : true },
    });
  };

  const confirmPush = (): void => {
    setPushOpen(false);
    setBusy(true);
    post({ type: 'sourceControlPush', payload: {} });
  };

  const openPr = (): void => {
    // 保留未提交成功时的草稿；仅当标题为空时填充默认建议
    if (!prTitle.trim()) {
      setPrTitle(commitMessage.trim().split('\n')[0] || session.title || state?.branch || '');
    }
    setPrOpen(true);
  };

  const createPr = (): void => {
    if (!prTitle.trim()) return;
    setBusy(true);
    // 失败时弹窗保持打开并保留草稿；成功后由 lastAction 统一关闭并清空
    post({ type: 'sourceControlCreatePr', payload: { title: prTitle.trim(), body: prBody } });
  };

  return (
    <div
      className={compact ? 'flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2.5' : 'flex min-h-0 flex-1 flex-col overflow-y-auto px-3.5 py-3'}
      data-testid="workbench-changes"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className={compact ? 'm-0 text-[13px] font-semibold tracking-tight text-ink' : 'm-0 text-[15px] font-semibold tracking-tight text-ink'}>
            {t('wb.changes.title')}
          </h2>
          {!compact ? <p className="mt-0.5 mb-0 text-[12px] text-ink-3">{t('wb.changes.subtitle')}</p> : null}
        </div>
        <Button type="button" variant="outline" size="xs" onClick={refresh} disabled={busy}>
          <RefreshIcon className="size-3" />
          <span>{t('wb.changes.refresh')}</span>
        </Button>
      </div>

      {!state ? (
        <div className="mt-3 rounded-card bg-surface px-3 py-4 text-[12.5px] text-ink-3 shadow-card">
          {t('wb.changes.refreshing')}
        </div>
      ) : !state.available ? (
        <div className="mt-3 rounded-card bg-surface px-3 py-4 text-[12.5px] text-ink-3 shadow-card">
          {state.error ? t('wb.changes.error', state.error) : t('wb.changes.notRepo')}
        </div>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-ink-2">
            <span title={`${t('wb.changes.branch')}: ${state.branch ?? 'HEAD'}`}>
              <ValuePill tone="accent">
                <GitBranchIcon className="size-2.5" />
                <span>{state.branch ?? 'HEAD'}</span>
              </ValuePill>
            </span>
            {state.remote ? (
              <span
                className="max-w-full truncate font-mono text-[11.5px] text-ink-3"
                title={`${t('wb.changes.remote')}: ${state.remote}`}
              >
                {state.remote}
              </span>
            ) : null}
            <span className="text-ink-3">{t('wb.changes.summary', visibleFiles.length, state.additions, state.deletions)}</span>
            {state.gh ? (
              <ValuePill tone={state.gh.authenticated ? 'green' : 'orange'}>
                {state.gh.authenticated
                  ? t('wb.changes.ghReady')
                  : state.gh.installed
                    ? t('wb.changes.ghLoginNeeded')
                    : t('wb.changes.ghMissing')}
              </ValuePill>
            ) : null}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Input
              size="sm"
              className="min-w-40 flex-1"
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              placeholder={t('wb.changes.commitPlaceholder')}
              aria-label={t('wb.changes.commitPlaceholder')}
              disabled={busy || remoteReadOnly || state.files.length === 0}
            />
            <Button type="button" size="sm" onClick={commit} disabled={busy || remoteReadOnly || !commitMessage.trim() || state.files.length === 0}>
              {t('wb.changes.commit')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="changes-push-btn"
              onClick={() => setPushOpen(true)}
              disabled={busy || remoteReadOnly || !state.remote}
            >
              {t('wb.changes.push')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="changes-pr-btn"
              onClick={openPr}
              disabled={busy || remoteReadOnly || !state.remote}
            >
              {t('wb.changes.createPr')}
            </Button>
          </div>

          {showStageToggle || sessionPaths.size > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-3 text-[11.5px] text-ink-2">
              {showStageToggle ? (
                <label className="flex cursor-pointer items-center gap-1.5">
                  <Checkbox checked={stageAll} onCheckedChange={(checked) => setStageAll(checked === true)} />
                  <span>{t('wb.changes.stageAll')}</span>
                </label>
              ) : null}
              {sessionPaths.size > 0 ? (
                <label className="flex cursor-pointer items-center gap-1.5">
                  <Checkbox
                    data-testid="changes-session-filter"
                    checked={sessionOnly}
                    onCheckedChange={(checked) => setSessionOnly(checked === true)}
                  />
                  <span>{t('wb.changes.sessionOnly', sessionPaths.size)}</span>
                </label>
              ) : null}
            </div>
          ) : null}

          {visibleFiles.length === 0 ? (
            <div className="mt-3 rounded-card bg-surface px-3 py-4 text-[12.5px] text-ink-3 shadow-card">
              {t('wb.changes.empty')}
            </div>
          ) : (
            <div className="mt-2 flex flex-col overflow-hidden rounded-card bg-surface shadow-card">
              {visibleFiles.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  className="flex w-full items-center gap-2.5 border-b border-line/60 px-2.5 py-2 text-left last:border-b-0 hover:bg-hover"
                  onClick={() => post({ type: 'openSourceControlDiff', payload: { path: file.path, staged: file.staged } })}
                  title={file.path}
                >
                  <FileIcon className="size-3.5 shrink-0 text-ink-3" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">{file.path}</span>
                  <span className="shrink-0 text-[11px] text-ink-3">
                    {file.staged ? t('wb.changes.staged') : t('wb.changes.unstaged')}
                  </span>
                  {file.additions !== undefined ? <span className="shrink-0 text-[11.5px] text-green">+{file.additions}</span> : null}
                  {file.deletions !== undefined ? <span className="shrink-0 text-[11.5px] text-red">−{file.deletions}</span> : null}
                  <ValuePill tone={file.status === 'conflicted' ? 'orange' : 'neutral'}>
                    {t(`wb.changes.status.${file.status}` as MessageKey)}
                  </ValuePill>
                </button>
              ))}
            </div>
          )}

          {state.truncated ? (
            <p className="mt-2 mb-0 text-[11.5px] text-ink-3">{t('wb.changes.truncated', 500)}</p>
          ) : null}
          {state.error ? <p className="mt-2 mb-0 text-[11.5px] text-red">{t('wb.changes.error', state.error)}</p> : null}
        </>
      )}

      <Dialog open={pushOpen} onOpenChange={setPushOpen}>
        <DialogContent data-testid="changes-push-dialog">
          <DialogHeader>
            <DialogTitle>{t('wb.changes.pushConfirmTitle')}</DialogTitle>
            <DialogDescription>
              {t('wb.changes.pushConfirmDetail', state?.branch ?? 'HEAD', state?.remote ?? 'origin')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setPushOpen(false)}>
              {t('wb.changes.cancel')}
            </Button>
            <Button type="button" size="sm" data-testid="changes-push-confirm" onClick={confirmPush}>
              {t('wb.changes.push')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={prOpen} onOpenChange={setPrOpen}>
        <DialogContent data-testid="changes-pr-dialog">
          <DialogHeader>
            <DialogTitle>{t('wb.changes.prTitle')}</DialogTitle>
            <DialogDescription>{t('wb.changes.prHint')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="pr-title">{t('wb.changes.prTitleLabel')}</Label>
            <Input id="pr-title" size="sm" value={prTitle} onChange={(event) => setPrTitle(event.target.value)} disabled={busy} />
            <Label htmlFor="pr-body">{t('wb.changes.prBodyLabel')}</Label>
            <Textarea id="pr-body" value={prBody} onChange={(event) => setPrBody(event.target.value)} rows={5} disabled={busy} />
            {state?.lastAction?.kind === 'pr' && !state.lastAction.ok && state.lastAction.message ? (
              <p className="m-0 text-[11.5px] text-red">{state.lastAction.message}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setPrOpen(false)} disabled={busy}>
              {t('wb.changes.cancel')}
            </Button>
            <Button type="button" size="sm" data-testid="changes-pr-confirm" onClick={createPr} disabled={busy || !prTitle.trim()}>
              {t('wb.changes.confirmPr')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
