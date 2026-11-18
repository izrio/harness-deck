/**
 * 插件入口：管理底层（内置的 dsh，或设置里配置的 ACP 代理），把当前底层的控制器接到侧边栏视图和命令上。
 *
 *   底层（dsh：RuntimeManager → DshConnection → ChatController；ACP：AcpProcess → AcpController）◀──messages──▶ ChatViewProvider
 *
 * 同一时间只运行一个底层。切换底层时停掉旧的、启动新的，Webview 重新取快照；每个底层的会话和标签分开保存。
 */
import { homedir } from 'node:os';
import { basename, isAbsolute, resolve } from 'node:path';
import * as vscode from 'vscode';
import {
  COLOR_SCHEMES,
  type AdvancedPreferences,
  type AppearanceState,
  type BackendsState,
  type ColorSchemeId,
  type HostSnapshot,
  type NodeEnvState,
  type NotificationPreferences,
  type PreferencesState,
  type ProjectsState,
  type RuntimeStatus,
  type WebviewToHost,
  type WorkbenchModule,
  type WorkbenchState,
} from '@harness-deck/shared';
import { createAcpBackend } from './backend/acp.ts';
import { createDshBackend } from './backend/dsh.ts';
import { processEnvWithProxy, setNpmGlobalBin, type BackendHost } from './backend/host.ts';
import {
  detectNodeEnv,
  fetchNpmVersions,
  installNpmPackage,
  isValidNpmVersion,
  listNpmGlobalPackages,
  probeCommandVersion,
  uninstallNpmPackage,
} from './backend/npmManager.ts';
import { safeProfile } from './runtime/launch.ts';
import { locateDsh, locateExecutable } from './runtime/locate.ts';
import {
  DSH_PROFILE,
  builtinProfiles,
  deleteBackendSetting,
  npmPackageFor,
  parseProfiles,
  profileView,
  upsertBackendSetting,
} from './backend/profiles.ts';
import type { BackendProfile, RunningBackend } from './backend/types.ts';
import { NotificationDispatcher } from './notifications/NotificationService.ts';
import { UnattendedRunner, type SchedulePermissionPreset } from './hub/UnattendedRunner.ts';
import { WorkbenchHub } from './hub/WorkbenchHub.ts';
import {
  buildProjectsState,
  createProjectWorktree,
  EMPTY_WORKTREE_CONFIG,
  parseProjectConfigs,
  parseRecentProjects,
  recordRecentProject,
  removeRecentProjectFromList,
  updateProjectConfigsMap,
} from './projects/ProjectService.ts';
import { ChatViewProvider } from './webview/ChatViewProvider.ts';
import { VscodeWorkbench } from './workbench/VscodeWorkbench.ts';
import { getLocale, resolveLocale, setLocale, t } from './i18n.ts';
import { redactSecrets } from './util/redact.ts';
import { command, migrateSettings, SECTION, settings } from './settings.ts';

const FOLDER_KEY = 'harnessDeck.folder';
const BACKEND_KEY = 'harnessDeck.backend';
const RECENT_PROJECTS_KEY = 'harnessDeck.recentProjects';
/** 改名前保存的键：读取时兼容，写入只写新键。 */
const LEGACY_FOLDER_KEY = 'dsh.folder';
const LEGACY_BACKEND_KEY = 'dsh.backend';
/** 内置 ACP 代理的安装和登录提示（Host 侧文案）。 */
const BUILTIN_HINTS = {
  'oh-my-pi': 'acp.ompHint',
  codebuddy: 'acp.codebuddyHint',
  claude: 'acp.claudeHint',
  'claude-sign-in': 'acp.claudeSignIn',
} as const;

