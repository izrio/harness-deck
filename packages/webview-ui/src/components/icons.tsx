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
import brainIcon from '@iconify-icons/lucide/brain';
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
import coinsIcon from '@iconify-icons/lucide/coins';
import columns2Icon from '@iconify-icons/lucide/columns-2';
import commandIcon from '@iconify-icons/lucide/command';
import contrastIcon from '@iconify-icons/lucide/contrast';
import copyIcon from '@iconify-icons/lucide/copy';
import downloadIcon from '@iconify-icons/lucide/download';
import ellipsisIcon from '@iconify-icons/lucide/ellipsis';
import externalLinkIcon from '@iconify-icons/lucide/external-link';
import eyeIcon from '@iconify-icons/lucide/eye';
import fastForwardIcon from '@iconify-icons/lucide/fast-forward';
import fileDiffIcon from '@iconify-icons/lucide/file-diff';
import fileIcon from '@iconify-icons/lucide/file';
import filePenLineIcon from '@iconify-icons/lucide/file-pen-line';
import fileTextIcon from '@iconify-icons/lucide/file-text';
import filesIcon from '@iconify-icons/lucide/files';
import filterIcon from '@iconify-icons/lucide/filter';
import flaskConicalIcon from '@iconify-icons/lucide/flask-conical';
import folderIcon from '@iconify-icons/lucide/folder';
import folderOpenIcon from '@iconify-icons/lucide/folder-open';
import folderTreeIcon from '@iconify-icons/lucide/folder-tree';
import gaugeIcon from '@iconify-icons/lucide/gauge';
import gitBranchIcon from '@iconify-icons/lucide/git-branch';
import gitCommitHorizontalIcon from '@iconify-icons/lucide/git-commit-horizontal';
import gitForkIcon from '@iconify-icons/lucide/git-fork';
import gitPullRequestCreateIcon from '@iconify-icons/lucide/git-pull-request-create';
import globeIcon from '@iconify-icons/lucide/globe';
import historyIcon from '@iconify-icons/lucide/history';
import imageIcon from '@iconify-icons/lucide/image';
import infoIcon from '@iconify-icons/lucide/info';
import kanbanIcon from '@iconify-icons/lucide/kanban';
import keyRoundIcon from '@iconify-icons/lucide/key-round';
import layoutDashboardIcon from '@iconify-icons/lucide/layout-dashboard';
import layoutGridIcon from '@iconify-icons/lucide/layout-grid';
import link2Icon from '@iconify-icons/lucide/link-2';
import listChecksIcon from '@iconify-icons/lucide/list-checks';
import listIcon from '@iconify-icons/lucide/list';
import listTodoIcon from '@iconify-icons/lucide/list-todo';
import loaderCircleIcon from '@iconify-icons/lucide/loader-circle';
import lockIcon from '@iconify-icons/lucide/lock';
import lockOpenIcon from '@iconify-icons/lucide/lock-open';
import logInIcon from '@iconify-icons/lucide/log-in';
import logOutIcon from '@iconify-icons/lucide/log-out';
import maximize2Icon from '@iconify-icons/lucide/maximize-2';
import messageSquareIcon from '@iconify-icons/lucide/message-square';
import messageSquarePlusIcon from '@iconify-icons/lucide/message-square-plus';
import minusIcon from '@iconify-icons/lucide/minus';
import monitorIcon from '@iconify-icons/lucide/monitor';
import moonIcon from '@iconify-icons/lucide/moon';
import networkIcon from '@iconify-icons/lucide/network';
import paletteIcon from '@iconify-icons/lucide/palette';
import panelBottomIcon from '@iconify-icons/lucide/panel-bottom';
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
import routeIcon from '@iconify-icons/lucide/route';
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
import sparklesIcon from '@iconify-icons/lucide/sparkles';
import squareIcon from '@iconify-icons/lucide/square';
import squareMousePointerIcon from '@iconify-icons/lucide/square-mouse-pointer';
import sunIcon from '@iconify-icons/lucide/sun';
import targetIcon from '@iconify-icons/lucide/target';
import terminalIcon from '@iconify-icons/lucide/terminal';
import textSelectIcon from '@iconify-icons/lucide/text-select';
import trash2Icon from '@iconify-icons/lucide/trash-2';
import undo2Icon from '@iconify-icons/lucide/undo-2';
import uploadIcon from '@iconify-icons/lucide/upload';
import usersIcon from '@iconify-icons/lucide/users';
import wifiIcon from '@iconify-icons/lucide/wifi';
import wifiOffIcon from '@iconify-icons/lucide/wifi-off';
import wrenchIcon from '@iconify-icons/lucide/wrench';
import xIcon from '@iconify-icons/lucide/x';
import zapIcon from '@iconify-icons/lucide/zap';

