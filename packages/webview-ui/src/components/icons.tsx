/**
 * 离线 Iconify 图标层：所有业务图标统一通过 `@iconify/react/offline` 渲染，
 * 图标数据来自静态按需打包的 `@iconify-icons/*` 本地包，零网络请求，
 * 完全适配 VS Code / JetBrains 插件离线环境与严格 Webview CSP（`default-src 'none'`）。
 */
import { Icon, type IconProps as IconifyReactProps, type IconifyIcon } from '@iconify/react/offline';

import aLargeSmallIcon from '@iconify-icons/lucide/a-large-small';
import arrowDownIcon from '@iconify-icons/lucide/arrow-down';
import arrowLeftIcon from '@iconify-icons/lucide/arrow-left';
import arrowRightIcon from '@iconify-icons/lucide/arrow-right';
import arrowUpIcon from '@iconify-icons/lucide/arrow-up';
import bellIcon from '@iconify-icons/lucide/bell';
import bookOpenIcon from '@iconify-icons/lucide/book-open';
import botIcon from '@iconify-icons/lucide/bot';
import bugIcon from '@iconify-icons/lucide/bug';
import chartPieIcon from '@iconify-icons/lucide/chart-pie';
import checkIcon from '@iconify-icons/lucide/check';
import chevronDownIcon from '@iconify-icons/lucide/chevron-down';
import chevronRightIcon from '@iconify-icons/lucide/chevron-right';
import circleAlertIcon from '@iconify-icons/lucide/circle-alert';
import circleQuestionMarkIcon from '@iconify-icons/lucide/circle-question-mark';
import clipboardListIcon from '@iconify-icons/lucide/clipboard-list';
import clockIcon from '@iconify-icons/lucide/clock';
import codeXmlIcon from '@iconify-icons/lucide/code-xml';
import copyIcon from '@iconify-icons/lucide/copy';
import downloadIcon from '@iconify-icons/lucide/download';
import ellipsisIcon from '@iconify-icons/lucide/ellipsis';
import eyeIcon from '@iconify-icons/lucide/eye';
import fastForwardIcon from '@iconify-icons/lucide/fast-forward';
import fileDiffIcon from '@iconify-icons/lucide/file-diff';
import fileIcon from '@iconify-icons/lucide/file';
import filePenLineIcon from '@iconify-icons/lucide/file-pen-line';
import fileTextIcon from '@iconify-icons/lucide/file-text';
import filesIcon from '@iconify-icons/lucide/files';
import flaskConicalIcon from '@iconify-icons/lucide/flask-conical';
import folderIcon from '@iconify-icons/lucide/folder';
import folderOpenIcon from '@iconify-icons/lucide/folder-open';
import folderTreeIcon from '@iconify-icons/lucide/folder-tree';
import gaugeIcon from '@iconify-icons/lucide/gauge';
import gitBranchIcon from '@iconify-icons/lucide/git-branch';
import globeIcon from '@iconify-icons/lucide/globe';
import historyIcon from '@iconify-icons/lucide/history';
import imageIcon from '@iconify-icons/lucide/image';
import infoIcon from '@iconify-icons/lucide/info';
import kanbanIcon from '@iconify-icons/lucide/kanban';
import keyRoundIcon from '@iconify-icons/lucide/key-round';
import layoutGridIcon from '@iconify-icons/lucide/layout-grid';
import link2Icon from '@iconify-icons/lucide/link-2';
import listChecksIcon from '@iconify-icons/lucide/list-checks';
import listIcon from '@iconify-icons/lucide/list';
import loaderCircleIcon from '@iconify-icons/lucide/loader-circle';
import lockIcon from '@iconify-icons/lucide/lock';
import lockOpenIcon from '@iconify-icons/lucide/lock-open';
import logOutIcon from '@iconify-icons/lucide/log-out';
import maximize2Icon from '@iconify-icons/lucide/maximize-2';
import messageSquareIcon from '@iconify-icons/lucide/message-square';
import monitorIcon from '@iconify-icons/lucide/monitor';
import moonIcon from '@iconify-icons/lucide/moon';
import paletteIcon from '@iconify-icons/lucide/palette';
import panelLeftIcon from '@iconify-icons/lucide/panel-left';
import panelRightIcon from '@iconify-icons/lucide/panel-right';
import paperclipIcon from '@iconify-icons/lucide/paperclip';
import pencilIcon from '@iconify-icons/lucide/pencil';
import playIcon from '@iconify-icons/lucide/play';
import plugIcon from '@iconify-icons/lucide/plug';
import plusIcon from '@iconify-icons/lucide/plus';
import puzzleIcon from '@iconify-icons/lucide/puzzle';
import qrCodeIcon from '@iconify-icons/lucide/qr-code';
import refreshCwIcon from '@iconify-icons/lucide/refresh-cw';
import replyIcon from '@iconify-icons/lucide/reply';
import saveIcon from '@iconify-icons/lucide/save';
import searchIcon from '@iconify-icons/lucide/search';
import sendIcon from '@iconify-icons/lucide/send';
import serverIcon from '@iconify-icons/lucide/server';
import settingsIcon from '@iconify-icons/lucide/settings';
import shieldAlertIcon from '@iconify-icons/lucide/shield-alert';
import shieldCheckIcon from '@iconify-icons/lucide/shield-check';
import shieldIcon from '@iconify-icons/lucide/shield';
import shieldOffIcon from '@iconify-icons/lucide/shield-off';
import slashIcon from '@iconify-icons/lucide/slash';
import slidersHorizontalIcon from '@iconify-icons/lucide/sliders-horizontal';
import slidersVerticalIcon from '@iconify-icons/lucide/sliders-vertical';
import smartphoneIcon from '@iconify-icons/lucide/smartphone';
import sparkleIcon from '@iconify-icons/lucide/sparkle';
import squareIcon from '@iconify-icons/lucide/square';
import sunIcon from '@iconify-icons/lucide/sun';
import targetIcon from '@iconify-icons/lucide/target';
import terminalIcon from '@iconify-icons/lucide/terminal';
import textSelectIcon from '@iconify-icons/lucide/text-select';
import trash2Icon from '@iconify-icons/lucide/trash-2';
import usersIcon from '@iconify-icons/lucide/users';
import wifiIcon from '@iconify-icons/lucide/wifi';
import wifiOffIcon from '@iconify-icons/lucide/wifi-off';
import wrenchIcon from '@iconify-icons/lucide/wrench';
import xIcon from '@iconify-icons/lucide/x';
import zapIcon from '@iconify-icons/lucide/zap';

