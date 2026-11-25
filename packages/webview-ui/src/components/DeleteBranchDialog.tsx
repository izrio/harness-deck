/**
 * 删除本地 Git 分支的二次确认弹窗：
 * 由输入框底栏分支切换器（ComposerFooter）与 Git 改动面板（ChangesView）共用。
 */
import { useEffect, useState } from 'react';
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
import { useT } from '../i18n.ts';
import { TrashIcon } from './icons.tsx';

export interface DeleteBranchDialogProps {
  readonly branch: string | null;
  readonly busy?: boolean;
  readonly testIdPrefix: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: (branch: string, force: boolean) => void;
}

export function DeleteBranchDialog({
  branch,
  busy = false,
  testIdPrefix,
  onOpenChange,
  onConfirm,
}: DeleteBranchDialogProps) {
  const t = useT();
  const [force, setForce] = useState(false);

  useEffect(() => {
    setForce(false);
  }, [branch]);

  return (
    <Dialog open={Boolean(branch)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid={`${testIdPrefix}-dialog`}>
        <DialogHeader>
          <DialogTitle>{t('wb.changes.deleteBranchConfirmTitle')}</DialogTitle>
          <DialogDescription>
            {t('wb.changes.deleteBranchConfirmDesc', branch ?? '')}
          </DialogDescription>
        </DialogHeader>
        <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-ink-2">
          <Checkbox
            checked={force}
            disabled={busy}
            data-testid={`${testIdPrefix}-force`}
            onCheckedChange={(checked) => setForce(checked === true)}
          />
          <span>{t('wb.changes.deleteBranchForce')}</span>
        </label>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            data-testid={`${testIdPrefix}-cancel`}
            onClick={() => onOpenChange(false)}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={busy || !branch}
            data-testid={`${testIdPrefix}-confirm`}
            onClick={() => {
              if (branch) onConfirm(branch, force);
            }}
          >
            <TrashIcon className="size-3.5" />
            <span>{t('wb.changes.deleteBranch')}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