// VS Code 官方风格文件与目录图标（静态按需打包，零网络请求）
import vscodeDefaultFileIcon from '@iconify-icons/vscode-icons/default-file';
import vscodeDefaultFolderIcon from '@iconify-icons/vscode-icons/default-folder';
import vscodeDefaultFolderOpenedIcon from '@iconify-icons/vscode-icons/default-folder-opened';
import vscodeAudioIcon from '@iconify-icons/vscode-icons/file-type-audio';
import vscodeCIcon from '@iconify-icons/vscode-icons/file-type-c';
import vscodeCppIcon from '@iconify-icons/vscode-icons/file-type-cpp';
import vscodeCsharpIcon from '@iconify-icons/vscode-icons/file-type-csharp';
import vscodeCssIcon from '@iconify-icons/vscode-icons/file-type-css';
import vscodeCsvIcon from '@iconify-icons/vscode-icons/file-type-csv';
import vscodeDiffIcon from '@iconify-icons/vscode-icons/file-type-diff';
import vscodeDockerIcon from '@iconify-icons/vscode-icons/file-type-docker2';
import vscodeDotenvIcon from '@iconify-icons/vscode-icons/file-type-dotenv';
import vscodeEslintIcon from '@iconify-icons/vscode-icons/file-type-eslint';
import vscodeExcelIcon from '@iconify-icons/vscode-icons/file-type-excel';
import vscodeFontIcon from '@iconify-icons/vscode-icons/file-type-font';
import vscodeGitIcon from '@iconify-icons/vscode-icons/file-type-git';
import vscodeGoIcon from '@iconify-icons/vscode-icons/file-type-go';
import vscodeGradleIcon from '@iconify-icons/vscode-icons/file-type-gradle';
import vscodeGraphqlIcon from '@iconify-icons/vscode-icons/file-type-graphql';
import vscodeHtmlIcon from '@iconify-icons/vscode-icons/file-type-html';
import vscodeImageIcon from '@iconify-icons/vscode-icons/file-type-image';
import vscodeIniIcon from '@iconify-icons/vscode-icons/file-type-ini';
import vscodeJavaIcon from '@iconify-icons/vscode-icons/file-type-java';
import vscodeJsIcon from '@iconify-icons/vscode-icons/file-type-js-official';
import vscodeJsonIcon from '@iconify-icons/vscode-icons/file-type-json-official';
import vscodeKeyIcon from '@iconify-icons/vscode-icons/file-type-key';
import vscodeKotlinIcon from '@iconify-icons/vscode-icons/file-type-kotlin';
import vscodeLessIcon from '@iconify-icons/vscode-icons/file-type-less';
import vscodeLicenseIcon from '@iconify-icons/vscode-icons/file-type-license';
import vscodeMarkdownIcon from '@iconify-icons/vscode-icons/file-type-markdown';
import vscodeNpmIcon from '@iconify-icons/vscode-icons/file-type-npm';
import vscodePdfIcon from '@iconify-icons/vscode-icons/file-type-pdf2';
import vscodePhpIcon from '@iconify-icons/vscode-icons/file-type-php';
import vscodePnpmIcon from '@iconify-icons/vscode-icons/file-type-pnpm';
import vscodePrettierIcon from '@iconify-icons/vscode-icons/file-type-prettier';
import vscodePrismaIcon from '@iconify-icons/vscode-icons/file-type-prisma';
import vscodePythonIcon from '@iconify-icons/vscode-icons/file-type-python';
import vscodeReactJsIcon from '@iconify-icons/vscode-icons/file-type-reactjs';
import vscodeReactTsIcon from '@iconify-icons/vscode-icons/file-type-reactts';
import vscodeRubyIcon from '@iconify-icons/vscode-icons/file-type-ruby';
import vscodeRustIcon from '@iconify-icons/vscode-icons/file-type-rust';
import vscodeScssIcon from '@iconify-icons/vscode-icons/file-type-scss';
import vscodeShellIcon from '@iconify-icons/vscode-icons/file-type-shell';
import vscodeSqlIcon from '@iconify-icons/vscode-icons/file-type-sql';
import vscodeSvelteIcon from '@iconify-icons/vscode-icons/file-type-svelte';
import vscodeSvgIcon from '@iconify-icons/vscode-icons/file-type-svg';
import vscodeSwiftIcon from '@iconify-icons/vscode-icons/file-type-swift';
import vscodeTextIcon from '@iconify-icons/vscode-icons/file-type-text';
import vscodeTomlIcon from '@iconify-icons/vscode-icons/file-type-toml';
import vscodeTsconfigIcon from '@iconify-icons/vscode-icons/file-type-tsconfig-official';
import vscodeTsIcon from '@iconify-icons/vscode-icons/file-type-typescript-official';
import vscodeVideoIcon from '@iconify-icons/vscode-icons/file-type-video';
import vscodeViteIcon from '@iconify-icons/vscode-icons/file-type-vite';
import vscodeVitestIcon from '@iconify-icons/vscode-icons/file-type-vitest';
import vscodeVueIcon from '@iconify-icons/vscode-icons/file-type-vue';
import vscodeXmlIcon from '@iconify-icons/vscode-icons/file-type-xml';
import vscodeYamlIcon from '@iconify-icons/vscode-icons/file-type-yaml';
import vscodeYarnIcon from '@iconify-icons/vscode-icons/file-type-yarn';
import vscodeZipIcon from '@iconify-icons/vscode-icons/file-type-zip2';

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
export const CoinsIcon = createIcon(coinsIcon);
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
export const BrainIcon = createIcon(brainIcon);
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
export const GitCommitIcon = createIcon(gitCommitHorizontalIcon);
export const GitPullRequestIcon = createIcon(gitPullRequestCreateIcon);
export const UploadIcon = createIcon(uploadIcon);
export const FilterIcon = createIcon(filterIcon);
export const SlidersIcon = createIcon(slidersHorizontalIcon);
export const SlidersVerticalIcon = createIcon(slidersVerticalIcon);
export const ListIcon = createIcon(listIcon);
export const ListTodoIcon = createIcon(listTodoIcon);
export const UsersIcon = createIcon(usersIcon);
export const DashboardIcon = createIcon(layoutGridIcon);
export const LayoutDashboardIcon = createIcon(layoutDashboardIcon);
export const ClockIcon = createIcon(clockIcon);
export const HistoryIcon = createIcon(historyIcon);
export const KanbanIcon = createIcon(kanbanIcon);
export const PlayIcon = createIcon(playIcon, { fill: 'currentColor' });
export const ExpandPanelIcon = createIcon(maximize2Icon);
export const SidebarIcon = createIcon(panelLeftIcon);
export const PanelBottomIcon = createIcon(panelBottomIcon);
export const PanelRightIcon = createIcon(panelRightIcon);
export const InspectIcon = createIcon(squareMousePointerIcon);
export const NetworkIcon = createIcon(networkIcon);
export const PuzzleIcon = createIcon(puzzleIcon);
export const PlugIcon = createIcon(plugIcon);
export const CodeIcon = createIcon(codeXmlIcon);
export const SmartphoneIcon = createIcon(smartphoneIcon);
export const QrCodeIcon = createIcon(qrCodeIcon);
export const WifiIcon = createIcon(wifiIcon);
export const WifiOffIcon = createIcon(wifiOffIcon);
export const LogInIcon = createIcon(logInIcon);
export const LogOutIcon = createIcon(logOutIcon);
export const ShieldOffIcon = createIcon(shieldOffIcon);
export const LinkIcon = createIcon(link2Icon);
export const RouteIcon = createIcon(routeIcon);
export const ColumnsIcon = createIcon(columns2Icon);
export const CommandIcon = createIcon(commandIcon);
export const ContrastIcon = createIcon(contrastIcon);
export const ExternalLinkIcon = createIcon(externalLinkIcon);
export const GitForkIcon = createIcon(gitForkIcon);
export const MessageSquarePlusIcon = createIcon(messageSquarePlusIcon);
export const MinusIcon = createIcon(minusIcon);
export const SparklesIcon = createIcon(sparklesIcon);
export const UndoIcon = createIcon(undo2Icon);
export const VscodeFolderIcon = createIcon(vscodeDefaultFolderIcon);
export const VscodeFolderOpenIcon = createIcon(vscodeDefaultFolderOpenedIcon);