let active: RunningBackend | undefined;
let hubInstance: WorkbenchHub | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const applyLocale = (): void =>
    setLocale(resolveLocale(vscode.env.language, settings('ui').get<string>('language', 'auto')));
  applyLocale();
  // 旧版本（DSH Copilot）的设置搬到 harnessDeck.* 下
  void migrateSettings().then((moved) => moved.length && log(`已迁移旧设置：${moved.join(', ')}`));
  const output = vscode.window.createOutputChannel('Harness Deck', { log: true });
  // 所有日志都先脱敏：错误信息里可能带着底层回显的令牌或 API Key
  const log = (line: string): void => output.info(redactSecrets(line));
  // 旧版本没卸载时，右键菜单里还有「DSH」：提示卸载
  void offerUninstallOldExtension(log);
  const runtimeOutput = vscode.window.createOutputChannel('Harness Deck: Backend', { log: true });
  context.subscriptions.push(output, runtimeOutput);

  // 多根工作区与按项目分组会话：优先恢复上次选择的目录（包括最近项目），默认第一个工作区文件夹
  const folders = (): readonly vscode.WorkspaceFolder[] => (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
  const defaultWorkspacePath = (): string => folders()[0]?.uri.fsPath ?? homedir();
  const savedFolder = context.workspaceState.get<string>(FOLDER_KEY) ?? context.workspaceState.get<string>(LEGACY_FOLDER_KEY);
  const savedInRecent = savedFolder
    ? parseRecentProjects(context.globalState.get<unknown>(RECENT_PROJECTS_KEY)).some((r) => r.path === savedFolder)
    : false;
  let workspacePath =
    folders().find((f) => f.uri.fsPath === savedFolder)?.uri.fsPath ??
    (savedFolder && savedInRecent ? savedFolder : undefined) ??
    defaultWorkspacePath();

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = command('openChat');
  context.subscriptions.push(status);
  let modelLabel: string | undefined;

  const openExternal = (url: string): void => {
    const uri = vscode.Uri.parse(url);
    // 传原字符串：Uri.toString() 会把查询里的 = 等字符编码掉，链接带参数时打开的地址就不对了
    if (uri.scheme === 'http' || uri.scheme === 'https') void vscode.env.openExternal(url as unknown as vscode.Uri);
  };

  // ---- 底层列表、环境探测与切换 ----
  const builtins = () => builtinProfiles((id) => t(BUILTIN_HINTS[id]));
  const profiles = (): BackendProfile[] =>
    parseProfiles(settings().get<unknown>('backends', []), log, builtins());
  /** 每个底层的命令在本机找不找得到、已安装版本、可用版本列表及安装卸载状态。 */
  const availability = new Map<string, boolean>();
  const installedVersions = new Map<string, string>();
  const availableVersions = new Map<string, readonly string[]>();
  const versionsLoading = new Set<string>();
  const versionsError = new Map<string, string>();
  const backendBusy = new Map<string, 'installing' | 'uninstalling' | 'switching'>();
  let nodeEnv: NodeEnvState = { checked: false, hasNode: false, hasNpm: false };
  let npmCommand: string | undefined;

  const savedBackend = (): string | undefined => context.workspaceState.get<string>(BACKEND_KEY) ?? context.workspaceState.get<string>(LEGACY_BACKEND_KEY);
  let targetBackendId = savedBackend() ?? DSH_PROFILE.id;

  const backendsState = (): BackendsState => {
    const builtinList = builtins();
    const builtinIds = new Set<string>([DSH_PROFILE.id, ...builtinList.map((b) => b.id)]);
    const rawCustom = settings().get<unknown>('backends', []);
    const customParsed = parseProfiles(rawCustom, () => undefined, []);
    const overriddenIds = new Set(customParsed.map((p) => p.id).filter((id) => id !== DSH_PROFILE.id && builtinIds.has(id)));
    return {
      items: profiles().map((p) =>
        profileView(p, {
          ...(availability.has(p.id) ? { available: availability.get(p.id) } : {}),
          ...(installedVersions.has(p.id) ? { version: installedVersions.get(p.id) } : {}),
          ...(availableVersions.has(p.id) ? { versions: availableVersions.get(p.id) } : {}),
          ...(versionsLoading.has(p.id) ? { versionsLoading: true } : {}),
          ...(versionsError.has(p.id) ? { versionsError: versionsError.get(p.id) } : {}),
          ...(backendBusy.has(p.id) ? { busy: backendBusy.get(p.id) } : {}),
          builtinIds,
          overriddenIds,
        }),
      ),
      active: active?.profile.id ?? targetBackendId,
      workspace: folders().find((f) => f.uri.fsPath === workspacePath)?.name ?? basename(workspacePath),
      nodeEnv,
    };
  };

  // ---- 最近项目与 Worktree 配置 ----
  const readRecentProjects = () => parseRecentProjects(context.globalState.get<unknown>(RECENT_PROJECTS_KEY));
  const saveRecentProjectPath = async (projectPath: string): Promise<void> => {
    const next = recordRecentProject(readRecentProjects(), projectPath);
    await context.globalState.update(RECENT_PROJECTS_KEY, next);
  };
  if (folders().length > 0) {
    void saveRecentProjectPath(workspacePath);
  }
  const projectsState = (): ProjectsState =>
    buildProjectsState({
      ...(folders().length > 0 ? { currentPath: workspacePath } : {}),
      recent: readRecentProjects(),
      configs: parseProjectConfigs(settings().get<unknown>('projects', {})),
    });

  // eslint-disable-next-line prefer-const
  let provider: ChatViewProvider | undefined;
  // eslint-disable-next-line prefer-const
  let hub: WorkbenchHub | undefined;
  let pendingModule: WorkbenchModule | undefined;
  let lastObservedSessionId: string | undefined;
  const focusView = () => vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
  const focusModule = async (mod: WorkbenchModule): Promise<void> => {
    pendingModule = mod;
    await focusView();
    provider?.post({ type: 'switchWorkbenchModule', payload: { module: mod } });
  };

  const notifications = new NotificationDispatcher({
    isWindowFocused: () => vscode.window.state.focused,
    getPreferences: readNotificationPreferences,
    actionLabel: () => t('notify.openSession'),
    showNotification: async (level, message, actionLabel) => {
      const choice = await (level === 'warning'
        ? vscode.window.showWarningMessage(message, actionLabel)
        : vscode.window.showInformationMessage(message, actionLabel));
      return choice === actionLabel;
    },
    openSession: async (sessionId) => {
      await focusView();
      provider?.post({ type: 'navigateToSession', payload: sessionId ? { sessionId } : {} });
      if (sessionId) {
        await active?.controller.handle({ type: 'switchSession', payload: { sessionId } });
      }
    },
  });

  const pushBackends = (): void => {
    provider?.post({ type: 'backends', payload: backendsState() });
    hub?.schedulePush();
  };
  const pushProjects = (): void => {
    provider?.post({ type: 'projects', payload: projectsState() });
    hub?.schedulePush();
  };

  let checking: Promise<void> | undefined;
  let checkDirty = false;
  const checkAvailability = (): Promise<void> => {
    checkDirty = true;
    return (checking ??= (async () => {
      while (checkDirty) {
        checkDirty = false;
        const platform = process.platform;
        const detected = await detectNodeEnv({ env: processEnvWithProxy(), platform });
        nodeEnv = detected.state;
        npmCommand = detected.npmCommand;
        setNpmGlobalBin(detected.npmGlobalBin);

        const npmPackages = npmCommand ? await listNpmGlobalPackages(npmCommand, processEnvWithProxy(), platform) : {};

        await Promise.all(
          profiles().map(async (p) => {
            const located =
              p.kind === 'dsh'
                ? await locateDsh({ configuredPath: settings('dsh').get<string>('path', ''), env: processEnvWithProxy(), platform })
                : await locateExecutable(p.command, { env: processEnvWithProxy(p.env), platform });
            const isAvailable = located.kind === 'found';
            availability.set(p.id, isAvailable);
            const pkg = npmPackageFor(p.id);
            let version = pkg ? npmPackages[pkg] : undefined;
            if (!version && isAvailable && p.kind === 'dsh') {
              version = await probeCommandVersion(located.command, processEnvWithProxy(), platform);
            }
            if (version) installedVersions.set(p.id, version);
            else installedVersions.delete(p.id);
          }),
        );
        pushBackends();
        // GUI 启动时 npm 全局目录在探测完成后才加入 PATH：若此前因找不到命令停在 notInstalled，立刻补启动
        if (provider?.visible && active?.currentStatus().kind === 'notInstalled' && availability.get(active.profile.id) === true) {
          active.start();
        }
      }
    })()
      .catch((error: unknown) => log(`检查底层是否安装失败：${String(error)}`))
      .finally(() => {
        checking = undefined;
      }));
  };
  const updateStatusBar = (): void =>
    renderStatusBar(status, active, modelLabel, profiles().find((p) => p.id === targetBackendId)?.name ?? DSH_PROFILE.name);

  // 下面的回调在视图创建之前就要引用它，所以先声明、后赋值
  const workbench = new VscodeWorkbench(log);

  const openExtensionSettings = (): void => {
    void vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`);
  };

  const applyAppearancePatch = async (patch: Extract<WebviewToHost, { type: 'setAppearance' }>['payload']): Promise<void> => {
    for (const [key, value] of Object.entries(patch) as [string, number | string | null | undefined][]) {
      if (value === undefined) continue;
      const cleared =
        value === null ||
        value === '' ||
        (key === 'theme' && value === 'system') ||
        (key === 'colorScheme' && value === 'slate') ||
        (key === 'paragraphSpacing' && typeof value === 'number' && value < 0) ||
        (key !== 'paragraphSpacing' && typeof value === 'number' && value <= 0);
      await writeSetting('ui', key, cleared ? undefined : value);
    }
  };

  const applyPreferencesPatch = async (patch: Extract<WebviewToHost, { type: 'setPreferences' }>['payload']): Promise<void> => {
    if (patch.language !== undefined) {
      await writeSetting('ui', 'language', patch.language === 'auto' ? undefined : patch.language);
    }
    if (patch.includeActiveEditor !== undefined) {
      await writeSetting('context', 'includeActiveEditor', patch.includeActiveEditor);
    }
    if (patch.showTurnChanges !== undefined) {
      await writeSetting('ui', 'showTurnChanges', patch.showTurnChanges);
    }
    if (patch.schedulePermission !== undefined) {
      await writeSetting(
        'schedules',
        'permission',
        patch.schedulePermission === 'danger-full-access' ? undefined : patch.schedulePermission,
      );
    }
    if (patch.notifications) {
      for (const [key, value] of Object.entries(patch.notifications)) {
        if (value !== undefined) await writeSetting('notifications', key, value);
      }
    }
    if (patch.advanced) {
      if (patch.advanced.dshPath !== undefined) {
        await writeSetting('dsh', 'path', patch.advanced.dshPath.trim() || undefined);
      }
      if (patch.advanced.dshProfile !== undefined) {
        const trimmed = patch.advanced.dshProfile.trim();
        const normalized = trimmed ? safeProfile(trimmed) : 'web';
        await writeSetting('dsh', 'profile', normalized === 'web' ? undefined : normalized);
      }
      if (patch.advanced.backendTrace !== undefined) {
        await writeSetting(undefined, 'backendTrace', patch.advanced.backendTrace);
      }
    }
  };

  const idleSnapshot = (): HostSnapshot => ({
    runtime: backendBusy.has(targetBackendId) ? { kind: 'starting' } : { kind: 'idle' },
    connection: 'idle',
    sessions: [],
    tabs: { items: [{ key: 'draft', title: t('session.new'), running: false }], active: 'draft' },
    session: { title: t('session.new'), running: false, hasOlder: false, loadingOlder: false, sync: 'idle' },
    items: [],
    models: { options: [] },
    interactions: [],
    permissions: { options: [] },
    workspace: { dirtyFiles: workbench.dirtyFiles().length },
    context: { includeActiveByDefault: settings('context').get<boolean>('includeActiveEditor', true), pinned: [] },
    commands: [],
    locale: getLocale(),
    appearance: readAppearance(),
    preferences: readPreferences(),
    backends: backendsState(),
    projects: projectsState(),
    ...(hub ? { workbench: hub.state() } : {}),
  });

  const host: BackendHost = {
    context,
    log,
    // 底层的输出同样先脱敏：ACP 代理的 stderr 和排查日志（backendTrace）里可能带着令牌或 API Key
    runtimeLog: (line, stream) => (stream === 'stderr' ? runtimeOutput.warn(redactSecrets(line)) : runtimeOutput.info(redactSecrets(line))),
    workspacePath: () => workspacePath,
    stateKey: (name) => (folders().length > 1 || workspacePath !== defaultWorkspacePath() ? `${name}:${workspacePath}` : name),
    onStatus: (nextStatus) => {
      updateStatusBar();
      const agentName = active?.profile.name ?? 'Agent';
      if (nextStatus.kind === 'failed') {
        notifications.observeRuntimeExit({
          kind: nextStatus.kind,
          message: nextStatus.message,
          ...(lastObservedSessionId ? { sessionId: lastObservedSessionId } : {}),
          text: t('notify.unexpectedExit', agentName, nextStatus.message),
        });
      } else if (nextStatus.kind === 'reconnecting') {
        notifications.observeRuntimeExit({
          kind: nextStatus.kind,
          message: 'reconnecting',
          ...(lastObservedSessionId ? { sessionId: lastObservedSessionId } : {}),
          text: t('notify.unexpectedExit', agentName, t('status.reconnecting', agentName)),
        });
      } else if (nextStatus.kind === 'connected') {
        notifications.observeRuntimeExit({ kind: nextStatus.kind, text: '' });
      }
    },
    controllerOptions: () => ({
      workbench,
      includeActiveEditor: () => settings('context').get<boolean>('includeActiveEditor', true),
      post: (message) => provider?.post(message),
      isVisible: () => provider?.visible ?? false,
      log,
      folderLabel: () => (folders().length > 1 ? folders().find((f) => f.uri.fsPath === workspacePath)?.name : undefined),
      selectFolder: () => void vscode.commands.executeCommand(command('selectFolder')),
      openExternal,
      showLogs: () => output.show(),
      appearance: readAppearance,
      preferences: readPreferences,
      backends: backendsState,
      projects: projectsState,
      showTurnChanges: () => settings('ui').get<boolean>('showTurnChanges', false),
      openSettings: openExtensionSettings,
      setAppearance: applyAppearancePatch,
      setPreferences: applyPreferencesPatch,
      pickFiles: async () => {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: true,
          canSelectFiles: true,
          canSelectFolders: false,
          defaultUri: vscode.Uri.file(workspacePath),
          title: t('files.pickTitle'),
        });
        return picked?.map((uri) => uri.fsPath) ?? [];
      },
      onSessionObserve: (obs) => {
        if (obs.sessionId) lastObservedSessionId = obs.sessionId;
        notifications.observeSession({
          ...obs,
          agentName: active?.profile.name ?? 'Agent',
          format: {
            attention: (agent, title) => t('notify.attention', agent, title),
            turnComplete: (agent, title) => t('notify.turnComplete', agent, title),
            scheduledComplete: (title) => t('notify.scheduledComplete', title),
          },
        });
        hub?.observeSession(obs);
      },
      isHiddenSession: (sessionId) => hub?.isHiddenSession(sessionId) ?? false,
      workbenchState: () => (hub ? hub.state() : emptyWorkbenchState()),
      onModelChange: (label) => {
        modelLabel = label;
        updateStatusBar();
      },
    }),
  };

  const create = (profile: BackendProfile): RunningBackend => {
    if (profile.kind === 'dsh') return createDshBackend(profile, host);
    return createAcpBackend(profile, host);
  };

  /**
   * 面板可见时启动当前底层。start 可以重复调用；已经失败过的不在这里自动重试（横幅里有「重试」）。
   * 面板每次重新显示（Webview 重新加载、发来 ready）都会走到这里：面板隐藏期间切换的底层在这时启动。
   */
  const startIfNeeded = (): void => {
    if (!active) return;
    const kind = active.currentStatus().kind;
    if (kind === 'idle' || kind === 'notInstalled' || kind === 'untrusted') active.start();
  };

  let activeProfileSignature = '';

  /** 换成选中的底层（找不到时用 dsh）。视图已经打开时立即启动，并让 Webview 重新取快照。 */
  const activateBackend = (id: string): void => {
    targetBackendId = id;
    const profile = profiles().find((p) => p.id === id) ?? DSH_PROFILE;
    try {
      active = create(profile);
      activeProfileSignature = JSON.stringify(profile);
    } catch (error) {
      log(`启动底层 ${profile.name} 失败：${error instanceof Error ? error.message : String(error)}`);
      active = create(DSH_PROFILE);
      activeProfileSignature = JSON.stringify(DSH_PROFILE);
    }
    modelLabel = undefined;
    updateStatusBar();
    if (provider?.visible) {
      active.start();
      provider.post({ type: 'snapshot', payload: active.controller.snapshot() });
    }
  };

  /**
   * 串行化所有对 `active` 生命周期的修改（切换底层、重载配置、npm 安装/卸载前停进程）：
   * 避免两次生命周期操作交错导致旧进程泄漏。
   */
  let switching: Promise<void> = Promise.resolve();
  const enqueueBackendTransition = (task: () => Promise<void>): Promise<void> => {
    switching = switching.then(task, task);
    return switching;
  };

  const switchBackend = (id: string, forceReload = false): Promise<void> =>
    enqueueBackendTransition(async () => {
      if (!forceReload && active?.profile.id === id) return;
      targetBackendId = id;
      const previous = active;
      active = undefined;
      lastObservedSessionId = undefined;
      notifications.reset();
      await context.workspaceState.update(BACKEND_KEY, id);
      await previous?.stop().catch((error: unknown) => log(`停止底层失败：${String(error)}`));
      activateBackend(id);
      log(`已切换到底层 ${(active as RunningBackend | undefined)?.profile.name ?? id}`);
    });

  const fetchVersions = async (id: string): Promise<void> => {
    const pkg = npmPackageFor(id);
    if (!pkg || versionsLoading.has(id)) return;
    if (!nodeEnv.checked) await checkAvailability();
    if (!nodeEnv.hasNpm || !npmCommand) {
      pushBackends();
      return;
    }
    versionsLoading.add(id);
    versionsError.delete(id);
    pushBackends();
    try {
      const versions = await fetchNpmVersions(npmCommand, pkg, processEnvWithProxy(), process.platform);
      availableVersions.set(id, versions);
    } catch (error) {
      versionsError.set(id, error instanceof Error ? error.message : String(error));
    } finally {
      versionsLoading.delete(id);
      pushBackends();
    }
  };

  const installOrSwitchBackend = async (id: string, version?: string): Promise<void> => {
    if (!vscode.workspace.isTrusted) {
      provider?.post({ type: 'toast', payload: { level: 'error', text: t('workspace.untrusted') } });
      return;
    }
    const profile = profiles().find((p) => p.id === id);
    const name = profile?.name ?? id;
    const pkg = npmPackageFor(id);
    if (!pkg) {
      provider?.post({ type: 'toast', payload: { level: 'error', text: t('backend.noNpmPackage', name) } });
      return;
    }
    if (version !== undefined && !isValidNpmVersion(version)) {
      provider?.post({ type: 'toast', payload: { level: 'error', text: t('backend.invalidVersion', version) } });
      return;
    }
    if (backendBusy.has(id)) return;
    if (!nodeEnv.checked || !nodeEnv.hasNode || !nodeEnv.hasNpm || !npmCommand) await checkAvailability();
    if (!nodeEnv.hasNode || !nodeEnv.hasNpm || !npmCommand) {
      provider?.post({ type: 'toast', payload: { level: 'error', text: t('backend.nodeRequired') } });
      pushBackends();
      return;
    }

    const wasInstalled = availability.get(id) === true;
    backendBusy.set(id, wasInstalled && version ? 'switching' : 'installing');
    pushBackends();

    try {
      await enqueueBackendTransition(async () => {
        if (active?.profile.id === id) {
          const previous = active;
          active = undefined;
          await previous.stop().catch((error: unknown) => log(`停止底层失败：${String(error)}`));
        }
      });
      const res = await installNpmPackage(npmCommand, pkg, version, processEnvWithProxy(), process.platform, host.runtimeLog);
      await checkAvailability();
      await enqueueBackendTransition(async () => {
        if (!active && targetBackendId === id) {
          activateBackend(id);
        }
      });
      if (res.ok) {
        const text = version ? t('backend.installVersionOk', name, version) : t('backend.installOk', name);
        provider?.post({ type: 'toast', payload: { level: 'info', text } });
      } else {
        provider?.post({ type: 'toast', payload: { level: 'error', text: t('backend.installFailed', name, res.message ?? 'unknown error') } });
      }
    } finally {
      backendBusy.delete(id);
      pushBackends();
    }
  };

  const uninstallBackend = async (id: string): Promise<void> => {
    if (!vscode.workspace.isTrusted) {
      provider?.post({ type: 'toast', payload: { level: 'error', text: t('workspace.untrusted') } });
      return;
    }
    const profile = profiles().find((p) => p.id === id);
    const name = profile?.name ?? id;
    const pkg = npmPackageFor(id);
    if (!pkg) {
      provider?.post({ type: 'toast', payload: { level: 'error', text: t('backend.noNpmPackage', name) } });
      return;
    }
    if (backendBusy.has(id)) return;
    if (!nodeEnv.checked || !nodeEnv.hasNode || !nodeEnv.hasNpm || !npmCommand) await checkAvailability();
    if (!nodeEnv.hasNode || !nodeEnv.hasNpm || !npmCommand) {
      provider?.post({ type: 'toast', payload: { level: 'error', text: t('backend.nodeRequired') } });
      pushBackends();
      return;
    }

    backendBusy.set(id, 'uninstalling');
    pushBackends();

    try {
      await enqueueBackendTransition(async () => {
        if (active?.profile.id === id) {
          const previous = active;
          active = undefined;
          await previous.stop().catch((error: unknown) => log(`停止底层失败：${String(error)}`));
        }
      });
      const res = await uninstallNpmPackage(npmCommand, pkg, processEnvWithProxy(), process.platform, host.runtimeLog);
      await checkAvailability();
      await enqueueBackendTransition(async () => {
        if (!active && targetBackendId === id) {
          activateBackend(id);
        }
      });
      if (res.ok) {
        provider?.post({ type: 'toast', payload: { level: 'info', text: t('backend.uninstallOk', name) } });
      } else {
        provider?.post({ type: 'toast', payload: { level: 'error', text: t('backend.uninstallFailed', name, res.message ?? 'unknown error') } });
      }
    } finally {
      backendBusy.delete(id);
      pushBackends();
    }
  };

  activateBackend(savedBackend() ?? DSH_PROFILE.id);
  /** 当前底层；切换途中（旧的已停、新的还没建好）为 undefined，这时的命令不做任何事。 */
  const current = (): RunningBackend | undefined => active;
  context.subscriptions.push(workbench.register(() => active?.controller.workspaceChanged()));

  const unattendedRunner = new UnattendedRunner({
    getActiveDshClient: () => active?.dshClient?.(),
    getDshConfig: () => ({
      configuredPath: settings('dsh').get<string>('path', ''),
      profile: safeProfile(settings('dsh').get<string>('profile', 'web') || 'web'),
      env: processEnvWithProxy(),
    }),
    getEnvForProfile: (profileEnv) => processEnvWithProxy(profileEnv),
    extensionVersion: String(context.extension.packageJSON.version ?? '0.4.0'),
    log,
    runtimeLog: host.runtimeLog,
  });

  hub = new WorkbenchHub({
    globalState: context.globalState,
    runner: unattendedRunner,
    locale: getLocale,
    isWorkspaceTrusted: () => vscode.workspace.isTrusted,
    isWebviewVisible: () => provider?.visible ?? false,
    workspacePath: () => workspacePath,
    projects: projectsState,
    profiles,
    schedulePermission: readSchedulePermission,
    activeContext: () => {
      const cur = current();
      if (!cur) return undefined;
      return {
        backendId: cur.profile.id,
        backendName: cur.profile.name,
        workspacePath,
        snapshot: cur.controller.snapshot(),
        crossProjectSessions: cur.controller.allWorkspaceSessions?.() ?? [],
        latestAssistantText: (sid) => cur.controller.latestAssistantText?.(sid),
      };
    },
    switchProjectAndBackend: async (projectPath, backendId) => {
      await saveRecentProjectPath(projectPath);
      if (projectPath !== workspacePath) {
        workspacePath = projectPath;
        lastObservedSessionId = undefined;
        notifications.reset();
        await context.workspaceState.update(FOLDER_KEY, workspacePath);
        current()?.controller.setWorkspace(workspacePath);
        current()?.controller.backendsChanged();
        pushProjects();
      } else {
        pushProjects();
      }
      if (backendId && backendId !== active?.profile.id) {
        await switchBackend(backendId);
      }
      startIfNeeded();
    },
    startProgrammaticSession: async (req) => {
      startIfNeeded();
      return current()?.controller.startProgrammaticSession?.(req);
    },
    switchSessionInActive: async (sessionId) => {
      startIfNeeded();
      await current()?.controller.handle({ type: 'switchSession', payload: { sessionId } });
    },
    openNewSessionInActive: async () => {
      startIfNeeded();
      await current()?.controller.handle({ type: 'newSession', payload: {} });
    },
    post: (msg) => provider?.post(msg),
    focusView,
    openPanel: () => provider?.openPanel(t('workbench.title')),
    notifyScheduledComplete: (ruleName, runStatus) => {
      if (runStatus === 'succeeded') {
        void notifications.notify({
          kind: 'scheduledComplete',
          message: t('notify.scheduledComplete', ruleName),
        });
      }
    },
    log,
  });
  hubInstance = hub;
  context.subscriptions.push({
    dispose: () => {
      hub?.dispose();
      if (hubInstance === hub) hubInstance = undefined;
    },
  });

  provider = new ChatViewProvider(context.extensionUri, {
    onMessage: (message) => {
      if (WORKBENCH_MESSAGE_TYPES.has(message.type)) {
        void hub?.handleMessage(message);
        return;
      }
      if (message.type === 'selectBackend') {
        void (async () => {
          const id = message.payload.id;
          if (id !== active?.profile.id) await switchBackend(id);
          else {
            await context.workspaceState.update(BACKEND_KEY, id);
            pushBackends();
          }
        })();
        return;
      }
      if (message.type === 'checkBackendEnv') {
        void checkAvailability();
        return;
      }
      if (message.type === 'fetchBackendVersions') {
        void fetchVersions(message.payload.id);
        return;
      }
      if (message.type === 'installBackend') {
        void installOrSwitchBackend(message.payload.id, message.payload.version);
        return;
      }
      if (message.type === 'uninstallBackend') {
        void uninstallBackend(message.payload.id);
        return;
      }
      if (message.type === 'upsertBackendProfile') {
        void (async () => {
          const next = upsertBackendSetting(settings().get<unknown>('backends', []), message.payload);
          await writeSetting(undefined, 'backends', next);
        })();
        return;
      }
      if (message.type === 'deleteBackendProfile') {
        void (async () => {
          const next = deleteBackendSetting(settings().get<unknown>('backends', []), message.payload.id);
          await writeSetting(undefined, 'backends', next.length > 0 ? next : undefined);
        })();
        return;
      }
      if (message.type === 'testNotification') {
        void notifications.sendTest(t('notify.test'), lastObservedSessionId);
        return;
      }
      if (message.type === 'setProjectWorktreeConfig') {
        void (async () => {
          const currentConfigs = parseProjectConfigs(settings().get<unknown>('projects', {}));
          const next = updateProjectConfigsMap(currentConfigs, message.payload.path, {
            copyFiles: message.payload.copyFiles,
            setupCommands: message.payload.setupCommands,
            verifyCommands: message.payload.verifyCommands,
          });
          await writeSetting(undefined, 'projects', Object.keys(next).length > 0 ? next : undefined);
          pushProjects();
        })();
        return;
      }
      if (message.type === 'addRecentProject') {
        void (async () => {
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            canSelectFiles: false,
            canSelectFolders: true,
            title: t('project.pickTitle'),
          });
          const folder = picked?.[0]?.fsPath;
          if (!folder) return;
          await saveRecentProjectPath(folder);
          pushProjects();
        })();
        return;
      }
      if (message.type === 'removeRecentProject') {
        void (async () => {
          const next = removeRecentProjectFromList(readRecentProjects(), message.payload.path);
          await context.globalState.update(RECENT_PROJECTS_KEY, next);
          pushProjects();
        })();
        return;
      }
      if (message.type === 'openProject') {
        void (async () => {
          await saveRecentProjectPath(message.payload.path);
          pushProjects();
          const matching = folders().find((f) => f.uri.fsPath === message.payload.path);
          if (matching) {
            workspacePath = matching.uri.fsPath;
            lastObservedSessionId = undefined;
            notifications.reset();
            await context.workspaceState.update(FOLDER_KEY, workspacePath);
            current()?.controller.setWorkspace(workspacePath);
            current()?.controller.backendsChanged();
            pushProjects();
          } else {
            await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(message.payload.path), false);
          }
        })();
        return;
      }
      if (message.type === 'createWorktree') {
        void (async () => {
          if (!vscode.workspace.isTrusted) {
            provider?.post({ type: 'toast', payload: { level: 'error', text: t('workspace.untrusted') } });
            return;
          }
          const configs = parseProjectConfigs(settings().get<unknown>('projects', {}));
          const config = configs[message.payload.path] ?? EMPTY_WORKTREE_CONFIG;
          const branch =
            message.payload.branch ??
            (await vscode.window.showInputBox({
              prompt: t('project.worktreeBranchPrompt'),
              placeHolder: 'feat/my-task',
            }));
          if (branch === undefined && !message.payload.branch) return;
          try {
            const result = await createProjectWorktree({
              repoPath: message.payload.path,
              ...(branch ? { branch } : {}),
              config,
              log,
            });
            await saveRecentProjectPath(result.worktreePath);
            pushProjects();
            provider?.post({ type: 'toast', payload: { level: 'info', text: t('project.worktreeCreated', result.worktreePath) } });
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            provider?.post({ type: 'toast', payload: { level: 'error', text: t('project.worktreeFailed', msg) } });
          }
        })();
        return;
      }
      if (message.type === 'runProjectVerify') {
        void (async () => {
          if (!vscode.workspace.isTrusted) {
            provider?.post({ type: 'toast', payload: { level: 'error', text: t('workspace.untrusted') } });
            return;
          }
          const configs = parseProjectConfigs(settings().get<unknown>('projects', {}));
          const config = configs[message.payload.path] ?? EMPTY_WORKTREE_CONFIG;
          if (config.verifyCommands.length === 0) {
            provider?.post({ type: 'toast', payload: { level: 'info', text: t('project.noVerifyCommands') } });
            return;
          }
          const termName = `Verify: ${basename(message.payload.path)}`;
          const terminal =
            vscode.window.terminals.find((term) => term.name === termName && term.exitStatus === undefined) ??
            vscode.window.createTerminal({
              name: termName,
              cwd: message.payload.path,
            });
          terminal.show();
          const isWinPowerShell = process.platform === 'win32' && /powershell(?:\.exe)?$/iu.test(vscode.env.shell);
          if (isWinPowerShell && config.verifyCommands.length > 1) {
            const chained = config.verifyCommands.reduce((acc, cmd) => `${acc}; if ($?) { ${cmd} }`);
            terminal.sendText(chained, true);
          } else {
            terminal.sendText(config.verifyCommands.join(' && '), true);
          }
          provider?.post({ type: 'toast', payload: { level: 'info', text: t('project.verifyStarted', basename(message.payload.path)) } });
        })();
        return;
      }
      // 宿主级全局消息直接处理，避免切换底层或 npm 安装期间 active 为空导致设置与外部链接失效
      if (message.type === 'setAppearance') {
        void applyAppearancePatch(message.payload).catch((error: unknown) => {
          provider?.post({ type: 'toast', payload: { level: 'error', text: t('appearance.failed', error instanceof Error ? error.message : String(error)) } });
          provider?.post({ type: 'appearance', payload: readAppearance() });
        });
        return;
      }
      if (message.type === 'setPreferences') {
        void applyPreferencesPatch(message.payload).catch((error: unknown) => {
          provider?.post({ type: 'toast', payload: { level: 'error', text: t('preferences.failed', error instanceof Error ? error.message : String(error)) } });
          provider?.post({ type: 'preferences', payload: readPreferences() });
        });
        return;
      }
      if (message.type === 'openSettings') {
        openExtensionSettings();
        return;
      }
      if (message.type === 'openExternal') {
        openExternal(message.payload.url);
        return;
      }
      if (message.type === 'showLogs') {
        output.show();
        return;
      }
      if (message.type === 'selectFolder') {
        void vscode.commands.executeCommand(command('selectFolder'));
        return;
      }
      if (message.type === 'previewMarkdown') {
        void (async () => {
          const rawPath = message.payload.path;
          const fullPath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(workspacePath, rawPath);
          const content = await workbench.readFile(fullPath);
          if (content === undefined) {
            provider?.post({
              type: 'markdownPreview',
              payload: { path: rawPath, title: basename(fullPath), error: t('open.failed', basename(fullPath), 'ENOENT') },
            });
            return;
          }
          provider?.post({
            type: 'markdownPreview',
            payload: { path: rawPath, title: basename(fullPath), content: content.slice(0, 500_000) },
          });
        })();
        return;
      }
      // 面板每次打开都重新检查一遍（用户可能刚装好），并确保当前底层已经启动
      if (message.type === 'ready') {
        void checkAvailability();
        startIfNeeded();
        if (!active) {
          provider?.post({ type: 'snapshot', payload: idleSnapshot() });
          if (pendingModule) {
            provider?.post({ type: 'switchWorkbenchModule', payload: { module: pendingModule } });
            pendingModule = undefined;
          }
          return;
        }
        void active.controller.handle(message).then(() => {
          if (pendingModule) {
            provider?.post({ type: 'switchWorkbenchModule', payload: { module: pendingModule } });
            pendingModule = undefined;
          }
        });
        return;
      }
      void active?.controller.handle(message);
    },
    onViewVisible: startIfNeeded,
    locale: getLocale,
    log: log,
  });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider));
  updateStatusBar();

  context.subscriptions.push(
    vscode.commands.registerCommand(command('openWorkbench'), () => {
      pendingModule = 'overview';
      provider?.openPanel(t('workbench.title'));
      provider?.post({ type: 'switchWorkbenchModule', payload: { module: 'overview' } });
      startIfNeeded();
    }),
    vscode.commands.registerCommand(command('openChat'), () => focusModule('sessions')),
    vscode.commands.registerCommand(command('newSession'), async () => {
      await focusModule('sessions');
      await current()?.controller.handle({ type: 'newSession', payload: {} });
    }),
    vscode.commands.registerCommand(command('interrupt'), () => current()?.controller.handle({ type: 'interrupt', payload: {} })),
    vscode.commands.registerCommand(command('selectBackend'), async () => {
      const picked = await vscode.window.showQuickPick(
        profiles().map((p) => ({ label: p.name, description: p.kind === 'dsh' ? 'dsh' : `ACP · ${p.command}`, picked: p.id === active?.profile.id, id: p.id })),
        { placeHolder: t('ext.selectBackend') },
      );
      if (!picked) return;
      if (picked.id !== active?.profile.id) await switchBackend(picked.id);
      else {
        await context.workspaceState.update(BACKEND_KEY, picked.id);
        pushBackends();
      }
    }),
    vscode.commands.registerCommand(command('selectModel'), async () => {
      const chat = current()?.controller;
      if (!chat) return;
      const models = chat.modelState();
      if (models.options.length === 0) {
        void vscode.window.showInformationMessage(t('ext.noModels'));
        return;
      }
      const picked = await vscode.window.showQuickPick(
        models.options.flatMap((option) =>
          (option.efforts.length > 1 ? option.efforts : [undefined]).map((effort) => ({
            label: option.name,
            description: [option.group, effort?.name].filter(Boolean).join(' · '),
            detail: option.description,
            picked: option.provider === models.current?.provider && option.model === models.current?.model,
            option,
            effort: effort?.id ?? option.efforts[0]?.id,
          })),
        ),
        { placeHolder: t('ext.selectModel') },
      );
      if (picked) {
        await chat.handle({
          type: 'selectModel',
          payload: { provider: picked.option.provider, model: picked.option.model, ...(picked.effort ? { reasoningEffort: picked.effort } : {}) },
        });
      }
    }),
    vscode.commands.registerCommand(command('explainSelection'), async () => {
      // 先同步取下选区（askAboutSelection 在第一个 await 之前读取当前编辑器），再切换焦点
      const sending = current()?.controller.askAboutSelection('explain');
      await focusModule('sessions');
      await sending;
    }),
    vscode.commands.registerCommand(command('fixSelection'), async () => {
      const sending = current()?.controller.askAboutSelection('fix');
      await focusModule('sessions');
      await sending;
    }),
    vscode.commands.registerCommand(command('testSelection'), async () => {
      const sending = current()?.controller.askAboutSelection('test');
      await focusModule('sessions');
      await sending;
    }),
    vscode.commands.registerCommand(command('addToChat'), async () => {
      current()?.controller.pinActiveEditor();
      await focusModule('sessions');
    }),
    vscode.commands.registerCommand(command('configureApiKey'), () => current()?.controller.configureApiKey()),
    vscode.commands.registerCommand(command('renameSession'), () => current()?.controller.renameSession()),
    vscode.commands.registerCommand(command('selectFolder'), async () => {
      const list = folders();
      if (list.length < 2) {
        void vscode.window.showInformationMessage(t('ext.singleFolder'));
        return;
      }
      const picked = await vscode.window.showQuickPick(
        list.map((f) => ({ label: f.name, description: f.uri.fsPath, picked: f.uri.fsPath === workspacePath, folder: f })),
        { placeHolder: t('ext.selectFolder') },
      );
      if (!picked || picked.folder.uri.fsPath === workspacePath) return;
      workspacePath = picked.folder.uri.fsPath;
      lastObservedSessionId = undefined;
      notifications.reset();
      await context.workspaceState.update(FOLDER_KEY, workspacePath);
      await saveRecentProjectPath(workspacePath);
      current()?.controller.setWorkspace(workspacePath);
      current()?.controller.backendsChanged();
      pushProjects();
    }),
    vscode.commands.registerCommand(command('restartRuntime'), () => current()?.restart()),
    vscode.commands.registerCommand(command('openWebUI'), () => current()?.controller.handle({ type: 'openWebUI', payload: {} })),
    vscode.commands.registerCommand(command('showLogs'), () => output.show()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      if (provider?.visible) startIfNeeded();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      const chat = current()?.controller;
      const pushPreferences = (): void => {
        if (chat) chat.preferencesChanged();
        else provider?.post({ type: 'preferences', payload: readPreferences() });
      };
      if (event.affectsConfiguration(`${SECTION}.dsh`)) {
        output.info('dsh 运行时设置已修改，执行「Harness Deck：重启智能体」后生效');
        pushPreferences();
      }
      if (event.affectsConfiguration(`${SECTION}.backends`)) {
        // 当前底层被删掉时回到 dsh；当前 ACP 底层的命令/参数/环境变量被修改时自动重新加载；其余情况只刷新列表
        const updated = profiles().find((p) => p.id === targetBackendId);
        if (!updated) {
          void switchBackend(DSH_PROFILE.id);
        } else if (active && active.profile.id === updated.id && JSON.stringify(updated) !== activeProfileSignature) {
          void switchBackend(updated.id, true);
        } else {
          pushBackends();
        }
        void checkAvailability();
      }
      if (event.affectsConfiguration(`${SECTION}.dsh.path`)) void checkAvailability();
      if (event.affectsConfiguration(`${SECTION}.context`)) {
        chat?.workspaceChanged();
        pushPreferences();
      }
      if (
        event.affectsConfiguration(`${SECTION}.ui.theme`) ||
        event.affectsConfiguration(`${SECTION}.ui.colorScheme`) ||
        event.affectsConfiguration(`${SECTION}.ui.fontSize`) ||
        event.affectsConfiguration(`${SECTION}.ui.fontFamily`) ||
        event.affectsConfiguration(`${SECTION}.ui.lineHeight`) ||
        event.affectsConfiguration(`${SECTION}.ui.paragraphSpacing`) ||
        event.affectsConfiguration(`${SECTION}.ui.contentWidth`) ||
        event.affectsConfiguration(`${SECTION}.ui.codeFontFamily`) ||
        event.affectsConfiguration(`${SECTION}.ui.terminalFontSize`) ||
        event.affectsConfiguration(`${SECTION}.ui.terminalLineHeight`)
      ) {
        if (chat) chat.appearanceChanged();
        else provider?.post({ type: 'appearance', payload: readAppearance() });
      }
      if (event.affectsConfiguration(`${SECTION}.ui.showTurnChanges`)) {
        chat?.workspaceChanged();
        pushPreferences();
      }
      if (
        event.affectsConfiguration(`${SECTION}.notifications`) ||
        event.affectsConfiguration(`${SECTION}.backendTrace`) ||
        event.affectsConfiguration(`${SECTION}.schedules`)
      ) {
        pushPreferences();
      }
      if (event.affectsConfiguration(`${SECTION}.projects`)) {
        pushProjects();
      }
      if (event.affectsConfiguration(`${SECTION}.ui.language`)) {
        applyLocale();
        if (chat) chat.localeChanged();
        else provider?.post({ type: 'locale', payload: getLocale() });
        pushPreferences();
        pushBackends();
        updateStatusBar();
      }
    }),
  );
}

export async function deactivate(): Promise<void> {
  hubInstance?.dispose();
  hubInstance = undefined;
  await active?.stop();
}

const WORKBENCH_MESSAGE_TYPES: ReadonlySet<WebviewToHost['type']> = new Set([
  'openWorkbenchPanel',
  'markUnreadRead',
  'upsertSchedule',
  'toggleSchedule',
  'deleteSchedule',
  'runScheduleNow',
  'markScheduleRunRead',
  'upsertAgent',
  'deleteAgent',
  'startAgentSession',
  'delegateToAgent',
  'createTask',
  'updateTaskStatus',
  'reorderTask',
  'deleteTask',
  'clearDoneTasks',
  'setTaskQueueAutoRun',
  'runTaskNow',
  'startProjectSession',
  'openProjectSession',
]);

function emptyWorkbenchState(): WorkbenchState {
  return {
    overview: { waiting: [], todos: [], running: [], upcoming: [], unread: [] },
    schedules: [],
    agents: [],
    tasks: { items: [], autoRun: true },
    sessionGroups: [],
  };
}

function readSchedulePermission(): SchedulePermissionPreset {
  const raw = settings('schedules').get<string>('permission', 'danger-full-access');
  return raw === 'workspace-write' || raw === 'read-only' ? raw : 'danger-full-access';
}

const GLOBAL_ONLY_SETTINGS = new Set(['backends', 'projects', 'dsh.path']);

/** 写入设置：machine/application 作用域固定写用户级；其余优先写已设置过的那一级，默认用户级。 */
async function writeSetting(sub: string | undefined, key: string, value: unknown): Promise<void> {
  const fullSuffix = sub ? `${sub}.${key}` : key;
  const config = settings(sub);
  if (GLOBAL_ONLY_SETTINGS.has(fullSuffix)) {
    await config.update(key, value, vscode.ConfigurationTarget.Global);
    return;
  }
  const inspected = config.inspect(key);
  const target =
    inspected?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  await config.update(key, value, target);
}

/** 读取系统通知偏好。 */
function readNotificationPreferences(): NotificationPreferences {
  const cfg = settings('notifications');
  return {
    enabled: cfg.get<boolean>('enabled', true),
    onlyWhenUnfocused: cfg.get<boolean>('onlyWhenUnfocused', true),
    onAttention: cfg.get<boolean>('onAttention', true),
    onTurnComplete: cfg.get<boolean>('onTurnComplete', true),
    onUnexpectedExit: cfg.get<boolean>('onUnexpectedExit', true),
    onScheduledComplete: cfg.get<boolean>('onScheduledComplete', true),
  };
}

/** 读取诊断与高级偏好。 */
function readAdvancedPreferences(): AdvancedPreferences {
  const dshCfg = settings('dsh');
  return {
    dshPath: dshCfg.get<string>('path', ''),
    dshProfile: safeProfile(dshCfg.get<string>('profile', 'web') || 'web'),
    backendTrace: settings().get<boolean>('backendTrace', false),
  };
}

/** 读取设置页里的通用偏好。 */
function readPreferences(): PreferencesState {
  const rawLang = settings('ui').get<string>('language', 'auto');
  const language: PreferencesState['language'] = rawLang === 'zh' || rawLang === 'en' ? rawLang : 'auto';
  return {
    language,
    includeActiveEditor: settings('context').get<boolean>('includeActiveEditor', true),
    showTurnChanges: settings('ui').get<boolean>('showTurnChanges', false),
    schedulePermission: readSchedulePermission(),
    notifications: readNotificationPreferences(),
    advanced: readAdvancedPreferences(),
  };
}

function isColorScheme(value: string): value is ColorSchemeId {
  return (COLOR_SCHEMES as readonly string[]).includes(value);
}

/** 界面主题、配色、阅读与聊天排版、终端排版；默认值省去，Webview 使用内置默认。 */
function readAppearance(): AppearanceState {
  const config = settings('ui');
  const rawTheme = config.get<string>('theme', 'system');
  const theme = rawTheme === 'light' || rawTheme === 'dark' ? rawTheme : undefined;
  const rawScheme = config.get<string>('colorScheme', 'slate');
  const colorScheme = isColorScheme(rawScheme) && rawScheme !== 'slate' ? rawScheme : undefined;
  const size = config.get<number>('fontSize', 0);
  const family = config.get<string>('fontFamily', '').trim();
  const lineHeight = config.get<number>('lineHeight', 0);
  const paragraphSpacing = config.get<number>('paragraphSpacing', -1);
  const contentWidth = config.get<number>('contentWidth', 0);
  const code = config.get<string>('codeFontFamily', '').trim();
  const terminalFontSize = config.get<number>('terminalFontSize', 0);
  const terminalLineHeight = config.get<number>('terminalLineHeight', 0);
  return {
    ...(theme ? { theme } : {}),
    ...(colorScheme ? { colorScheme } : {}),
    ...(Number.isFinite(size) && size > 0 ? { fontSize: Math.min(32, Math.max(8, Math.round(size))) } : {}),
    ...(family ? { fontFamily: family } : {}),
    ...(Number.isFinite(lineHeight) && lineHeight > 0 ? { lineHeight: Math.min(2.4, Math.max(1.2, Number(lineHeight.toFixed(2)))) } : {}),
    ...(Number.isFinite(paragraphSpacing) && paragraphSpacing >= 0
      ? { paragraphSpacing: Math.min(32, Math.max(0, Math.round(paragraphSpacing))) }
      : {}),
    ...(Number.isFinite(contentWidth) && contentWidth > 0 ? { contentWidth: Math.min(1600, Math.max(520, Math.round(contentWidth))) } : {}),
    ...(code ? { codeFontFamily: code } : {}),
    ...(Number.isFinite(terminalFontSize) && terminalFontSize > 0
      ? { terminalFontSize: Math.min(24, Math.max(9, Math.round(terminalFontSize))) }
      : {}),
    ...(Number.isFinite(terminalLineHeight) && terminalLineHeight > 0
      ? { terminalLineHeight: Math.min(2.4, Math.max(1.1, Number(terminalLineHeight.toFixed(2)))) }
      : {}),
  };
}

function renderStatusBar(
  item: vscode.StatusBarItem,
  backend: RunningBackend | undefined,
  modelLabel: string | undefined,
  fallbackName = 'DeepSeek',
): void {
  const name = backend?.profile.name ?? fallbackName;
  const status: RuntimeStatus = backend?.currentStatus() ?? { kind: 'idle' };
  const text: Record<RuntimeStatus['kind'], string> = {
    idle: `$(circle-outline) ${name}`,
    locating: `$(loading~spin) ${name}`,
    starting: `$(loading~spin) ${t('status.starting', name)}`,
    connected: `$(check) ${name}${modelLabel ? ` · ${modelLabel}` : ''}`,
    reconnecting: `$(loading~spin) ${t('status.reconnecting', name)}`,
    notInstalled: `$(warning) ${t('status.notInstalled', name)}`,
    unsupportedVersion: `$(warning) ${t('status.unsupported', name)}`,
    failed: `$(error) ${name}`,
    untrusted: `$(shield) ${name}`,
  };
  item.text = text[status.kind];
  item.tooltip = status.kind === 'connected' ? `${name} ${status.version}` : status.kind === 'failed' ? status.message : undefined;
  item.show();
}

/** 改名前的扩展。它和 Harness Deck 是两个扩展 id，没卸载时编辑器右键菜单里还有「DSH」，侧边栏里也多一个面板。 */
const OLD_EXTENSION_ID = 'izrio.dsh-copilot';

async function offerUninstallOldExtension(log: (line: string) => void): Promise<void> {
  if (!vscode.extensions.getExtension(OLD_EXTENSION_ID)) return;
  log(`旧版扩展 ${OLD_EXTENSION_ID} 还装着`);
  const uninstall = t('ext.oldUninstall');
  const choice = await vscode.window.showWarningMessage(t('ext.oldInstalled'), uninstall);
  if (choice !== uninstall) return;
  try {
    await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', OLD_EXTENSION_ID);
  } catch (error) {
    log(`卸载旧版扩展失败：${error instanceof Error ? error.message : String(error)}`);
    void vscode.commands.executeCommand('workbench.extensions.search', OLD_EXTENSION_ID);
  }
}
