/** 权限预设（Beautiful UI GlideMenu 浮层）：两行展示完整说明 + 按权限语义区分图标。 */
import { useCallback, useState } from 'react';
import { useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { cn } from '../lib/utils.ts';
import { GlideMenu } from './beautifului/index.ts';
import {
  CheckIcon,
  ChevronDownIcon,
  ClipboardListIcon,
  FileEditIcon,
  LockIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldIcon,
  ZapIcon,
} from './icons.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useT, type Translate } from '../i18n.ts';

const KNOWN = ['read-only', 'workspace-write', 'danger-full-access'] as const;
type Known = (typeof KNOWN)[number];
const isKnown = (preset: string): preset is Known => (KNOWN as readonly string[]).includes(preset);

export type PermissionKind = 'read-only' | 'plan' | 'danger' | 'edit' | 'auto' | 'default' | 'unknown';

/** 将不同底层的权限预设 ID / 显示名归类为统一语义，用于图标、警告态与兜底说明。 */
export function classifyPermission(preset?: string, name?: string): PermissionKind {
  const id = (preset ?? '').trim();
  const label = (name ?? '').trim();
  const idChecks: readonly (readonly [PermissionKind, RegExp])[] = [
    ['read-only', /^(?:read[-_ ]?only|readonly)$/iu],
    ['plan', /^(?:plan|plan[-_ ]?mode|architect)$/iu],
    ['danger', /^(?:danger[-_ ]?full[-_ ]?access|bypass[-_ ]?permissions?|bypass|yolo|dont[-_ ]?ask|full[-_ ]?access|unrestricted|always[-_ ]?allow)$/iu],
    ['edit', /^(?:workspace[-_ ]?write|accept[-_ ]?edits?|edit|build|code)$/iu],
    ['auto', /^(?:auto|full[-_ ]?auto|smart|agent)$/iu],
    ['default', /^(?:default|ask|manual|prompt|normal|standard)$/iu],
  ];
  for (const [kind, pattern] of idChecks) {
    if (id && pattern.test(id)) return kind;
  }
  const combined = `${id} ${label}`.trim();
  if (!combined) return 'unknown';
  if (/只读|\bread[-_ ]?only\b/iu.test(combined)) return 'read-only';
  if (/计划模式|\bplan\b/iu.test(combined)) return 'plan';
  if (/完全访问|全放行|跳过所有确认|无沙箱|\byolo\b|\bbypass\b|\bfull[-_ ]?access\b|\bdont[-_ ]?ask\b/iu.test(combined)) return 'danger';
  if (/工作区可写|接受文件修改|开发模式|\baccept[-_ ]?edits?\b|\bworkspace[-_ ]?write\b|\bbuild\b/iu.test(combined)) return 'edit';
  if (/自动审批|智能放行|标准开发|\bauto\b/iu.test(combined)) return 'auto';
  if (/默认|需要时询问|\bdefault\b|\bask\b|\bmanual\b/iu.test(combined)) return 'default';
  return 'unknown';
}

export const permissionName = (preset: string, t: Translate): string => (isKnown(preset) ? t(`permission.${preset}`) : preset);

function permissionHint(preset: string, name: string | undefined, t: Translate): string | undefined {
  if (isKnown(preset)) return t(`permission.${preset}.hint`);
  switch (classifyPermission(preset, name)) {
    case 'read-only':
      return t('permission.read-only.hint');
    case 'plan':
      return t('permission.hint.plan');
    case 'danger':
      return t('permission.hint.danger');
    case 'edit':
      return t('permission.hint.edit');
    case 'auto':
      return t('permission.hint.auto');
    case 'default':
      return t('permission.hint.default');
    default:
      return undefined;
  }
}

function PresetIcon({ preset, name }: { readonly preset: string | undefined; readonly name?: string | undefined }) {
  const kind = classifyPermission(preset, name);
  switch (kind) {
    case 'read-only':
      return <LockIcon className="size-3.5 shrink-0" data-permission-icon="read-only" />;
    case 'plan':
      return <ClipboardListIcon className="size-3.5 shrink-0" data-permission-icon="plan" />;
    case 'danger':
      return <ShieldAlertIcon className="size-3.5 shrink-0" data-permission-icon="danger" />;
    case 'edit':
      return <FileEditIcon className="size-3.5 shrink-0" data-permission-icon="edit" />;
    case 'auto':
      return <ZapIcon className="size-3.5 shrink-0" data-permission-icon="auto" />;
    case 'default':
      return <ShieldCheckIcon className="size-3.5 shrink-0" data-permission-icon="default" />;
    default:
      return <ShieldIcon className="size-3.5 shrink-0" data-permission-icon="unknown" />;
  }
}

export interface PermissionPickerProps {
  readonly disabled: boolean;
  /** 受控模式：用于新建任务弹窗等独立场景，选中后回传而非改写全局会话权限。 */
  readonly value?: string | undefined;
  readonly options?: readonly string[];
  readonly labels?: Readonly<Record<string, { readonly name: string; readonly description?: string }>>;
  readonly onSelect?: (preset: string) => void;
  readonly testId?: string;
}

export function PermissionPicker({
  disabled,
  value,
  options: controlledOptions,
  labels: controlledLabels,
  onSelect: onControlledSelect,
  testId = 'permission-picker',
}: PermissionPickerProps) {
  const storePermissions = useView((s) => s.permissions);
  const clientSurface = useView((s) => s.clientSurface);
  const [open, setOpen] = useState(false);
  const [confirmPreset, setConfirmPreset] = useState<{ readonly preset: string; readonly label: string } | undefined>();
  const close = useCallback(() => setOpen(false), []);
  const t = useT();
  const isControlled = onControlledSelect !== undefined;
  const options = controlledOptions ?? storePermissions.options;
  const labels = controlledLabels ?? storePermissions.labels;
  if (options.length === 0) return null;
  const current = isControlled ? value : storePermissions.current;
  const currentLabel = current ? (labels?.[current]?.name ?? permissionName(current, t)) : t('permission.label');
  const danger = classifyPermission(current, labels?.[current ?? '']?.name) === 'danger';
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
            title={current ? t('permission.title', currentLabel) : t('permission.label')}
            data-testid={testId}
          >
            <PresetIcon preset={current} name={labels?.[current ?? '']?.name} />
            <span className="toolbar-button__text permission-picker__text min-w-0 truncate">{currentLabel}</span>
            <ChevronDownIcon className="size-3 shrink-0 text-ink-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={6}
          aria-label={t('permission.select')}
          className="model-menu permission-menu max-h-80 w-[304px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-xl p-1 shadow-overlay"
        >
          <div role="menu">
            <GlideMenu className="flex flex-col gap-0.5" highlightClassName="inset-x-0 rounded-[8px] bg-hover">
              {options.map((preset) => {
                const active = preset === current;
                const labelInfo = labels?.[preset];
                const label = labelInfo?.name ?? permissionName(preset, t);
                const description = labelInfo?.description ?? permissionHint(preset, labelInfo?.name, t);
                const itemDanger = classifyPermission(preset, labelInfo?.name) === 'danger';
                return (
                  <button
                    key={preset}
                    type="button"
                    role="menuitem"
                    data-menu-row
                    aria-current={active ? 'true' : undefined}
                    className={cn(
                      'menu-item permission-menu__item relative z-10 flex w-full items-start gap-2.5 rounded-[8px] px-2.5 py-2 text-left transition-colors duration-100',
                      active
                        ? 'menu-item--active bg-field text-ink group-hover/glide-menu:bg-transparent'
                        : 'text-ink',
                    )}
                    onClick={() => {
                      close();
                      if (preset === current) return;
                      if (onControlledSelect) {
                        onControlledSelect(preset);
                        return;
                      }
                      if (clientSurface === 'mobile-web' && itemDanger) {
                        setConfirmPreset({ preset, label });
                        return;
                      }
                      postToHost({ type: 'selectPermission', payload: { preset } });
                    }}
                  >
                    <span
                      className={cn(
                        'mt-[2px] inline-flex shrink-0',
                        itemDanger ? 'text-orange' : active ? 'text-accent-ink' : 'text-ink-3',
                      )}
                    >
                      <PresetIcon preset={preset} name={labelInfo?.name} />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-center gap-1.5">
                        <span className={cn('menu-item__label text-[12.5px] leading-snug font-medium', itemDanger && 'text-orange')}>
                          {label}
                        </span>
                        {active ? <CheckIcon className="ml-auto size-3.5 shrink-0 text-accent-ink" strokeWidth={2.2} /> : null}
                      </span>
                      {description ? (
                        <span className="menu-item__hint text-[11.5px] leading-[1.4] whitespace-normal text-ink-3">
                          {description}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </GlideMenu>
          </div>
        </PopoverContent>
      </Popover>
      <Dialog open={confirmPreset !== undefined} onOpenChange={(next) => !next && setConfirmPreset(undefined)}>
        <DialogContent data-testid="mobile-danger-permission-dialog">
          <DialogHeader>
            <DialogTitle>{t('mobile.confirm.dangerTitle')}</DialogTitle>
            <DialogDescription>
              {t('mobile.confirm.dangerDetail', confirmPreset?.label ?? '')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setConfirmPreset(undefined)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              data-testid="mobile-danger-permission-confirm"
              onClick={() => {
                if (!confirmPreset) return;
                postToHost({ type: 'selectPermission', payload: { preset: confirmPreset.preset, confirmed: true } });
                setConfirmPreset(undefined);
              }}
            >
              {t('mobile.confirm.dangerAllow')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