export type FileIconKind =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'jsx'
  | 'json'
  | 'markdown'
  | 'css'
  | 'scss'
  | 'less'
  | 'html'
  | 'xml'
  | 'vue'
  | 'svelte'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'kotlin'
  | 'gradle'
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'ruby'
  | 'php'
  | 'swift'
  | 'shell'
  | 'yaml'
  | 'toml'
  | 'dotenv'
  | 'ini'
  | 'docker'
  | 'git'
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'tsconfig'
  | 'vite'
  | 'vitest'
  | 'eslint'
  | 'prettier'
  | 'sql'
  | 'graphql'
  | 'prisma'
  | 'svg'
  | 'image'
  | 'pdf'
  | 'archive'
  | 'csv'
  | 'excel'
  | 'audio'
  | 'video'
  | 'font'
  | 'key'
  | 'diff'
  | 'license'
  | 'text'
  | 'file';

/** 根据文件名与扩展名推断 VS Code 图标分类。 */
export function resolveFileIconKind(path?: string): FileIconKind {
  const normalized = (path ?? '').replace(/\\/gu, '/');
  const name = (normalized.slice(normalized.lastIndexOf('/') + 1) || normalized).toLowerCase();

  // 特殊配置文件名优先匹配
  if (name === 'package.json' || name === 'package-lock.json' || name === '.npmrc' || name === '.npmignore') return 'npm';
  if (name === 'pnpm-lock.yaml' || name === 'pnpm-workspace.yaml' || name === '.pnpmfile.cjs') return 'pnpm';
  if (name === 'yarn.lock' || name === '.yarnrc' || name === '.yarnrc.yml') return 'yarn';
  if (/^tsconfig(?:\..+)?\.json$/u.test(name) || /^jsconfig(?:\..+)?\.json$/u.test(name)) return 'tsconfig';
  if (/^vite\.config\./u.test(name)) return 'vite';
  if (/^vitest\.config\./u.test(name)) return 'vitest';
  if (/^(?:eslint\.config\.|\.eslintrc)/u.test(name)) return 'eslint';
  if (/^(?:prettier\.config\.|\.prettierrc|\.prettierignore)/u.test(name)) return 'prettier';
  if (name === 'dockerfile' || name.startsWith('dockerfile.') || name === '.dockerignore' || /^docker-compose.*\.(?:ya?ml)$/u.test(name)) {
    return 'docker';
  }
  if (name === '.gitignore' || name === '.gitattributes' || name === '.gitmodules' || name === '.gitkeep') return 'git';
  if (name === '.env' || name.startsWith('.env.')) return 'dotenv';
  if (name === 'license' || name.startsWith('license.') || name === 'copying') return 'license';
  if (name === 'build.gradle' || name === 'build.gradle.kts' || name === 'settings.gradle' || name === 'settings.gradle.kts') {
    return 'gradle';
  }

  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'tsx':
      return 'tsx';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'jsx':
      return 'jsx';
    case 'json':
    case 'jsonc':
    case 'json5':
    case 'ndjson':
      return 'json';
    case 'md':
    case 'mdx':
    case 'markdown':
      return 'markdown';
    case 'css':
      return 'css';
    case 'scss':
    case 'sass':
      return 'scss';
    case 'less':
      return 'less';
    case 'html':
    case 'htm':
    case 'xhtml':
      return 'html';
    case 'xml':
    case 'plist':
      return 'xml';
    case 'vue':
      return 'vue';
    case 'svelte':
      return 'svelte';
    case 'py':
    case 'pyi':
      return 'python';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    case 'java':
      return 'java';
    case 'kt':
    case 'kts':
      return 'kotlin';
    case 'gradle':
      return 'gradle';
    case 'c':
    case 'h':
      return 'c';
    case 'cpp':
    case 'cc':
    case 'cxx':
    case 'hpp':
    case 'hh':
      return 'cpp';
    case 'cs':
      return 'csharp';
    case 'rb':
      return 'ruby';
    case 'php':
      return 'php';
    case 'swift':
      return 'swift';
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'fish':
    case 'ps1':
    case 'bat':
    case 'cmd':
      return 'shell';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'toml':
      return 'toml';
    case 'ini':
    case 'cfg':
    case 'conf':
    case 'properties':
    case 'editorconfig':
      return 'ini';
    case 'sql':
    case 'sqlite':
    case 'db':
      return 'sql';
    case 'graphql':
    case 'gql':
      return 'graphql';
    case 'prisma':
      return 'prisma';
    case 'svg':
      return 'svg';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'ico':
    case 'bmp':
    case 'avif':
      return 'image';
    case 'pdf':
      return 'pdf';
    case 'zip':
    case 'tar':
    case 'gz':
    case 'tgz':
    case '7z':
    case 'rar':
    case 'vsix':
    case 'jar':
      return 'archive';
    case 'csv':
    case 'tsv':
      return 'csv';
    case 'xls':
    case 'xlsx':
      return 'excel';
    case 'mp3':
    case 'wav':
    case 'ogg':
    case 'flac':
    case 'm4a':
      return 'audio';
    case 'mp4':
    case 'mov':
    case 'webm':
    case 'avi':
    case 'mkv':
      return 'video';
    case 'woff':
    case 'woff2':
    case 'ttf':
    case 'otf':
    case 'eot':
      return 'font';
    case 'pem':
    case 'key':
    case 'crt':
    case 'cer':
    case 'pub':
    case 'p12':
      return 'key';
    case 'diff':
    case 'patch':
      return 'diff';
    case 'txt':
    case 'rst':
    case 'adoc':
    case 'log':
      return 'text';
    default:
      return 'file';
  }
}