export type IconProps = Omit<IconifyReactProps, 'icon' | 'ref'>;

export interface AppIconProps extends IconProps {
  /** 静态导入的本地 Iconify 图标数据（来自 `@iconify-icons/*`），禁止传在线字符串名。 */
  readonly icon: IconifyIcon;
}

function escapeAttr(value: string | number): string {
  return String(value).replace(/"/gu, '&quot;');
}

function customizeIcon(
  icon: IconifyIcon,
  strokeWidth?: string | number,
  fill?: string,
  stroke?: string,
): IconifyIcon {
  if (strokeWidth === undefined && fill === undefined && stroke === undefined) return icon;
  let body = icon.body;
  if (strokeWidth !== undefined) {
    body = body.replace(/stroke-width="[^"]*"/gu, `stroke-width="${escapeAttr(strokeWidth)}"`);
  }
  if (fill !== undefined) {
    body = body.replace(/fill="none"/gu, `fill="${escapeAttr(fill)}"`);
  }
  if (stroke !== undefined) {
    body = body.replace(/stroke="currentColor"/gu, `stroke="${escapeAttr(stroke)}"`);
  }
  return body === icon.body ? icon : { ...icon, body };
}

/** 通用离线 Iconify 图标组件：默认尺寸 16×16、颜色跟随 currentColor、默认 aria-hidden。 */
export function AppIcon({
  icon,
  width = 16,
  height = 16,
  strokeWidth,
  fill,
  stroke,
  ...rest
}: AppIconProps) {
  const resolved = customizeIcon(icon, strokeWidth, fill, stroke);
  return <Icon icon={resolved} width={width} height={height} {...rest} />;
}

/** 从本地 `@iconify-icons/*` 数据创建语义化离线图标组件。 */
export function createIcon(icon: IconifyIcon, defaults?: Partial<IconProps>) {
  return function SemanticIcon(props: IconProps) {
    const className =
      defaults?.className && props.className
        ? `${defaults.className} ${props.className}`
        : (props.className ?? defaults?.className);
    return <AppIcon icon={icon} {...defaults} {...props} className={className} />;
  };
}

export const PlusIcon = createIcon(plusIcon);
export const MoreIcon = createIcon(ellipsisIcon);
export const ChevronDownIcon = createIcon(chevronDownIcon);
export const ChevronRightIcon = createIcon(chevronRightIcon);
export const ArrowUpIcon = createIcon(arrowUpIcon);
export const ArrowDownIcon = createIcon(arrowDownIcon);
export const StopIcon = createIcon(squareIcon, { fill: 'currentColor' });
export const CopyIcon = createIcon(copyIcon);
export const CheckIcon = createIcon(checkIcon);
export const ErrorIcon = createIcon(circleAlertIcon);
export const InfoIcon = createIcon(infoIcon);
export const ToolIcon = createIcon(wrenchIcon);
export const SpinnerIcon = createIcon(loaderCircleIcon, { className: 'spin' });
export const SearchIcon = createIcon(searchIcon);
export const TerminalIcon = createIcon(terminalIcon);
export const FileEditIcon = createIcon(filePenLineIcon);
export const EyeIcon = createIcon(eyeIcon);
export const ShieldIcon = createIcon(shieldIcon);
export const ShieldCheckIcon = createIcon(shieldCheckIcon);
export const ShieldAlertIcon = createIcon(shieldAlertIcon);
export const PaperclipIcon = createIcon(paperclipIcon);
export const ZapIcon = createIcon(zapIcon);
export const ClipboardListIcon = createIcon(clipboardListIcon);
export const QuestionIcon = createIcon(circleQuestionMarkIcon);
export const FileIcon = createIcon(fileIcon);
export const FilesIcon = createIcon(filesIcon);
export const FolderIcon = createIcon(folderIcon);
export const FolderOpenIcon = createIcon(folderOpenIcon);
export const FolderTreeIcon = createIcon(folderTreeIcon);
export const SelectionIcon = createIcon(textSelectIcon);
export const CloseIcon = createIcon(xIcon);
export const SlashIcon = createIcon(slashIcon);
export const PlanIcon = createIcon(listIcon);
export const PencilIcon = createIcon(pencilIcon);
export const TrashIcon = createIcon(trash2Icon);
export const RefreshIcon = createIcon(refreshCwIcon);
export const KeyIcon = createIcon(keyRoundIcon);
export const GlobeIcon = createIcon(globeIcon);
export const LogIcon = createIcon(fileTextIcon);
export const SendIcon = createIcon(sendIcon);
export const SaveIcon = createIcon(saveIcon);
export const ChatIcon = createIcon(messageSquareIcon);
export const SparkleIcon = createIcon(sparkleIcon);
export const ChartPieIcon = createIcon(chartPieIcon);
export const GaugeIcon = createIcon(gaugeIcon);
export const FastForwardIcon = createIcon(fastForwardIcon);
export const LockIcon = createIcon(lockIcon);
export const UnlockIcon = createIcon(lockOpenIcon);
export const TargetIcon = createIcon(targetIcon);
export const ChecklistIcon = createIcon(listChecksIcon);
export const DiffIcon = createIcon(fileDiffIcon);
export const BookIcon = createIcon(bookOpenIcon);
export const BugIcon = createIcon(bugIcon);
export const BeakerIcon = createIcon(flaskConicalIcon);
export const ReplyIcon = createIcon(replyIcon);
export const TextSizeIcon = createIcon(aLargeSmallIcon);
export const ArrowLeftIcon = createIcon(arrowLeftIcon);
export const ArrowRightIcon = createIcon(arrowRightIcon);
export const ImageIcon = createIcon(imageIcon);
export const AgentIcon = createIcon(botIcon);
export const ServerIcon = createIcon(serverIcon);
export const SettingsIcon = createIcon(settingsIcon);
export const DownloadIcon = createIcon(downloadIcon);
export const BellIcon = createIcon(bellIcon);
export const PaletteIcon = createIcon(paletteIcon);
export const SunIcon = createIcon(sunIcon);
export const MoonIcon = createIcon(moonIcon);
export const MonitorIcon = createIcon(monitorIcon);
export const GitBranchIcon = createIcon(gitBranchIcon);
export const SlidersIcon = createIcon(slidersHorizontalIcon);
export const SlidersVerticalIcon = createIcon(slidersVerticalIcon);
export const ListIcon = createIcon(listIcon);
export const UsersIcon = createIcon(usersIcon);
export const DashboardIcon = createIcon(layoutGridIcon);
export const ClockIcon = createIcon(clockIcon);
export const HistoryIcon = createIcon(historyIcon);
export const KanbanIcon = createIcon(kanbanIcon);
export const PlayIcon = createIcon(playIcon, { fill: 'currentColor' });
export const ExpandPanelIcon = createIcon(maximize2Icon);
export const SidebarIcon = createIcon(panelLeftIcon);
export const PanelRightIcon = createIcon(panelRightIcon);
export const PuzzleIcon = createIcon(puzzleIcon);
export const PlugIcon = createIcon(plugIcon);
export const CodeIcon = createIcon(codeXmlIcon);
export const SmartphoneIcon = createIcon(smartphoneIcon);
export const QrCodeIcon = createIcon(qrCodeIcon);
export const WifiIcon = createIcon(wifiIcon);
export const WifiOffIcon = createIcon(wifiOffIcon);
export const LogOutIcon = createIcon(logOutIcon);
export const ShieldOffIcon = createIcon(shieldOffIcon);
export const LinkIcon = createIcon(link2Icon);
