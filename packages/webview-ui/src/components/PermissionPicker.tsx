/** 权限预设（Beautiful UI GlideMenu 浮层）：只读 / 工作区可写 / 完全访问。 */
import { useCallback, useState } from 'react';
import { useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { cn } from '../lib/utils.ts';
import { GlideMenu, MenuItem } from './beautifului/index.ts';
import { ChevronDownIcon, LockIcon, PencilIcon, ShieldIcon, UnlockIcon } from './icons.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useT, type Translate } from '../i18n.ts';

const KNOWN = ['read-only', 'workspace-write', 'danger-full-access'] as const;
type Known = (typeof KNOWN)[number];
const isKnown = (preset: string): preset is Known => (KNOWN as readonly string[]).includes(preset);

export const permissionName = (preset: string, t: Translate): string => (isKnown(preset) ? t(`permission.${preset}`) : preset);
const permissionHint = (preset: string, t: Translate): string | undefined => (isKnown(preset) ? t(`permission.${preset}.hint`) : undefined);

function PresetIcon({ preset }: { preset: string | undefined }) {
  if (preset === 'read-only') return <LockIcon className="size-3.5 shrink-0" />;
  if (preset === 'workspace-write') return <PencilIcon className="size-3.5 shrink-0" />;
  if (preset === 'danger-full-access') return <UnlockIcon className="size-3.5 shrink-0" />;
  return <ShieldIcon className="size-3.5 shrink-0" />;
}

export function PermissionPicker({ disabled }: { disabled: boolean }) {
  const permissions = useView((s) => s.permissions);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const t = useT();
  if (permissions.options.length === 0) return null;
  const current = permissions.current;
  const danger = current === 'danger-full-access';
  return (
    <div className="model-picker relative min-w-0">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'toolbar-button inline-flex h-7 max-w-full items-center gap-1 rounded-[8px] px-1.5 text-[12px] font-medium transition-colors duration-150 hover:bg-hover disabled:cursor-default disabled:opacity-55',
              danger ? 'toolbar-button--danger text-orange hover:text-orange' : 'text-ink-2 hover:text-ink',
            )}
            disabled={disabled}
            title={current ? t('permission.title', permissions.labels?.[current]?.name ?? permissionName(current, t)) : t('permission.label')}
            data-testid="permission-picker"
          >
            <PresetIcon preset={current} />
            <span className="toolbar-button__text permission-picker__text min-w-0 truncate">
              {current ? (permissions.labels?.[current]?.name ?? permissionName(current, t)) : t('permission.label')}
            </span>
            <ChevronDownIcon className="size-3 shrink-0 text-ink-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={6}
          aria-label={t('permission.select')}
          className="model-menu permission-menu left-0 max-h-80 w-max min-w-[240px] max-w-[min(380px,calc(100vw-16px))] overflow-y-auto rounded-card p-1 shadow-raised"
        >
          <div role="menu">
            <GlideMenu className="flex flex-col gap-0.5" highlightClassName="inset-x-0 rounded-[6px] bg-hover">
              {permissions.options.map((preset) => (
                <MenuItem
                  key={preset}
                  active={preset === current}
                  icon={<PresetIcon preset={preset} />}
                  hint={permissions.labels?.[preset]?.description ?? permissionHint(preset, t)}
                  truncateHint
                  onSelect={() => {
                    close();
                    if (preset !== current) postToHost({ type: 'selectPermission', payload: { preset } });
                  }}
                >
                  {permissions.labels?.[preset]?.name ?? permissionName(preset, t)}
                </MenuItem>
              ))}
            </GlideMenu>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