const VSCODE_FILE_ICON_MAP: Record<FileIconKind, IconifyIcon> = {
  typescript: vscodeTsIcon,
  tsx: vscodeReactTsIcon,
  javascript: vscodeJsIcon,
  jsx: vscodeReactJsIcon,
  json: vscodeJsonIcon,
  markdown: vscodeMarkdownIcon,
  css: vscodeCssIcon,
  scss: vscodeScssIcon,
  less: vscodeLessIcon,
  html: vscodeHtmlIcon,
  xml: vscodeXmlIcon,
  vue: vscodeVueIcon,
  svelte: vscodeSvelteIcon,
  python: vscodePythonIcon,
  go: vscodeGoIcon,
  rust: vscodeRustIcon,
  java: vscodeJavaIcon,
  kotlin: vscodeKotlinIcon,
  gradle: vscodeGradleIcon,
  c: vscodeCIcon,
  cpp: vscodeCppIcon,
  csharp: vscodeCsharpIcon,
  ruby: vscodeRubyIcon,
  php: vscodePhpIcon,
  swift: vscodeSwiftIcon,
  shell: vscodeShellIcon,
  yaml: vscodeYamlIcon,
  toml: vscodeTomlIcon,
  dotenv: vscodeDotenvIcon,
  ini: vscodeIniIcon,
  docker: vscodeDockerIcon,
  git: vscodeGitIcon,
  npm: vscodeNpmIcon,
  pnpm: vscodePnpmIcon,
  yarn: vscodeYarnIcon,
  tsconfig: vscodeTsconfigIcon,
  vite: vscodeViteIcon,
  vitest: vscodeVitestIcon,
  eslint: vscodeEslintIcon,
  prettier: vscodePrettierIcon,
  sql: vscodeSqlIcon,
  graphql: vscodeGraphqlIcon,
  prisma: vscodePrismaIcon,
  svg: vscodeSvgIcon,
  image: vscodeImageIcon,
  pdf: vscodePdfIcon,
  archive: vscodeZipIcon,
  csv: vscodeCsvIcon,
  excel: vscodeExcelIcon,
  audio: vscodeAudioIcon,
  video: vscodeVideoIcon,
  font: vscodeFontIcon,
  key: vscodeKeyIcon,
  diff: vscodeDiffIcon,
  license: vscodeLicenseIcon,
  text: vscodeTextIcon,
  file: vscodeDefaultFileIcon,
};

/** 按文件路径/后缀渲染离线 Iconify VS Code 图标（`@iconify-icons/vscode-icons`）。 */
export function FileTypeIcon({
  path,
  className,
  ...rest
}: IconProps & { readonly path?: string }) {
  const kind = resolveFileIconKind(path);
  return (
    <AppIcon
      icon={VSCODE_FILE_ICON_MAP[kind]}
      data-file-icon-kind={kind}
      className={className}
      {...rest}
    />
  );
}
