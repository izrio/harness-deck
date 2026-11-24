/**
 * 核心宿主运行时（HarnessHostRuntime）：与具体 IDE（VS Code / JetBrains）完全解耦的编排中枢。
 *
 * 统一管理：
 * - 多底层生命周期（DeepSeek dsh、Claude Code、Pi、ZCode 与自定义 ACP 代理）及命令路径/版本缓存
 * - 第三方服务商配置、密钥状态同步与本机回环代理（ProviderProxy）
 * - Agent Skills 与统一 MCP 服务器扫描/安装/注入
 * - 工作台五模块协调器（WorkbenchHub）与后台隔离任务执行器（UnattendedRunner）
 * - 系统通知调度（NotificationDispatcher）与全部 16 个宿主命令
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  backendCapabilities,
  deriveTurns,
  isProviderReadyForBackend,
  type AccountConfig,
  type AccountLoginProgress,
  type AccountsState,
  type AccountView,
  type AdvancedPreferences,
  type AcpRegistryState,
  type AppearanceState,
  type BackendChannelBinding,
  type BackendsState,
  type ChatCommand,
  type ClientSurface,
  type DiscoveredGitSkill,
  type ExtensionsState,
  type HostSnapshot,
  type HostToWebview,
  type InstalledSkillView,
  type McpImportCandidate,
  type McpMarketState,
  type McpServerConfig,
  type NodeEnvState,
  type NotificationPreferences,
  type PreferencesState,
  type ProjectsState,
  type ProvidersState,
  type RemoteRouteKind,
  type RemoteScope,
  type RemoteState,
  type RuntimeStatus,
  type SkillImportCandidate,
  type SkillMarketState,
  type TabsState,
  type ThemePreset,
  type WebviewToHost,
  type WorkbenchModule,
  type WorkbenchState,
} from '@harness-deck/shared';
import {
  captureTurnCheckpoint,
  listTurnCheckpoints,
  restoreTurnCheckpoint,
} from '../git/CheckpointManager.ts';
import { EmbeddedTerminalManager } from '../terminal/EmbeddedTerminalManager.ts';
import {
  BrowserMcpServer,
  buildBuiltinBrowserMcpConfig,
  ensureBrowserMcpBridgeScript,
} from '../browser/BrowserMcpServer.ts';
import { EmbeddedBrowserManager } from '../browser/EmbeddedBrowserManager.ts';
import { AccountAuthFlowManager } from '../accounts/AccountAuthFlow.ts';
import { inspectOfficialAccount, type AccountInspectionResult } from '../accounts/AccountInspector.ts';
import {
  clearAccountCredentials,
  prepareAccountLaunchPatch,
  removeIsolatedAccountData,
  switchAntigravityCredentialSlot,
  switchCodebuddyCredentialSlot,
  syncActiveAntigravitySlotFromDisk,
} from '../accounts/AccountIsolation.ts';
import {
  accountApiKeySecretKey,
  accountCookieSecretKey,
  accountSlotSecretKey,
  activeOfficialAccountId,
  deleteAccountSetting,
  effectiveProviderForBackend,
  isSystemAccountId,
  parseAccountsSetting,
  parseBackendChannelsSetting,
  resolveBackendChannel,
  setBackendChannelSetting,
  systemAccountId,
  upsertAccountSetting,
} from '../accounts/AccountStore.ts';
import { createAcpBackend } from '../backend/acp.ts';
import { parseAcpRegistry } from '../backend/acpRegistry.ts';
import { createClaudeBackend } from '../backend/claude.ts';
import { createCodebuddyBackend } from '../backend/codebuddy.ts';
import { createCodexBackend } from '../backend/codex.ts';
import { createDshBackend } from '../backend/dsh.ts';
import {
  BACKEND_ENV_CACHE_KEY,
  commandSpecForProfile,
  isAutoDetectedCommandSpec,
  isBackendEnvCacheComplete,
  parseBackendEnvCache,
  type CachedExecutableRecord,
  type PersistedBackendEnvCache,
} from '../backend/envCache.ts';
import { processEnvWithProxy, setNpmGlobalBin, type BackendHost } from '../backend/host.ts';
import {
  checkNpmOwnership,
  detectNodeEnv,
  fetchNpmVersions,
  installNpmPackage,
  isValidNpmVersion,
  listNpmGlobalPackages,
  probeCommandVersion,
  uninstallNpmPackage,
} from '../backend/npmManager.ts';
import { createPiBackend } from '../backend/pi.ts';
import {
  DSH_PROFILE,
  builtinProfiles,
  deleteBackendSetting,
  npmPackageFor,
  parseProfiles,
  profileView,
  upsertBackendSetting,
  type BuiltinHintId,
} from '../backend/profiles.ts';
import type { BackendProfile, RunningBackend } from '../backend/types.ts';
import { createZcodeBackend } from '../backend/zcode.ts';
import { locateClaude } from '../claude/locate.ts';
import { locateCodebuddy } from '../codebuddy/locate.ts';
import { locateCodex } from '../codex/locate.ts';
import { parseMcpConfigFileContent, scanAgentMcpConfigs } from '../extensions/mcpImporter.ts';
import {
  backendExtensionsSignature,
  deleteMcpServerSetting,
  importMcpServersSetting,
  normalizeMcpId,
  parseMcpServersSetting,
  prepareBackendLaunch,
  toggleMcpServerSetting,
  upsertMcpServerSetting,
} from '../extensions/mcpService.ts';
import {
  deleteInstalledSkill,
  importLocalSkills,
  installSkillsFromGit,
  loadInstalledSkills,
  scanAgentSkills,
  scanLocalSkillDirectory,
  scanSkillsFromGit,
  syncInstalledSkill,
  updateSkillEntry,
} from '../extensions/skillService.ts';
import { fetchOnlineMcpMarket, fetchOnlineSkillMarket } from '../extensions/marketService.ts';
import { UnattendedRunner, type SchedulePermissionPreset } from '../hub/UnattendedRunner.ts';
import { WorkbenchHub } from '../hub/WorkbenchHub.ts';
import { getLocale, resolveLocale, setLocale, t, type HostMessageKey } from '../i18n.ts';
import { NotificationDispatcher } from '../notifications/NotificationService.ts';
import { locatePi } from '../pi/locate.ts';
import {
  buildProjectsState,
  createProjectWorktree,
  EMPTY_WORKTREE_CONFIG,
  normalizeProjectPath,
  parseProjectConfigs,
  parseRecentProjects,
  recordRecentProject,
  removeProjectWorktree,
  removeRecentProjectFromList,
  updateProjectConfigsMap,
} from '../projects/ProjectService.ts';
import { fetchRemoteProviderModels, ProviderProxy } from '../providers/ProviderProxy.ts';
import {
  clearQuotaCacheFor,
  queryAntigravityQuota,
  queryClaudeQuota,
  queryCodebuddyQuota,
  quotaProviderFor,
} from '../quota/provider.ts';
import {
  bindProviderSetting,
  buildProvidersState,
  deleteProviderSetting,
  parseProvidersSetting,
  providerSecretKey,
  upsertProviderSetting,
} from '../providers/ProviderStore.ts';
import { safeProfile } from '../runtime/launch.ts';
import { extraSearchDirsForCommand, locateDsh, locateExecutable, verifyExecutableFile } from '../runtime/locate.ts';
import { isWslEnvironment, isWslWindowsPath } from '../runtime/wsl.ts';
import { redactSecrets } from '../util/redact.ts';
import { locateZcode, verifyZcodeTarget } from '../zcode/locate.ts';
import { UnifiedTabsModel } from '../vm/UnifiedTabs.ts';
import type { Workbench } from '../vm/workbench.ts';
import { ClientHub, UNICAST_HOST_MESSAGE_TYPES } from './ClientHub.ts';
import type { HostCommandId, HostPlatform } from './HostPlatform.ts';
import { CommandReceipts } from './receipts.ts';
import { DeviceAuthStore } from '../remote/DeviceAuthStore.ts';
import { buildMobileDiffContent, buildMobileFileContent } from '../remote/mobileDiff.ts';
import { PushService } from '../remote/PushService.ts';
import { RemoteBridgeServer } from '../remote/RemoteBridgeServer.ts';
import type { TailscaleExec } from '../remote/TailscaleService.ts';
import { isSchedulerLockHeld, schedulerLockPath } from '../sidecar/schedulerLock.ts';

const FOLDER_KEY = 'harnessDeck.folder';
const BACKEND_KEY = 'harnessDeck.backend';
const RECENT_PROJECTS_KEY = 'harnessDeck.recentProjects';
const UNIFIED_TABS_KEY = 'harnessDeck.unifiedTabs';
/** 改名前保存的键：读取时兼容，写入只写新键。 */
const LEGACY_FOLDER_KEY = 'dsh.folder';
const LEGACY_BACKEND_KEY = 'dsh.backend';

const BUILTIN_HINTS: Readonly<Record<BuiltinHintId, HostMessageKey>> = {
  pi: 'pi.hint',
  'pi-sign-in': 'pi.signIn',
  codebuddy: 'codebuddy.hint',
  'codebuddy-sign-in': 'codebuddy.signIn',
  claude: 'claude.hint',
  'claude-sign-in': 'claude.signIn',
  codex: 'codex.hint',
  'codex-sign-in': 'codex.signIn',
  opencode: 'acp.opencodeHint',
  'opencode-sign-in': 'acp.opencodeSignIn',
  antigravity: 'acp.antigravityHint',
  'antigravity-sign-in': 'acp.antigravitySignIn',
  zcode: 'zcode.hint',
  'zcode-sign-in': 'zcode.signIn',
};

const WORKBENCH_MESSAGE_TYPES: ReadonlySet<WebviewToHost['type']> = new Set([
  'openWorkbenchPanel',
  'refreshSourceControl',
  'openSourceControlDiff',
  'sourceControlCommit',
  'sourceControlPush',
  'sourceControlCreatePr',
  'sourceControlStageFile',
  'sourceControlUnstageFile',
  'sourceControlDiscardFile',
  'sourceControlStageHunk',
  'sourceControlDiscardHunk',
  'sourceControlCheckoutBranch',
  'sourceControlCreateBranch',
  'sourceControlPull',
  'sourceControlFetch',
  'sourceControlGenerateCommitMessage',
  'sourceControlGeneratePrDraft',
  'sourceControlSettlePr',
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
  'deleteProjectSession',
]);

export interface HarnessHostRuntime {
  handleWebviewMessage(message: WebviewToHost, clientId?: string): void;
  registerIdeClient?(clientId: string, send: (message: HostToWebview) => void): () => void;
  onViewVisible(): void;
  onWorkspaceChanged(): void;
  executeCommand(cmd: HostCommandId): Promise<void>;
  getRemoteState?(): RemoteState;
  generateRemotePairing?(options?: { readonly scope?: RemoteScope; readonly routeKind?: RemoteRouteKind }): Promise<RemoteState>;
  dispose(): Promise<void>;
}

export interface HarnessHostRuntimeOptions {
  readonly createBackend?: (profile: BackendProfile, host: BackendHost) => RunningBackend;
  readonly remotePort?: number;
  readonly remoteBindHost?: string;
  readonly tailscaleExec?: TailscaleExec;
  readonly fetchImpl?: typeof fetch;
}

export function createHarnessHostRuntime(
  platform: HostPlatform,
  runtimeOptions: HarnessHostRuntimeOptions = {},
): HarnessHostRuntime {
  const disposers: (() => void)[] = [];

  const applyLocale = (): void =>
    setLocale(resolveLocale(platform.envLanguage(), platform.settings.get<string>('ui.language', 'auto')));
  applyLocale();

  const log = (line: string): void => platform.log(redactSecrets(line));
  const runtimeLog = (line: string, stream: 'stdout' | 'stderr'): void =>
    platform.runtimeLog(redactSecrets(line), stream);

  const clientRequestContext = new AsyncLocalStorage<{
    readonly clientId: string;
    readonly surface: ClientSurface;
    readonly unicastSnapshot?: boolean;
  }>();

  let updateStatusBarRef: () => void = () => undefined;
  const remoteBridgeBox: { current?: RemoteBridgeServer } = {};
  let startIfNeededRef: () => void = () => undefined;

  const clientHub = new ClientHub({
    hostKind: platform.hostKind,
    postToIde: (message) => platform.postToWebview(message),
    isIdeVisible: () => platform.isWebviewVisible(),
    onRemoteClientsChanged: () => {
      updateStatusBarRef();
      if (clientHub.remoteClientCount() > 0) {
        startIfNeededRef();
      }
      if (remoteBridgeBox.current) {
        clientHub.broadcastIde({ type: 'remote', payload: remoteBridgeBox.current.getState() });
      }
    },
  });

  const isAnyClientVisible = (): boolean => clientHub.isAnyClientVisible();

  const post = (message: HostToWebview): void => {
    const outgoing: HostToWebview =
      message.type === 'snapshot'
        ? {
            type: 'snapshot',
            payload: {
              ...message.payload,
              ...(message.payload.hostKind === undefined ? { hostKind: platform.hostKind } : {}),
              ...(remoteBridgeBox.current && message.payload.remote === undefined
                ? { remote: remoteBridgeBox.current.getState() }
                : {}),
            },
          }
        : message;

    const ctx = clientRequestContext.getStore();
    if (ctx) {
      if (outgoing.type === 'snapshot' && ctx.unicastSnapshot) {
        clientHub.sendTo(ctx.clientId, outgoing);
        return;
      }
      if (outgoing.type === 'switchWorkbenchModule' && ctx.unicastSnapshot) {
        clientHub.sendTo(ctx.clientId, outgoing);
        return;
      }
      if (UNICAST_HOST_MESSAGE_TYPES.has(outgoing.type)) {
        clientHub.sendTo(ctx.clientId, outgoing);
        return;
      }
    }
    clientHub.broadcast(outgoing);
  };

  const displayInlinePath = (rawPath: string): string => {
    if (!isAbsolute(rawPath)) return rawPath.replace(/\\/gu, '/');
    const rel = relative(workspacePath, rawPath);
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replace(/\\/gu, '/') : rawPath;
  };

  const sendInlineFile = async (rawPath: string): Promise<void> => {
    const fullPath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(workspacePath, rawPath);
    if (!isAbsolute(rawPath)) {
      const relCheck = relative(workspacePath, fullPath);
      if (relCheck.startsWith('..') || isAbsolute(relCheck)) {
        post({
          type: 'diffContent',
          payload: buildMobileFileContent(rawPath, undefined, t('open.failed', basename(rawPath), 'EACCES')),
        });
        return;
      }
    }
    const content = await platform.workbench.readFile(fullPath);
    const insideWorkspace = (() => {
      const rel = relative(workspacePath, fullPath);
      return !rel.startsWith('..') && !isAbsolute(rel);
    })();
    const fileData = buildMobileFileContent(
      displayInlinePath(rawPath),
      content,
      t('open.failed', basename(fullPath), 'ENOENT'),
      { editable: insideWorkspace && platform.isWorkspaceTrusted() },
    );
    post({ type: 'diffContent', payload: fileData });
  };

  const sendInlineDiff = async (
    request: Parameters<Workbench['openDiff']>[0],
    meta?: { readonly sourceControlPath?: string; readonly staged?: boolean },
  ): Promise<void> => {
    const diffData = await buildMobileDiffContent(request, platform.workbench.readFile);
    post({
      type: 'diffContent',
      payload: {
        ...diffData,
        path: displayInlinePath(diffData.path),
        ...(meta?.sourceControlPath ? { sourceControlPath: meta.sourceControlPath } : {}),
        ...(meta?.staged !== undefined ? { staged: meta.staged } : {}),
      },
    });
  };

  const checkpointsBySession = new Map<string, readonly number[]>();
  const terminalManager = new EmbeddedTerminalManager({
    onStateChange: (state) => post({ type: 'terminalState', payload: state }),
    onOutput: (event) => post({ type: 'terminalOutput', payload: event }),
    log,
  });

  const BROWSER_AI_ENABLED_KEY = 'harnessDeck.browserAiEnabled';
  let browserMcpBridgePath: string | undefined;
  const browserManager = new EmbeddedBrowserManager({
    storageRoot: platform.storageRoot,
    initialAiEnabled: platform.globalState.get<boolean>(BROWSER_AI_ENABLED_KEY) ?? true,
    configuredExecutablePath: () => platform.settings.get<string>('browser.executablePath', '') || undefined,
    onStateChange: (state) => post({ type: 'browserState', payload: state }),
    onFrame: (frame) => post({ type: 'browserFrame', payload: frame }),
    onAiEnabledChange: (enabled) => {
      void platform.globalState.update(BROWSER_AI_ENABLED_KEY, enabled);
    },
    log,
  });
  const browserMcpServer = new BrowserMcpServer(browserManager, {
    version: platform.extensionVersion,
    log,
  });
  const ensureBrowserMcpReady = async (): Promise<void> => {
    if (!browserManager.isAiEnabled()) return;
    try {
      await browserMcpServer.ensureStarted();
      if (!browserMcpBridgePath) {
        browserMcpBridgePath = await ensureBrowserMcpBridgeScript(platform.storageRoot);
      }
    } catch (error) {
      log(`启动内置浏览器 MCP 服务失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const refreshSessionCheckpoints = async (cwd: string, sessionId: string | undefined): Promise<readonly number[]> => {
    if (!sessionId) return [];
    const turns = await listTurnCheckpoints(cwd, sessionId);
    checkpointsBySession.set(sessionId, turns);
    post({ type: 'sessionCheckpoints', payload: { sessionId, turns } });
    return turns;
  };

  const mobileAwareWorkbench: Workbench = {
    openDiff: async (request) => {
      const ctx = clientRequestContext.getStore();
      if (ctx?.surface === 'mobile-web') {
        const diffData = await buildMobileDiffContent(request, platform.workbench.readFile);
        clientHub.sendTo(ctx.clientId, { type: 'diffContent', payload: diffData });
        return;
      }
      return platform.workbench.openDiff(request);
    },
    readFile: (path) => platform.workbench.readFile(path),
    writeFile: (path, content) => platform.workbench.writeFile(path, content),
    deleteFile: (path) => platform.workbench.deleteFile(path),
    openFile: async (path, range) => {
      const ctx = clientRequestContext.getStore();
      if (ctx?.surface === 'mobile-web') {
        const content = await platform.workbench.readFile(path);
        const fileData = buildMobileFileContent(path, content, t('open.failed', basename(path), 'ENOENT'));
        clientHub.sendTo(ctx.clientId, { type: 'diffContent', payload: fileData });
        return;
      }
      return platform.workbench.openFile(path, range);
    },
    activeEditor: () => platform.workbench.activeEditor(),
    findFiles: (query) => platform.workbench.findFiles(query),
    dirtyFiles: () => platform.workbench.dirtyFiles(),
    saveAll: () => platform.workbench.saveAll(),
    confirm: async (message, detail, action) => {
      if (clientRequestContext.getStore()?.surface === 'mobile-web') return false;
      return platform.workbench.confirm(message, detail, action);
    },
    input: async (options) => {
      if (clientRequestContext.getStore()?.surface === 'mobile-web') return undefined;
      return platform.workbench.input(options);
    },
  };

  const deviceAuthStore = new DeviceAuthStore(platform.globalState);
  const pushService = new PushService(platform.globalState, deviceAuthStore, {
    isWindowFocused: () => platform.isWindowFocused(),
    ...(runtimeOptions.fetchImpl ? { fetchImpl: runtimeOptions.fetchImpl } : {}),
    log,
  });

  const processEnv = (extra: Readonly<Record<string, string | undefined>> = {}): Record<string, string | undefined> =>
    processEnvWithProxy(extra, platform.settings.getHttpProxy());

  // 多根工作区与按项目分组会话：优先恢复上次选择的目录（包括最近项目），默认第一个工作区文件夹
  const folders = () => platform.workspaceFolders();
  const defaultWorkspacePath = (): string => normalizeProjectPath(folders()[0]?.path ?? homedir()) || homedir();
  const rawSavedFolder =
    platform.workspaceState.get<string>(FOLDER_KEY) ?? platform.workspaceState.get<string>(LEGACY_FOLDER_KEY);
  const savedFolder = rawSavedFolder ? normalizeProjectPath(rawSavedFolder) : undefined;
  const savedInRecent = savedFolder
    ? parseRecentProjects(platform.globalState.get<unknown>(RECENT_PROJECTS_KEY)).some((r) => r.path === savedFolder)
    : false;
  const matchedFolder = savedFolder ? folders().find((f) => normalizeProjectPath(f.path) === savedFolder)?.path : undefined;
  let workspacePath =
    (matchedFolder ? normalizeProjectPath(matchedFolder) : undefined) ??
    (savedFolder && savedInRecent ? savedFolder : undefined) ??
    defaultWorkspacePath();

  interface ManagedBackend {
    readonly backend: RunningBackend;
    profileSignature: string;
    boundProviderSignature: string;
    extensionsSignature: string;
    modelLabel?: string;
    lastObservedSessionId?: string;
    workspacePath: string;
  }

  const managedBackends = new Map<string, ManagedBackend>();
  const notifiers = new Map<string, NotificationDispatcher>();
  const lastBackendRunning = new Map<string, boolean>();
  let active: ManagedBackend | undefined;

  const openExternalVoid = (url: string): void => {
    void platform.openExternal(url);
  };

  // ---- 底层列表、环境探测与切换 ----
  const builtins = () => builtinProfiles((id) => t(BUILTIN_HINTS[id]));
  const profiles = (): BackendProfile[] =>
    parseProfiles(platform.settings.get<unknown>('backends', []), log, builtins());

  const inWsl = process.platform === 'linux' && isWslEnvironment();
  const restoredEnvCache = parseBackendEnvCache(
    platform.globalState.get<unknown>(BACKEND_ENV_CACHE_KEY),
    process.platform,
    { isWsl: inWsl },
  );
  const availability = new Map<string, boolean>(Object.entries(restoredEnvCache?.availability ?? {}));
  const installedVersions = new Map<string, string>(Object.entries(restoredEnvCache?.installedVersions ?? {}));
  const availableVersions = new Map<string, readonly string[]>(
    Object.entries(restoredEnvCache?.availableVersions ?? {}),
  );
  const cachedExecutables = new Map<string, CachedExecutableRecord>(
    Object.entries(restoredEnvCache?.executables ?? {}),
  );
  const versionsLoading = new Set<string>();
  const versionsError = new Map<string, string>();
  const backendBusy = new Map<string, 'installing' | 'uninstalling' | 'switching'>();
  const npmOwnership = new Map<string, boolean>();
  let acpRegistry: AcpRegistryState | undefined;
  let nodeEnv: NodeEnvState = restoredEnvCache?.nodeEnv ?? { checked: false, hasNode: false, hasNpm: false };
  let npmCommand: string | undefined = restoredEnvCache?.npmCommand;
  let npmGlobalBin: string | undefined = restoredEnvCache?.npmGlobalBin;
  if (npmGlobalBin) setNpmGlobalBin(npmGlobalBin);

  const persistEnvCache = (): void => {
    const snapshot: PersistedBackendEnvCache = {
      schemaVersion: 1,
      platform: process.platform,
      ...(inWsl ? { wslIsolated: true } : {}),
      updatedAt: Date.now(),
      nodeEnv,
      ...(npmCommand ? { npmCommand } : {}),
      ...(npmGlobalBin ? { npmGlobalBin } : {}),
      availability: Object.fromEntries(availability),
      installedVersions: Object.fromEntries(installedVersions),
      availableVersions: Object.fromEntries(availableVersions),
      executables: Object.fromEntries(cachedExecutables),
    };
    void platform.globalState.update(BACKEND_ENV_CACHE_KEY, snapshot);
  };

  const savedBackend = (): string | undefined => {
    const raw =
      platform.globalState.get<string>(BACKEND_KEY) ??
      platform.workspaceState.get<string>(BACKEND_KEY) ??
      platform.globalState.get<string>(LEGACY_BACKEND_KEY) ??
      platform.workspaceState.get<string>(LEGACY_BACKEND_KEY);
    if (raw === 'oh-my-pi' && !profiles().some((p) => p.id === 'oh-my-pi')) {
      return 'pi';
    }
    return raw;
  };

  const resolveBackendId = (rawId: string | undefined): string => {
    const trimmed = rawId?.trim();
    if (!trimmed) return DSH_PROFILE.id;
    const mapped = trimmed === 'oh-my-pi' && !profiles().some((p) => p.id === 'oh-my-pi') ? 'pi' : trimmed;
    return profiles().some((p) => p.id === mapped) ? mapped : DSH_PROFILE.id;
  };

  const persistBackendKeys = async (id: string): Promise<void> => {
    await Promise.all([
      platform.globalState.update(BACKEND_KEY, id),
      platform.workspaceState.update(BACKEND_KEY, id),
    ]);
  };

  const initialSavedBackend = savedBackend();
  if (initialSavedBackend && platform.globalState.get<string>(BACKEND_KEY) === undefined) {
    void platform.globalState.update(BACKEND_KEY, initialSavedBackend);
  }
  const initialConfiguredDefault = platform.settings.get<string>('defaultBackend', '').trim();
  let defaultBackendId = resolveBackendId(initialConfiguredDefault || initialSavedBackend || DSH_PROFILE.id);
  let targetBackendId = defaultBackendId;

  const persistDefaultBackend = async (id: string): Promise<void> => {
    const resolved = resolveBackendId(id);
    defaultBackendId = resolved;
    await Promise.all([
      persistBackendKeys(resolved),
      platform.settings.update('defaultBackend', resolved),
    ]);
  };

  // ---- 跨智能体统一会话标签 ----
  const unifiedTabsStorageKey = (): string =>
    folders().length > 1 || workspacePath !== defaultWorkspacePath()
      ? `${UNIFIED_TABS_KEY}:${workspacePath}`
      : UNIFIED_TABS_KEY;

  const unifiedTabs = new UnifiedTabsModel({
    load: () => platform.workspaceState.get<unknown>(unifiedTabsStorageKey()),
    save: (next) => void platform.workspaceState.update(unifiedTabsStorageKey(), next),
  });
  let unifiedTabsRestored = false;
  let suppressTabSync = false;
  let lastPostedTabsJson = '';

  const withSuppressedTabSync = async <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = suppressTabSync;
    suppressTabSync = true;
    try {
      return await fn();
    } finally {
      suppressTabSync = prev;
    }
  };

  const ensureUnifiedTabsRestored = (seedEntry?: ManagedBackend): { readonly restoredFromPersisted: boolean } => {
    if (unifiedTabsRestored) return { restoredFromPersisted: false };
    const currentProfiles = profiles();
    const validBackendIds = new Set(currentProfiles.map((p) => p.id));
    const seedId = seedEntry?.backend.profile.id ?? targetBackendId;
    const snap = seedEntry?.backend.controller.peekSnapshot?.();
    const fallbackTabs = snap?.tabs.items.map((item) => ({
      ...(item.sessionId ? { sessionId: item.sessionId } : {}),
      title: item.title,
    }));
    const fallbackActiveSessionId = snap?.tabs.items.find((item) => item.key === snap.tabs.active)?.sessionId;
    const res = unifiedTabs.restore({
      defaultBackendId: seedId,
      validBackendIds,
      ...(fallbackTabs ? { fallbackTabs } : {}),
      ...(fallbackActiveSessionId ? { fallbackActiveSessionId } : {}),
    });
    unifiedTabsRestored = true;
    return res;
  };

  const buildUnifiedTabsState = (): TabsState => {
    const profileNames = new Map(profiles().map((p) => [p.id, p.name]));
    if (!unifiedTabsRestored || unifiedTabs.items.length === 0) {
      const fallbackId = active?.backend.profile.id ?? targetBackendId;
      const fallbackName = profileNames.get(fallbackId) ?? fallbackId;
      return {
        items: [
          {
            key: 'draft',
            backendId: fallbackId,
            backendName: fallbackName,
            title: t('session.new'),
            running: false,
          },
        ],
        active: 'draft',
      };
    }
    const newTitle = t('session.new');
    return unifiedTabs.view((tab) => {
      const backendName = profileNames.get(tab.backendId) ?? tab.backendId;
      if (!tab.sessionId) {
        return { backendName, title: newTitle, running: false };
      }
      const managed = managedBackends.get(tab.backendId);
      const snap = managed?.backend.controller.peekSnapshot?.();
      let title = tab.cachedTitle || newTitle;
      let running = false;
      let needsAttention = false;
      if (snap) {
        const matchedTab = snap.tabs.items.find((item) => item.sessionId === tab.sessionId);
        const matchedSess = snap.sessions.find((s) => s.id === tab.sessionId);
        if (snap.session.id === tab.sessionId) {
          title = snap.session.title || matchedTab?.title || matchedSess?.title || tab.cachedTitle || newTitle;
          running = snap.session.running;
          needsAttention = snap.interactions.length > 0 || matchedTab?.needsAttention === true || matchedSess?.needsAttention === true;
        } else if (matchedTab) {
          title = matchedTab.title || matchedSess?.title || tab.cachedTitle || newTitle;
          running = matchedTab.running;
          needsAttention = matchedTab.needsAttention === true || matchedSess?.needsAttention === true;
        } else if (matchedSess) {
          title = matchedSess.title || tab.cachedTitle || newTitle;
          running = matchedSess.running;
          needsAttention = matchedSess.needsAttention === true;
        }
        if (title && title !== newTitle) {
          unifiedTabs.updateCachedTitle(tab.backendId, tab.sessionId, title);
        }
      }
      return {
        backendName,
        title,
        running,
        ...(needsAttention ? { needsAttention: true } : {}),
      };
    });
  };

  const withUnifiedTabs = (snapshot: HostSnapshot): HostSnapshot => {
    const curTab = unifiedTabs.current;
    const sid = snapshot.session.id;
    const ckpts = sid ? checkpointsBySession.get(sid) : undefined;
    return {
      ...snapshot,
      session: {
        ...snapshot.session,
        ...(ckpts && ckpts.length > 0 ? { checkpoints: ckpts } : {}),
        ...(curTab?.worktreePath ? { worktreePath: curTab.worktreePath } : {}),
        ...(curTab?.worktreeBranch ? { worktreeBranch: curTab.worktreeBranch } : {}),
      },
      tabs: buildUnifiedTabsState(),
      terminal: terminalManager.getState(),
      browser: browserManager.getState(),
    };
  };

  const pushUnifiedTabs = (force = false): void => {
    if (!isAnyClientVisible()) return;
    const next = buildUnifiedTabsState();
    const json = JSON.stringify(next);
    if (!force && json === lastPostedTabsJson) return;
    lastPostedTabsJson = json;
    post({ type: 'tabs', payload: next });
  };

  const syncUnifiedTabsFromBackendTabs = (backendId: string, backendTabs: TabsState): void => {
    if (suppressTabSync || active?.backend.profile.id !== backendId || !unifiedTabsRestored) return;
    const activeBackendTab = backendTabs.items.find((item) => item.key === backendTabs.active);
    if (!activeBackendTab) return;
    const reportedSessionId = activeBackendTab.sessionId;
    const cur = unifiedTabs.current;
    if (!cur || cur.backendId !== backendId) return;
    const liveTitle = activeBackendTab.title && activeBackendTab.title !== t('session.new') ? activeBackendTab.title : undefined;
    if (!cur.sessionId && reportedSessionId) {
      unifiedTabs.bindCurrentSession(backendId, reportedSessionId, liveTitle);
    } else if (cur.sessionId && !reportedSessionId) {
      unifiedTabs.openNew(backendId);
    } else if (cur.sessionId && reportedSessionId && cur.sessionId !== reportedSessionId) {
      unifiedTabs.open(backendId, reportedSessionId, liveTitle);
    } else if (cur.sessionId && reportedSessionId && liveTitle) {
      unifiedTabs.updateCachedTitle(backendId, reportedSessionId, liveTitle);
    }
  };

  const closeSessionInController = async (backendId: string, sessionId: string | undefined): Promise<void> => {
    if (!sessionId || unifiedTabs.hasSession(backendId, sessionId)) return;
    const managed = managedBackends.get(backendId);
    if (!managed) return;
    const snap = managed.backend.controller.peekSnapshot?.();
    const internalTab = snap?.tabs.items.find((item) => item.sessionId === sessionId);
    if (!internalTab) return;
    await withSuppressedTabSync(() =>
      managed.backend.controller.handle({ type: 'closeTab', payload: { key: internalTab.key } }),
    );
  };

  const backendsState = (): BackendsState => {
    const builtinList = builtins();
    const builtinIds = new Set<string>([DSH_PROFILE.id, ...builtinList.map((b) => b.id)]);
    const rawCustom = platform.settings.get<unknown>('backends', []);
    const customParsed = parseProfiles(rawCustom, () => undefined, []);
    const overriddenIds = new Set(
      customParsed
        .map((p) => p.id)
        .filter((id) => id !== DSH_PROFILE.id && id !== 'zcode' && id !== 'claude' && id !== 'pi' && id !== 'codex' && id !== 'codebuddy' && builtinIds.has(id)),
    );
    return {
      items: profiles().map((p) => {
        const managed = managedBackends.get(p.id);
        const status = managed?.backend.currentStatus();
        const alive =
          status !== undefined &&
          status.kind !== 'idle' &&
          status.kind !== 'notInstalled' &&
          status.kind !== 'untrusted' &&
          status.kind !== 'failed';
        const running = lastBackendRunning.get(p.id) === true;
        const webUrl = managed?.backend.webUrl?.();
        return {
          ...profileView(p, {
            ...(availability.has(p.id) ? { available: availability.get(p.id) } : {}),
            ...(npmOwnership.has(p.id) ? { npmOwned: npmOwnership.get(p.id) } : {}),
            ...(installedVersions.has(p.id) ? { version: installedVersions.get(p.id) } : {}),
            ...(availableVersions.has(p.id) ? { versions: availableVersions.get(p.id) } : {}),
            ...(versionsLoading.has(p.id) ? { versionsLoading: true } : {}),
            ...(versionsError.has(p.id) ? { versionsError: versionsError.get(p.id) } : {}),
            ...(backendBusy.has(p.id) ? { busy: backendBusy.get(p.id) } : {}),
            builtinIds,
            overriddenIds,
          }),
          ...(alive ? { alive: true } : {}),
          ...(running ? { running: true } : {}),
          ...(webUrl ? { webUrl } : {}),
          activeChannel: channelFor(p.id),
        };
      }),
      active: active?.backend.profile.id ?? targetBackendId,
      defaultBackend: defaultBackendId,
      workspace: folders().find((f) => (normalizeProjectPath(f.path) || f.path) === workspacePath)?.name ?? basename(workspacePath),
      nodeEnv,
      registryUrl: platform.settings.get<string>('acpRegistryUrl', ''),
      ...(acpRegistry ? { registry: acpRegistry } : {}),
    };
  };

  // ---- 最近项目与 Worktree 配置 ----
  const readRecentProjects = () => parseRecentProjects(platform.globalState.get<unknown>(RECENT_PROJECTS_KEY));
  const saveRecentProjectPath = async (projectPath: string): Promise<void> => {
    const next = recordRecentProject(readRecentProjects(), projectPath);
    await platform.globalState.update(RECENT_PROJECTS_KEY, next);
  };
  if (folders().length > 0) {
    void saveRecentProjectPath(workspacePath);
  }
  const projectsState = (): ProjectsState =>
    buildProjectsState({
      ...(folders().length > 0 ? { currentPath: workspacePath } : {}),
      recent: readRecentProjects(),
      configs: parseProjectConfigs(platform.settings.get<unknown>('projects', {})),
    });

  let hub: WorkbenchHub | undefined;
  let buildingWorkbenchState = false;
  let pendingModule: WorkbenchModule | undefined;

  const focusView = () => platform.focusChatView();
  const focusModule = async (mod: WorkbenchModule): Promise<void> => {
    pendingModule = mod;
    await focusView();
    post({ type: 'switchWorkbenchModule', payload: { module: mod } });
  };

  const readSchedulePermission = (): SchedulePermissionPreset => {
    const raw = platform.settings.get<string>('schedules.permission', 'danger-full-access');
    return raw === 'workspace-write' || raw === 'read-only' ? raw : 'danger-full-access';
  };

  const readNotificationPreferences = (): NotificationPreferences => ({
    enabled: platform.settings.get<boolean>('notifications.enabled', true),
    onlyWhenUnfocused: platform.settings.get<boolean>('notifications.onlyWhenUnfocused', true),
    onAttention: platform.settings.get<boolean>('notifications.onAttention', true),
    onTurnComplete: platform.settings.get<boolean>('notifications.onTurnComplete', true),
    onUnexpectedExit: platform.settings.get<boolean>('notifications.onUnexpectedExit', true),
    onScheduledComplete: platform.settings.get<boolean>('notifications.onScheduledComplete', true),
  });

  const readAdvancedPreferences = (): AdvancedPreferences => ({
    dshPath: platform.settings.get<string>('dsh.path', ''),
    dshProfile: safeProfile(platform.settings.get<string>('dsh.profile', 'web') || 'web'),
    zcodePath: platform.settings.get<string>('zcode.path', ''),
    claudePath: platform.settings.get<string>('claude.path', ''),
    piPath: platform.settings.get<string>('pi.path', ''),
    codexPath: platform.settings.get<string>('codex.path', ''),
    codebuddyPath: platform.settings.get<string>('codebuddy.path', ''),
    backendTrace: platform.settings.get<boolean>('backendTrace', false),
  });

  const readChatCommands = (): ChatCommand[] => {
    const raw = platform.settings.get<unknown>('chatCommands', []);
    if (!Array.isArray(raw)) return [];
    const result: ChatCommand[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const rawName = typeof obj.name === 'string' ? obj.name.trim().replace(/^\/+/u, '') : '';
      const rawPrompt = typeof obj.prompt === 'string' ? obj.prompt : '';
      const rawDesc = typeof obj.description === 'string' ? obj.description.trim() : '';
      if (!rawName || /\s/u.test(rawName) || !rawPrompt.trim()) continue;
      const key = rawName.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        name: rawName,
        prompt: rawPrompt,
        ...(rawDesc ? { description: rawDesc } : {}),
      });
    }
    return result;
  };

  const readPreferences = (): PreferencesState => {
    const rawLang = platform.settings.get<string>('ui.language', 'auto');
    const language: PreferencesState['language'] = rawLang === 'zh' || rawLang === 'en' ? rawLang : 'auto';
    return {
      language,
      includeActiveEditor: platform.settings.get<boolean>('context.includeActiveEditor', true),
      showTurnChanges: platform.settings.get<boolean>('ui.showTurnChanges', false),
      schedulePermission: readSchedulePermission(),
      notifications: readNotificationPreferences(),
      advanced: readAdvancedPreferences(),
      chatCommands: readChatCommands(),
    };
  };

  const readAppearance = (): AppearanceState => {
    const rawTheme = platform.settings.get<string>('ui.theme', 'dark');
    const theme = rawTheme === 'light' || rawTheme === 'dark' || rawTheme === 'system' ? rawTheme : 'dark';
    const rawPreset = platform.settings.get<string>('ui.preset', 'default');
    const preset: ThemePreset | undefined =
      rawPreset === 'grove' || rawPreset === 'ocean' || rawPreset === 'ember' || rawPreset === 'iris'
        ? rawPreset
        : undefined;
    const highContrast = platform.settings.get<boolean>('ui.highContrast', false);
    const size = platform.settings.get<number>('ui.fontSize', 0);
    const family = platform.settings.get<string>('ui.fontFamily', '').trim();
    const lineHeight = platform.settings.get<number>('ui.lineHeight', 0);
    const paragraphSpacing = platform.settings.get<number>('ui.paragraphSpacing', -1);
    const contentWidth = platform.settings.get<number>('ui.contentWidth', 0);
    const code = platform.settings.get<string>('ui.codeFontFamily', '').trim();
    const terminalFontSize = platform.settings.get<number>('ui.terminalFontSize', 0);
    const terminalLineHeight = platform.settings.get<number>('ui.terminalLineHeight', 0);
    return {
      ...(theme ? { theme } : {}),
      ...(preset ? { preset } : {}),
      ...(highContrast ? { highContrast: true } : {}),
      ...(Number.isFinite(size) && size > 0 ? { fontSize: Math.min(32, Math.max(8, Math.round(size))) } : {}),
      ...(family ? { fontFamily: family } : {}),
      ...(Number.isFinite(lineHeight) && lineHeight > 0
        ? { lineHeight: Math.min(2.4, Math.max(1.2, Number(lineHeight.toFixed(2)))) }
        : {}),
      ...(Number.isFinite(paragraphSpacing) && paragraphSpacing >= 0
        ? { paragraphSpacing: Math.min(32, Math.max(0, Math.round(paragraphSpacing))) }
        : {}),
      ...(Number.isFinite(contentWidth) && contentWidth > 0
        ? { contentWidth: Math.min(1600, Math.max(520, Math.round(contentWidth))) }
        : {}),
      ...(code ? { codeFontFamily: code } : {}),
      ...(Number.isFinite(terminalFontSize) && terminalFontSize > 0
        ? { terminalFontSize: Math.min(24, Math.max(9, Math.round(terminalFontSize))) }
        : {}),
      ...(Number.isFinite(terminalLineHeight) && terminalLineHeight > 0
        ? { terminalLineHeight: Math.min(2.4, Math.max(1.1, Number(terminalLineHeight.toFixed(2)))) }
        : {}),
    };
  };

  const pushBackends = (): void => {
    post({ type: 'backends', payload: backendsState() });
    hub?.schedulePush();
  };
  const pushProjects = (): void => {
    post({ type: 'projects', payload: projectsState() });
    hub?.schedulePush();
  };

  let switchBackendFn: (id: string, forceReload?: boolean) => Promise<void> = async () => undefined;
  let openSessionInActiveFn: (
    payload: Extract<WebviewToHost, { type: 'switchSession' }>['payload'],
  ) => Promise<void> = async () => undefined;

  const notifierFor = (backendId: string): NotificationDispatcher => {
    let dispatcher = notifiers.get(backendId);
    if (!dispatcher) {
      dispatcher = new NotificationDispatcher({
        isWindowFocused: () => platform.isWindowFocused(),
        getPreferences: readNotificationPreferences,
        actionLabel: () => t('notify.openSession'),
        onRemoteNotify: async (event, options) => {
          const externalUrl = remoteBridgeBox.current?.buildSessionUrl(event.sessionId);
          await pushService.dispatch(
            {
              kind: event.kind,
              title: 'Halo',
              body: event.message,
              ...(event.sessionId
                ? { sessionId: event.sessionId, url: `/?session=${encodeURIComponent(event.sessionId)}` }
                : { url: '/' }),
              ...(externalUrl ? { externalUrl } : {}),
            },
            options,
          );
        },
        showNotification: async (level, message, actionLabel) => {
          const choice = await platform.showMessage(level, message, [actionLabel]);
          return choice === actionLabel;
        },
        openSession: async (sessionId) => {
          await focusView();
          if (active?.backend.profile.id !== backendId) {
            await switchBackendFn(backendId);
          }
          post({ type: 'navigateToSession', payload: sessionId ? { sessionId } : {} });
          if (sessionId) {
            await openSessionInActiveFn({ sessionId });
          }
        },
      });
      notifiers.set(backendId, dispatcher);
    }
    return dispatcher;
  };

  // ---- 第三方服务商（Coding Plan 与自定义网关）、官方多账号与渠道路由 ----
  const providerHasKey = new Set<string>();
  const apiKeyCache = new Map<string, string>();
  const selectedProviderModels = new Map<string, string>();
  const readProviders = () => parseProvidersSetting(platform.settings.get<unknown>('providers', []));
  const readAccounts = () => parseAccountsSetting(platform.settings.get<unknown>('accounts', []));
  const readBackendChannels = () =>
    parseBackendChannelsSetting(platform.settings.get<unknown>('backendChannels', {}));
  const readProtocolGatewayEnabled = (): boolean =>
    platform.settings.get<boolean>('protocolGateway', false) === true;

  const accountInspections = new Map<string, AccountInspectionResult & { readonly checkedAt: number }>();
  const accountRevision = new Map<string, number>();
  let accountsChecking = false;
  const SYSTEM_ACCOUNT_LABELS_KEY = 'harnessDeck.systemAccountLabels';
  const readSystemAccountLabels = (): Record<string, string> => {
    const raw = platform.globalState.get<unknown>(SYSTEM_ACCOUNT_LABELS_KEY);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof val === 'string' && val.trim()) out[key] = val.trim();
    }
    return out;
  };
  const saveSystemAccountLabel = async (sysId: string, rawLabel: string): Promise<void> => {
    const next = readSystemAccountLabels();
    const clean = rawLabel.trim();
    if (clean && clean !== t('account.systemDefault')) {
      next[sysId] = clean;
    } else {
      delete next[sysId];
    }
    await platform.globalState.update(SYSTEM_ACCOUNT_LABELS_KEY, next);
  };
  const isAutoAccountLabel = (label: string, backendName: string): boolean => {
    const escaped = backendName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return new RegExp(`^${escaped}\\s+#\\d+$`, 'u').test(label.trim());
  };
  const nextAutoAccountLabel = (backendId: string, existing: readonly AccountConfig[]): string => {
    const name = profiles().find((p) => p.id === backendId)?.name ?? backendId;
    const used = new Set(existing.filter((a) => a.backendId === backendId).map((a) => a.label));
    let n = existing.filter((a) => a.backendId === backendId).length + 2;
    while (used.has(`${name} #${n}`)) n += 1;
    return `${name} #${n}`;
  };

  let lastActiveAntigravityAccountId: string | undefined;
  let lastActiveCodebuddyAccountId: string | undefined;

  const currentSlotOwner = (backendId: string): string | undefined => {
    const lower = backendId.toLowerCase();
    if (lower === 'antigravity') {
      return (
        lastActiveAntigravityAccountId ??
        activeOfficialAccountId(backendId, readBackendChannels(), readProviders(), readAccounts())
      );
    }
    if (lower === 'codebuddy') {
      return (
        lastActiveCodebuddyAccountId ??
        activeOfficialAccountId(backendId, readBackendChannels(), readProviders(), readAccounts())
      );
    }
    return undefined;
  };

  const bumpAccountRevision = (backendId: string): void => {
    accountRevision.set(backendId, (accountRevision.get(backendId) ?? 0) + 1);
  };

  const channelFor = (backendId: string): BackendChannelBinding =>
    resolveBackendChannel(backendId, readBackendChannels(), readProviders(), readAccounts());

  const effectiveProviderFor = (backendId: string) =>
    effectiveProviderForBackend(backendId, readBackendChannels(), readProviders(), readAccounts());

  const boundProviderSignatureFor = (backendId: string): string => {
    const providers = readProviders();
    const accounts = readAccounts();
    const channels = readBackendChannels();
    const channel = resolveBackendChannel(backendId, channels, providers, accounts);
    const provider = effectiveProviderForBackend(backendId, channels, providers, accounts);
    const activeAcc =
      channel.mode === 'official' && channel.accountId && !isSystemAccountId(channel.accountId)
        ? accounts.find((a) => a.id === channel.accountId)
        : undefined;
    return JSON.stringify({
      channel,
      provider: provider ?? null,
      account: activeAcc ?? null,
      rev: accountRevision.get(backendId) ?? 0,
      gateway: readProtocolGatewayEnabled(),
    });
  };

  const accountsState = (): AccountsState => {
    const profileList = profiles();
    const configured = readAccounts();
    const systemLabels = readSystemAccountLabels();
    const providers = readProviders();
    const rawChannels = readBackendChannels();
    const loginProg = accountAuthFlow.progress;

    const channels: Record<string, BackendChannelBinding> = {};
    const items: AccountView[] = [];

    for (const profile of profileList) {
      channels[profile.id] = resolveBackendChannel(profile.id, rawChannels, providers, configured);

      const sysId = systemAccountId(profile.id);
      const sysInsp = accountInspections.get(sysId);
      const sysLoggingIn =
        loginProg?.accountId === sysId &&
        (loginProg.phase === 'starting' ||
          loginProg.phase === 'waiting-browser' ||
          loginProg.phase === 'waiting-terminal' ||
          loginProg.phase === 'verifying');
      const sysDisplayLabel =
        systemLabels[sysId] ||
        (sysInsp?.identity && !sysInsp.identity.includes('…') ? sysInsp.identity : undefined) ||
        t('account.systemDefault');
      items.push({
        id: sysId,
        backendId: profile.id,
        label: sysDisplayLabel,
        isSystemDefault: true,
        status: sysLoggingIn ? 'logging-in' : (sysInsp?.status ?? 'unknown'),
        ...(sysInsp?.identity ? { identity: sysInsp.identity } : {}),
        ...(sysInsp?.plan ? { plan: sysInsp.plan } : {}),
        ...(sysInsp?.expiresAt !== undefined ? { expiresAt: sysInsp.expiresAt } : {}),
        ...(sysInsp?.hasSecret !== undefined ? { hasSecret: sysInsp.hasSecret } : {}),
        ...(sysInsp?.hasUsageCookie !== undefined ? { hasUsageCookie: sysInsp.hasUsageCookie } : {}),
        ...(sysInsp?.quota ? { quota: sysInsp.quota } : {}),
        ...(sysInsp?.checkedAt !== undefined ? { checkedAt: sysInsp.checkedAt } : {}),
        ...(sysInsp?.error ? { error: sysInsp.error } : {}),
      });

      for (const acc of configured.filter((a) => a.backendId === profile.id)) {
        const insp = accountInspections.get(acc.id);
        const loggingIn =
          loginProg?.accountId === acc.id &&
          (loginProg.phase === 'starting' ||
            loginProg.phase === 'waiting-browser' ||
            loginProg.phase === 'waiting-terminal' ||
            loginProg.phase === 'verifying');
        const resolvedLabel =
          isAutoAccountLabel(acc.label, profile.name) && insp?.identity && !insp.identity.includes('…')
            ? insp.identity
            : acc.label;
        items.push({
          id: acc.id,
          backendId: acc.backendId,
          label: resolvedLabel,
          ...(acc.isolateSessions ? { isolateSessions: true } : {}),
          ...(acc.region ? { region: acc.region } : {}),
          status: loggingIn ? 'logging-in' : (insp?.status ?? 'unknown'),
          ...(insp?.identity ? { identity: insp.identity } : {}),
          ...(insp?.plan ? { plan: insp.plan } : {}),
          ...(insp?.expiresAt !== undefined ? { expiresAt: insp.expiresAt } : {}),
          ...(insp?.hasSecret !== undefined ? { hasSecret: insp.hasSecret } : {}),
          ...(insp?.hasUsageCookie !== undefined ? { hasUsageCookie: insp.hasUsageCookie } : {}),
          ...(insp?.quota ? { quota: insp.quota } : {}),
          ...(insp?.checkedAt !== undefined ? { checkedAt: insp.checkedAt } : {}),
          createdAt: acc.createdAt,
          ...(insp?.error ? { error: insp.error } : {}),
        });
      }
    }

    return {
      items,
      channels,
      ...(loginProg ? { loginProgress: loginProg } : {}),
      ...(accountsChecking ? { checking: true } : {}),
    };
  };

  const pushAccounts = (): void => {
    const payload = accountsState();
    if (active?.backend.controller.accountsChanged) {
      active.backend.controller.accountsChanged();
    } else {
      post({ type: 'accounts', payload });
    }
    for (const entry of managedBackends.values()) {
      if (entry !== active) {
        entry.backend.controller.accountsChanged?.();
      }
    }
    pushBackends();
  };

  const inspectOneAccount = async (
    backendId: string,
    accountId: string,
    account: AccountConfig | undefined,
    includeQuota = false,
  ): Promise<void> => {
    const clientVersion = installedVersions.get(backendId);
    const activeAccountId = activeOfficialAccountId(backendId, readBackendChannels(), readProviders(), readAccounts());
    const res = await inspectOfficialAccount({
      backendId,
      accountId,
      ...(account ? { account } : {}),
      isActiveSlot: activeAccountId === accountId,
      storageRoot,
      baseEnv: processEnv(),
      secrets: platform.secrets,
      includeQuota,
      getHttpProxy: () => platform.settings.getHttpProxy(),
      ...(clientVersion ? { clientVersion } : {}),
    });
    const prev = accountInspections.get(accountId);
    const mergedIdentity = res.identity ?? (!includeQuota && res.status === 'authenticated' ? prev?.identity : undefined);
    accountInspections.set(accountId, {
      ...res,
      ...(mergedIdentity ? { identity: mergedIdentity } : {}),
      ...(!includeQuota && prev?.quota && res.status === 'authenticated' ? { quota: prev.quota } : {}),
      checkedAt: Date.now(),
    });
    // 若用户新增账号时留空名称（使用自动占位名），登录识别出真实邮箱/用户名后自动回写，免去手动命名
    if (account && mergedIdentity && !mergedIdentity.includes('…')) {
      const profileName = profiles().find((p) => p.id === backendId)?.name ?? backendId;
      if (isAutoAccountLabel(account.label, profileName)) {
        const currentAccounts = readAccounts();
        const existingAcc = currentAccounts.find((a) => a.id === account.id);
        if (existingAcc && isAutoAccountLabel(existingAcc.label, profileName)) {
          const { accounts: renamed } = upsertAccountSetting(currentAccounts, {
            id: existingAcc.id,
            backendId: existingAcc.backendId,
            label: mergedIdentity,
            ...(existingAcc.isolateSessions ? { isolateSessions: true } : {}),
            ...(existingAcc.region ? { region: existingAcc.region } : {}),
          });
          await writeSetting(undefined, 'accounts', renamed);
        }
      }
    }
  };

  const refreshAccountInspections = async (options?: {
    readonly backendId?: string;
    readonly includeQuota?: boolean;
  }): Promise<void> => {
    accountsChecking = true;
    pushAccounts();
    try {
      const configured = readAccounts();
      const targets = options?.backendId
        ? profiles().filter((p) => p.id === options.backendId)
        : profiles();
      const jobs: Promise<void>[] = [];
      for (const p of targets) {
        const sysId = systemAccountId(p.id);
        jobs.push(inspectOneAccount(p.id, sysId, undefined, options?.includeQuota === true));
        for (const acc of configured.filter((a) => a.backendId === p.id)) {
          jobs.push(inspectOneAccount(p.id, acc.id, acc, options?.includeQuota === true));
        }
      }
      await Promise.all(jobs);
    } finally {
      accountsChecking = false;
      pushAccounts();
    }
  };

  let syncManagedBackendsForChannelChange = (_targetBackendId?: string): void => undefined;

  const accountAuthFlow = new AccountAuthFlowManager({
    storageRoot: platform.storageRoot,
    workspacePath: () => workspacePath,
    processEnv: () => processEnv(),
    settingsGet: (k, def) => platform.settings.get(k, def),
    secrets: platform.secrets,
    openExternal: (url) => platform.openExternal(url),
    runInTerminal: (opts) => platform.runInTerminal(opts),
    log,
    onProgress: (progress: AccountLoginProgress | undefined) => {
      post({ type: 'accountLoginProgress', payload: progress });
      pushAccounts();
    },
    onComplete: async (accountId, backendId) => {
      const lowerBackend = backendId.toLowerCase();
      const currentBinding = channelFor(backendId);
      const activeId = currentBinding.mode === 'official' ? (currentBinding.accountId ?? systemAccountId(backendId)) : undefined;
      if (lowerBackend === 'antigravity') {
        lastActiveAntigravityAccountId = accountId;
        if (activeId && activeId !== accountId) {
          const restored = await switchAntigravityCredentialSlot({
            targetAccountId: activeId,
            previousAccountId: accountId,
            secrets: platform.secrets,
            env: processEnv(),
          });
          if (restored.activated) lastActiveAntigravityAccountId = activeId;
        }
      } else if (lowerBackend === 'codebuddy') {
        lastActiveCodebuddyAccountId = accountId;
        if (activeId && activeId !== accountId) {
          const restored = await switchCodebuddyCredentialSlot({
            targetAccountId: activeId,
            previousAccountId: accountId,
            secrets: platform.secrets,
            env: processEnv(),
          });
          if (restored.activated) lastActiveCodebuddyAccountId = activeId;
        }
      }
      clearQuotaCacheFor(quotaProviderFor(profiles().find((p) => p.id === backendId)));
      const acc = readAccounts().find((a) => a.id === accountId);
      await inspectOneAccount(backendId, accountId, acc, true);
      bumpAccountRevision(backendId);
      if (activeId === accountId) {
        syncManagedBackendsForChannelChange(backendId);
      }
      pushAccounts();
      post({ type: 'toast', payload: { level: 'info', text: t('account.loginSucceeded') } });
    },
  });

  let gatewayLogTimer: ReturnType<typeof setTimeout> | undefined;
  let scheduleGatewayLogPush = (): void => undefined;

  const providerProxy = new ProviderProxy({
    getProvider: (id) => readProviders().find((p) => p.id === id),
    getApiKey: async (id) => {
      const cached = apiKeyCache.get(id);
      if (cached !== undefined) return cached;
      const stored = (await platform.secrets.get(providerSecretKey(id)))?.trim();
      if (stored) {
        apiKeyCache.set(id, stored);
        providerHasKey.add(id);
      }
      return stored;
    },
    getSelectedModel: (id) => selectedProviderModels.get(id),
    isProtocolGatewayEnabled: readProtocolGatewayEnabled,
    getHttpProxy: () => platform.settings.getHttpProxy(),
    log,
    onLogChange: () => scheduleGatewayLogPush(),
  });

  const providersState = (): ProvidersState =>
    buildProvidersState(readProviders(), providerHasKey, {
      protocolGatewayEnabled: readProtocolGatewayEnabled(),
      ...(providerProxy.origin ? { protocolGatewayOrigin: providerProxy.origin } : {}),
      gatewayLogs: providerProxy.getLogs(),
    });

  const pushProviders = (): void => {
    if (active?.backend.controller.providersChanged) {
      active.backend.controller.providersChanged();
    } else {
      post({ type: 'providers', payload: providersState() });
    }
    for (const entry of managedBackends.values()) {
      if (entry !== active) {
        entry.backend.controller.providersChanged?.();
      }
    }
    hub?.schedulePush();
  };

  scheduleGatewayLogPush = (): void => {
    if (gatewayLogTimer) return;
    gatewayLogTimer = setTimeout(() => {
      gatewayLogTimer = undefined;
      pushProviders();
    }, 30);
    gatewayLogTimer.unref?.();
  };

  if (readProtocolGatewayEnabled()) {
    void providerProxy
      .ensureStarted()
      .then(() => pushProviders())
      .catch((err: unknown) => log(`启动本地协议转换网关失败：${String(err)}`));
  }

  const refreshProviderSecretFlags = async (): Promise<void> => {
    const list = readProviders();
    await Promise.all(
      list.map(async (p) => {
        const val = (await platform.secrets.get(providerSecretKey(p.id)))?.trim();
        if (val) {
          apiKeyCache.set(p.id, val);
          providerHasKey.add(p.id);
        } else {
          apiKeyCache.delete(p.id);
          providerHasKey.delete(p.id);
        }
      }),
    );
  };
  void refreshProviderSecretFlags().then(() => pushProviders());

  disposers.push(
    platform.secrets.onDidChange((changedKey) => {
      void (async () => {
        for (const p of readProviders()) {
          if (changedKey === providerSecretKey(p.id)) {
            const val = (await platform.secrets.get(changedKey))?.trim();
            if (val) {
              apiKeyCache.set(p.id, val);
              providerHasKey.add(p.id);
            } else {
              apiKeyCache.delete(p.id);
              providerHasKey.delete(p.id);
            }
            pushProviders();
          }
        }
      })();
    }),
  );

  // ---- 扩展模块（Agent Skills 与统一 MCP 服务器管理） ----
  const storageRoot = platform.storageRoot;
  let installedSkills: InstalledSkillView[] = [];
  const skillBusy = new Map<string, 'updating' | 'removing'>();
  let skillsInstalling = false;
  let skillsScanning = false;
  let skillsScanned:
    | { readonly repoUrl: string; readonly ref?: string; readonly skills: readonly DiscoveredGitSkill[] }
    | undefined;
  let skillsScanningImport = false;
  let skillImportCandidates: readonly SkillImportCandidate[] | undefined;
  let skillScannedSources: readonly string[] | undefined;
  let skillsError: string | undefined;

  const readMcpServers = () => parseMcpServersSetting(platform.settings.get<unknown>('mcpServers', []));
  const readEffectiveMcpServers = (): readonly McpServerConfig[] => {
    const userServers = readMcpServers();
    if (!browserManager.isAiEnabled() || !browserMcpServer.url) return userServers;
    const allAgents = profiles().map((p) => p.id);
    return [
      ...userServers,
      buildBuiltinBrowserMcpConfig({
        mcpUrl: browserMcpServer.url,
        token: browserMcpServer.token,
        ...(browserMcpBridgePath ? { bridgeScriptPath: browserMcpBridgePath } : {}),
        agents: allAgents,
      }),
    ];
  };
  let mcpScanningImport = false;
  let mcpImportCandidates: readonly McpImportCandidate[] | undefined;
  let mcpScannedSources: readonly string[] | undefined;
  let skillMarket: SkillMarketState | undefined;
  let skillMarketSeq = 0;
  let mcpMarket: McpMarketState | undefined;
  let mcpMarketSeq = 0;

  const extensionsState = (): ExtensionsState => ({
    skills: {
      items: installedSkills.map((s) => {
        const busy = skillBusy.get(s.id);
        return busy ? { ...s, busy } : s;
      }),
      ...(skillsInstalling ? { installing: true } : {}),
      ...(skillsScanning ? { scanning: true } : {}),
      ...(skillsScanned ? { scanned: skillsScanned } : {}),
      ...(skillsScanningImport ? { scanningImport: true } : {}),
      ...(skillImportCandidates !== undefined ? { importCandidates: skillImportCandidates } : {}),
      ...(skillScannedSources !== undefined ? { scannedSources: skillScannedSources } : {}),
      ...(skillMarket ? { market: skillMarket } : {}),
      ...(skillsError ? { error: skillsError } : {}),
    },
    mcp: {
      servers: readMcpServers(),
      ...(mcpScanningImport ? { scanningImport: true } : {}),
      ...(mcpImportCandidates !== undefined ? { importCandidates: mcpImportCandidates } : {}),
      ...(mcpScannedSources !== undefined ? { scannedSources: mcpScannedSources } : {}),
      ...(mcpMarket ? { market: mcpMarket } : {}),
    },
  });

  const pushExtensions = (): void => {
    if (active?.backend.controller.extensionsChanged) {
      active.backend.controller.extensionsChanged();
    } else {
      post({ type: 'extensions', payload: extensionsState() });
    }
    for (const entry of managedBackends.values()) {
      if (entry !== active) {
        entry.backend.controller.extensionsChanged?.();
      }
    }
  };

  let checking: Promise<void> | undefined;
  let checkDirty = false;
  const checkAvailability = (): Promise<void> => {
    checkDirty = true;
    return (checking ??= (async () => {
      while (checkDirty) {
        checkDirty = false;
        const osPlatform = process.platform;
        const dshPath = platform.settings.get<string>('dsh.path', '');
        const zcodePath = platform.settings.get<string>('zcode.path', '');
        const claudePath = platform.settings.get<string>('claude.path', '');
        const piPath = platform.settings.get<string>('pi.path', '');
        const codexPath = platform.settings.get<string>('codex.path', '');
        const codebuddyPath = platform.settings.get<string>('codebuddy.path', '');
        const detected = await detectNodeEnv({ env: processEnv(), platform: osPlatform });
        nodeEnv = detected.state;
        npmCommand = detected.npmCommand;
        npmGlobalBin = detected.npmGlobalBin;
        setNpmGlobalBin(npmGlobalBin);

        const npmPackages = npmCommand ? await listNpmGlobalPackages(npmCommand, processEnv(), osPlatform) : {};

        await Promise.all(
          profiles().map(async (p) => {
            const cmdSpec = commandSpecForProfile(p, dshPath, zcodePath, claudePath, piPath, codexPath, codebuddyPath);
            let isAvailable = false;
            let resolvedTarget: string | undefined;
            let isZcodeScript = false;

            if (p.kind === 'dsh') {
              const located = await locateDsh({ configuredPath: dshPath, env: processEnv(), platform: osPlatform });
              if (located.kind === 'found') {
                isAvailable = true;
                resolvedTarget = located.command;
              }
            } else if (p.kind === 'zcode') {
              const located = await locateZcode({
                configuredPath: zcodePath,
                env: processEnv(),
                platform: osPlatform,
                fallbackNodePath: process.execPath,
              });
              if (located.kind === 'found') {
                isAvailable = true;
                resolvedTarget = located.targetPath;
                isZcodeScript = located.scriptArgs.length > 0;
              }
            } else if (p.kind === 'claude') {
              const located = await locateClaude({
                configuredPath: claudePath,
                env: processEnv(),
                platform: osPlatform,
              });
              if (located.kind === 'found') {
                isAvailable = true;
                resolvedTarget = located.command;
              }
            } else if (p.kind === 'pi') {
              const located = await locatePi({
                configuredPath: piPath,
                env: processEnv(),
                platform: osPlatform,
              });
              if (located.kind === 'found') {
                isAvailable = true;
                resolvedTarget = located.command;
              }
            } else if (p.kind === 'codex') {
              const located = await locateCodex({
                configuredPath: codexPath,
                env: processEnv(),
                platform: osPlatform,
              });
              if (located.kind === 'found') {
                isAvailable = true;
                resolvedTarget = located.command;
              }
            } else if (p.kind === 'codebuddy') {
              const located = await locateCodebuddy({
                configuredPath: codebuddyPath,
                env: processEnv(),
                platform: osPlatform,
              });
              if (located.kind === 'found') {
                isAvailable = true;
                resolvedTarget = located.command;
              }
            } else {
              const acpEnv = processEnv(p.env);
              const located = await locateExecutable(p.command, {
                env: acpEnv,
                platform: osPlatform,
                extraDirs: extraSearchDirsForCommand(p.command, acpEnv, osPlatform),
              });
              if (located.kind === 'found') {
                isAvailable = true;
                resolvedTarget = located.command;
              }
            }

            availability.set(p.id, isAvailable);
            const pkg = npmPackageFor(p.id);
            if (isAvailable && pkg) {
              const owned = await checkNpmOwnership({
                packageName: pkg,
                installedPackages: npmPackages,
                ...(resolvedTarget ? { executable: resolvedTarget } : {}),
                ...(npmGlobalBin ? { npmGlobalBin } : {}),
                platform: osPlatform,
              });
              npmOwnership.set(p.id, owned);
            } else {
              npmOwnership.delete(p.id);
            }
            let version = pkg
              ? (npmPackages[pkg] ?? (p.id === 'pi' ? npmPackages['@mariozechner/pi-coding-agent'] : undefined))
              : undefined;
            if (
              !version &&
              isAvailable &&
              resolvedTarget &&
              (p.kind === 'dsh' ||
                p.kind === 'claude' ||
                p.kind === 'pi' ||
                p.kind === 'codex' ||
                p.kind === 'codebuddy' ||
                p.id === 'antigravity' ||
                (p.kind === 'zcode' && !isZcodeScript))
            ) {
              version = await probeCommandVersion(
                resolvedTarget,
                p.kind === 'acp' ? processEnv(p.env) : processEnv(),
                osPlatform,
              );
            }
            if (version) installedVersions.set(p.id, version);
            else installedVersions.delete(p.id);

            if (isAvailable && resolvedTarget) {
              const statMeta =
                p.kind === 'zcode'
                  ? await verifyZcodeTarget(resolvedTarget, osPlatform)
                  : await verifyExecutableFile(resolvedTarget, osPlatform);
              const mergedVer = version ?? cachedExecutables.get(p.id)?.version;
              cachedExecutables.set(p.id, {
                commandSpec: cmdSpec,
                command: resolvedTarget,
                ...(mergedVer ? { version: mergedVer } : {}),
                ...(statMeta ? { mtimeMs: statMeta.mtimeMs, size: statMeta.size } : {}),
              });
            } else {
              cachedExecutables.delete(p.id);
            }
          }),
        );
        persistEnvCache();
        pushBackends();
        if (
          isAnyClientVisible() &&
          active?.backend.currentStatus().kind === 'notInstalled' &&
          availability.get(active.backend.profile.id) === true
        ) {
          active.backend.start();
        }
      }
    })()
      .catch((error: unknown) => log(`检查底层是否安装失败：${String(error)}`))
      .finally(() => {
        checking = undefined;
      }));
  };

  const updateStatusBar = (): void => {
    const fallbackName = profiles().find((p) => p.id === targetBackendId)?.name ?? DSH_PROFILE.name;
    const backendName = active?.backend.profile.name ?? fallbackName;
    const status: RuntimeStatus = active?.backend.currentStatus() ?? { kind: 'idle' };
    platform.onStatusUpdate({
      backendName,
      status,
      ...(active?.modelLabel ? { modelLabel: active.modelLabel } : {}),
      ...(remoteBridgeBox.current
        ? {
            remote: {
              enabled: remoteBridgeBox.current.isEnabled,
              running: remoteBridgeBox.current.isRunning,
              connectedClients: clientHub.remoteClientCount(),
            },
          }
        : {}),
    });
  };
  updateStatusBarRef = updateStatusBar;

  const writeSetting = async (sub: string | undefined, key: string, value: unknown): Promise<void> => {
    const fullKey = sub ? `${sub}.${key}` : key;
    await platform.settings.update(fullKey, value);
  };

  const applyAppearancePatch = async (
    patch: Extract<WebviewToHost, { type: 'setAppearance' }>['payload'],
  ): Promise<void> => {
    for (const [key, value] of Object.entries(patch) as [string, number | string | boolean | null | undefined][]) {
      if (value === undefined) continue;
      const cleared =
        value === null ||
        value === '' ||
        (key === 'theme' && value === 'dark') ||
        (key === 'preset' && value === 'default') ||
        (key === 'highContrast' && value === false) ||
        (key === 'paragraphSpacing' && typeof value === 'number' && value < 0) ||
        (key !== 'paragraphSpacing' && typeof value === 'number' && value <= 0);
      await writeSetting('ui', key, cleared ? undefined : value);
    }
  };

  const applyPreferencesPatch = async (
    patch: Extract<WebviewToHost, { type: 'setPreferences' }>['payload'],
  ): Promise<void> => {
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
      if (patch.advanced.zcodePath !== undefined) {
        await writeSetting('zcode', 'path', patch.advanced.zcodePath.trim() || undefined);
      }
      if (patch.advanced.claudePath !== undefined) {
        await writeSetting('claude', 'path', patch.advanced.claudePath.trim() || undefined);
      }
      if (patch.advanced.piPath !== undefined) {
        await writeSetting('pi', 'path', patch.advanced.piPath.trim() || undefined);
      }
      if (patch.advanced.codexPath !== undefined) {
        await writeSetting('codex', 'path', patch.advanced.codexPath.trim() || undefined);
      }
      if (patch.advanced.codebuddyPath !== undefined) {
        await writeSetting('codebuddy', 'path', patch.advanced.codebuddyPath.trim() || undefined);
      }
      if (patch.advanced.backendTrace !== undefined) {
        await writeSetting(undefined, 'backendTrace', patch.advanced.backendTrace);
      }
    }
    if (patch.chatCommands !== undefined) {
      await writeSetting(undefined, 'chatCommands', patch.chatCommands.length > 0 ? patch.chatCommands : undefined);
    }
  };

  const idleSnapshot = (): HostSnapshot => ({
    hostKind: platform.hostKind,
    runtime: backendBusy.has(targetBackendId) ? { kind: 'starting' } : { kind: 'idle' },
    connection: 'idle',
    sessions: [],
    tabs: buildUnifiedTabsState(),
    session: { title: t('session.new'), running: false, hasOlder: false, loadingOlder: false, sync: 'idle' },
    items: [],
    models: { options: [] },
    interactions: [],
    permissions: { options: [] },
    workspace: { dirtyFiles: platform.workbench.dirtyFiles().length },
    context: {
      includeActiveByDefault: platform.settings.get<boolean>('context.includeActiveEditor', true),
      pinned: [],
    },
    commands: [],
    locale: getLocale(),
    appearance: readAppearance(),
    preferences: readPreferences(),
    backends: backendsState(),
    providers: providersState(),
    accounts: accountsState(),
    projects: projectsState(),
    extensions: extensionsState(),
    ...(hub ? { workbench: hub.state() } : {}),
    ...(remoteBridgeBox.current ? { remote: remoteBridgeBox.current.getState() } : {}),
    terminal: terminalManager.getState(),
    browser: browserManager.getState(),
  });

  const selectFolderCommand = async (): Promise<void> => {
    const list = folders();
    if (list.length < 2) {
      void platform.showMessage('info', t('ext.singleFolder'));
      return;
    }
    const picked = await platform.pickQuickItem(
      list.map((f) => {
        const norm = normalizeProjectPath(f.path) || f.path;
        return { id: norm, label: f.name, description: f.path, picked: norm === workspacePath };
      }),
      { placeHolder: t('ext.selectFolder') },
    );
    if (!picked) return;
    const nextPath = normalizeProjectPath(picked.id) || picked.id;
    if (nextPath === workspacePath) return;
    workspacePath = nextPath;
    await platform.workspaceState.update(FOLDER_KEY, workspacePath);
    await saveRecentProjectPath(workspacePath);
    unifiedTabsRestored = false;
    if (active) {
      active.workspacePath = workspacePath;
      active.lastObservedSessionId = undefined;
      notifierFor(active.backend.profile.id).reset();
      active.backend.controller.setWorkspace(workspacePath);
      ensureUnifiedTabsRestored(active);
      active.backend.controller.backendsChanged();
      pushUnifiedTabs(true);
    }
    pushProjects();
    void hub?.refreshSourceControl();
  };

  const postForBackend = (backendId: string, message: HostToWebview): void => {
    if (message.type === 'tabs') {
      syncUnifiedTabsFromBackendTabs(backendId, message.payload);
      pushUnifiedTabs();
      return;
    }
    if (message.type === 'snapshot') {
      if (active?.backend.profile.id === backendId) {
        const patched = withUnifiedTabs(message.payload);
        lastPostedTabsJson = JSON.stringify(patched.tabs);
        post({ type: 'snapshot', payload: patched });
        const sid = patched.session.id;
        if (sid && !checkpointsBySession.has(sid)) {
          void refreshSessionCheckpoints(active.workspacePath ?? workspacePath, sid);
        }
      }
      return;
    }
    if (message.type === 'session') {
      if (active?.backend.profile.id === backendId) {
        const curTab = unifiedTabs.current;
        const sid = message.payload.id;
        const ckpts = sid ? checkpointsBySession.get(sid) : undefined;
        post({
          type: 'session',
          payload: {
            ...message.payload,
            ...(ckpts && ckpts.length > 0 ? { checkpoints: ckpts } : {}),
            ...(curTab?.worktreePath ? { worktreePath: curTab.worktreePath } : {}),
            ...(curTab?.worktreeBranch ? { worktreeBranch: curTab.worktreeBranch } : {}),
          },
        });
        if (sid && !checkpointsBySession.has(sid)) {
          void refreshSessionCheckpoints(active.workspacePath ?? workspacePath, sid);
        }
      }
      pushUnifiedTabs();
      return;
    }
    if (active?.backend.profile.id === backendId || message.type === 'toast') {
      post(message);
    }
    if (message.type === 'sessions' || message.type === 'interactions') {
      pushUnifiedTabs();
    }
  };

  const hostFor = (profile: BackendProfile): BackendHost => ({
    globalState: platform.globalState,
    workspaceState: platform.workspaceState,
    storageRoot,
    extensionVersion: platform.extensionVersion,
    settings: platform.settings,
    isWorkspaceTrusted: () => platform.isWorkspaceTrusted(),
    processEnv,
    openExternal: (url) => platform.openExternal(url),
    resolveExternalOrigin: (origin) => platform.resolveExternalOrigin(origin),
    writeClipboard: (text) => platform.writeClipboard(text),
    showMessage: (level, message, actions) => platform.showMessage(level, message, actions),
    pickQuickItem: (items, options) => platform.pickQuickItem(items, options),
    withCancellableProgress: (title, task) => platform.withCancellableProgress(title, task),
    log,
    runtimeLog,
    workspacePath: () => managedBackends.get(profile.id)?.workspacePath ?? workspacePath,
    stateKey: (name) => {
      const targetWs = managedBackends.get(profile.id)?.workspacePath ?? workspacePath;
      return folders().length > 1 || targetWs !== defaultWorkspacePath() ? `${name}:${targetWs}` : name;
    },
    onStatus: (nextStatus) => {
      if (active?.backend.profile.id === profile.id) {
        updateStatusBar();
      }
      const entry = managedBackends.get(profile.id);
      const sessionId = entry?.lastObservedSessionId;
      const agentName = profile.name;
      const notifier = notifierFor(profile.id);
      if (nextStatus.kind === 'failed') {
        notifier.observeRuntimeExit({
          kind: nextStatus.kind,
          message: nextStatus.message,
          ...(sessionId ? { sessionId } : {}),
          text: t('notify.unexpectedExit', agentName, nextStatus.message),
        });
      } else if (nextStatus.kind === 'reconnecting') {
        notifier.observeRuntimeExit({
          kind: nextStatus.kind,
          message: 'reconnecting',
          ...(sessionId ? { sessionId } : {}),
          text: t('notify.unexpectedExit', agentName, t('status.reconnecting', agentName)),
        });
      } else if (nextStatus.kind === 'connected') {
        notifier.observeRuntimeExit({ kind: nextStatus.kind, text: '' });
      }
      pushBackends();
    },
    controllerOptions: () => ({
      workbench: mobileAwareWorkbench,
      includeActiveEditor: () => platform.settings.get<boolean>('context.includeActiveEditor', true),
      post: (message) => postForBackend(profile.id, message),
      isVisible: () => isAnyClientVisible() && active?.backend.profile.id === profile.id,
      log,
      folderLabel: () => {
        const targetWs = managedBackends.get(profile.id)?.workspacePath ?? workspacePath;
        return folders().length > 1 ? folders().find((f) => (normalizeProjectPath(f.path) || f.path) === targetWs)?.name : undefined;
      },
      selectFolder: () => void selectFolderCommand(),
      openExternal: openExternalVoid,
      showLogs: () => platform.showLogs(),
      appearance: readAppearance,
      preferences: readPreferences,
      backends: backendsState,
      providers: providersState,
      accounts: accountsState,
      projects: projectsState,
      extensions: extensionsState,
      runtimeMcpServers: readEffectiveMcpServers,
      showTurnChanges: () => platform.settings.get<boolean>('ui.showTurnChanges', false),
      openSettings: () => platform.openHostSettings(),
      setAppearance: applyAppearancePatch,
      setPreferences: applyPreferencesPatch,
      pickFiles: () =>
        platform.pickOpenDialog({
          canSelectMany: true,
          canSelectFiles: true,
          canSelectFolders: true,
          defaultPath: managedBackends.get(profile.id)?.workspacePath ?? workspacePath,
          title: t('files.pickTitle'),
        }),
      onSessionObserve: (obs) => {
        const entry = managedBackends.get(profile.id);
        if (entry && obs.sessionId) entry.lastObservedSessionId = obs.sessionId;
        if (!suppressTabSync && active?.backend.profile.id === profile.id && obs.sessionId && unifiedTabsRestored) {
          const cur = unifiedTabs.current;
          if (cur && cur.backendId === profile.id && !cur.sessionId) {
            unifiedTabs.bindCurrentSession(
              profile.id,
              obs.sessionId,
              obs.title && obs.title !== t('session.new') ? obs.title : undefined,
            );
          }
        }
        if (obs.sessionId && obs.title && obs.title !== t('session.new')) {
          unifiedTabs.updateCachedTitle(profile.id, obs.sessionId, obs.title);
        }
        notifierFor(profile.id).observeSession({
          ...obs,
          agentName: profile.name,
          format: {
            attention: (agent, title) => t('notify.attention', agent, title),
            turnComplete: (agent, title) => t('notify.turnComplete', agent, title),
            scheduledComplete: (title) => t('notify.scheduledComplete', title),
          },
        });
        const prevRunning = lastBackendRunning.get(profile.id) ?? false;
        if (prevRunning !== obs.running) {
          lastBackendRunning.set(profile.id, obs.running);
          pushBackends();
          // 跨底层多回合 Git 检查点（P0-3）：每回合结束后自动快照当前工作区到隐藏 ref
          if (prevRunning && !obs.running && obs.sessionId) {
            const snap = entry?.backend.controller.peekSnapshot?.() ?? entry?.backend.controller.snapshot();
            const turnCount = snap ? (snap.session.turns ?? deriveTurns(snap.items, false)).length : 0;
            const targetCwd = entry?.workspacePath ?? workspacePath;
            if (turnCount > 0) {
              void captureTurnCheckpoint(targetCwd, obs.sessionId, turnCount).then((ok) => {
                if (ok) void refreshSessionCheckpoints(targetCwd, obs.sessionId);
              });
            }
          }
        }
        pushUnifiedTabs();
        hub?.observeSession(obs, profile.id);
      },
      onSessionRekey: (oldSessionId, newSessionId) => {
        if (unifiedTabs.rekeySession(profile.id, oldSessionId, newSessionId)) {
          pushUnifiedTabs();
        }
      },
      isHiddenSession: (sessionId) => hub?.isHiddenSession(sessionId) ?? false,
      workbenchState: () => {
        if (!hub || buildingWorkbenchState) return emptyWorkbenchState();
        buildingWorkbenchState = true;
        try {
          return hub.state();
        } finally {
          buildingWorkbenchState = false;
        }
      },
      onModelChange: (label) => {
        const entry = managedBackends.get(profile.id);
        if (entry) entry.modelLabel = label;
        if (active?.backend.profile.id === profile.id) {
          updateStatusBar();
        }
        // 会话列表按会话展示模型，模型切换后让 Hub 立即同步注册表并推送
        hub?.schedulePush();
      },
    }),
    getCachedExecutable: (profileId, commandSpec) => {
      const entry = cachedExecutables.get(profileId);
      if (!entry || entry.commandSpec !== commandSpec) return undefined;
      if (inWsl && isAutoDetectedCommandSpec(entry.commandSpec) && isWslWindowsPath(entry.command)) {
        cachedExecutables.delete(profileId);
        persistEnvCache();
        return undefined;
      }
      return {
        command: entry.command,
        ...(entry.version ? { version: entry.version } : {}),
        ...(entry.mtimeMs !== undefined ? { mtimeMs: entry.mtimeMs } : {}),
        ...(entry.size !== undefined ? { size: entry.size } : {}),
      };
    },
    setCachedExecutable: (profileId, commandSpec, resolved) => {
      if (!resolved) {
        const hadExec = cachedExecutables.delete(profileId);
        const wasAvail = availability.get(profileId);
        availability.set(profileId, false);
        if (hadExec || wasAvail !== false) {
          persistEnvCache();
          pushBackends();
        }
        return;
      }
      const prev = cachedExecutables.get(profileId);
      const mergedVer = resolved.version ?? prev?.version;
      cachedExecutables.set(profileId, {
        commandSpec,
        command: resolved.command,
        ...(mergedVer ? { version: mergedVer } : {}),
        ...(resolved.mtimeMs !== undefined ? { mtimeMs: resolved.mtimeMs } : {}),
        ...(resolved.size !== undefined ? { size: resolved.size } : {}),
      });
      availability.set(profileId, true);
      if (resolved.version && !installedVersions.has(profileId)) {
        installedVersions.set(profileId, resolved.version);
      }
      persistEnvCache();
      pushBackends();
    },
    boundProvider: (backendId) => effectiveProviderFor(backendId),
    prepareAccountLaunch: async (backendId, baseEnv) => {
      const binding = channelFor(backendId);
      if (binding.mode !== 'official') return undefined;
      const accountId = binding.accountId ?? systemAccountId(backendId);
      const acc = isSystemAccountId(accountId) ? undefined : readAccounts().find((a) => a.id === accountId);
      const lowerBackend = backendId.toLowerCase();
      const prevSlotOwner = currentSlotOwner(backendId);
      const patch = await prepareAccountLaunchPatch({
        backendId,
        accountId,
        ...(acc ? { account: acc } : {}),
        storageRoot,
        baseEnv,
        secrets: platform.secrets,
        activateSlot: lowerBackend === 'antigravity' || lowerBackend === 'codebuddy',
        ...(prevSlotOwner ? { previousAccountId: prevSlotOwner } : {}),
      });
      if (lowerBackend === 'antigravity') {
        lastActiveAntigravityAccountId = accountId;
      } else if (lowerBackend === 'codebuddy') {
        lastActiveCodebuddyAccountId = accountId;
      }
      return patch;
    },
    ensureProviderProxy: async () => {
      const hadOrigin = Boolean(providerProxy.origin);
      const origin = await providerProxy.ensureStarted();
      if (!hadOrigin && readProtocolGatewayEnabled()) {
        pushProviders();
      }
      return {
        origin,
        token: providerProxy.token,
      };
    },
    isProtocolGatewayEnabled: readProtocolGatewayEnabled,
    onProviderModelSelected: (providerId, model) => {
      selectedProviderModels.set(providerId, model);
    },
    prepareBackendLaunch: async (targetProfile) => {
      await ensureBrowserMcpReady();
      return prepareBackendLaunch({
        storageRoot,
        profile: targetProfile,
        skills: installedSkills,
        mcpServers: readEffectiveMcpServers(),
      });
    },
  });

  const create = (profile: BackendProfile): RunningBackend => {
    const profileHost = hostFor(profile);
    if (runtimeOptions.createBackend) {
      return runtimeOptions.createBackend(profile, profileHost);
    }
    if (profile.kind === 'dsh') return createDshBackend(profile, profileHost);
    if (profile.kind === 'zcode') return createZcodeBackend(profile, profileHost);
    if (profile.kind === 'claude') return createClaudeBackend(profile, profileHost);
    if (profile.kind === 'pi') return createPiBackend(profile, profileHost);
    if (profile.kind === 'codex') return createCodexBackend(profile, profileHost);
    if (profile.kind === 'codebuddy') return createCodebuddyBackend(profile, profileHost);
    return createAcpBackend(profile, profileHost);
  };

  const startIfNeeded = (): void => {
    if (!active) return;
    const kind = active.backend.currentStatus().kind;
    if (kind === 'idle' || kind === 'notInstalled' || kind === 'untrusted') active.backend.start();
  };
  startIfNeededRef = startIfNeeded;

  const isBackendRunningTurn = (entry: ManagedBackend): boolean =>
    entry.backend.controller.peekSnapshot?.()?.session.running === true;

  syncManagedBackendsForChannelChange = (targetBackendIdOnly?: string): void => {
    for (const [id, entry] of [...managedBackends.entries()]) {
      if (targetBackendIdOnly && id !== targetBackendIdOnly) continue;
      const nextSig = boundProviderSignatureFor(id);
      if (nextSig === entry.boundProviderSignature) continue;
      entry.boundProviderSignature = nextSig;
      if (id === active?.backend.profile.id) {
        if (!isBackendRunningTurn(entry)) {
          void switchBackend(id, true);
        }
      } else if (!isBackendRunningTurn(entry)) {
        void enqueueBackendTransition(async () => {
          await stopAndDeleteManagedBackend(id);
          pushBackends();
        });
      }
    }
  };

  // 启动时静默做一次纯本地凭据状态探测（不发网络请求，毫秒级完成）
  void refreshAccountInspections({ includeQuota: false }).catch(() => undefined);

  const stopAndDeleteManagedBackend = async (id: string): Promise<void> => {
    const existing = managedBackends.get(id);
    if (!existing) return;
    managedBackends.delete(id);
    lastBackendRunning.delete(id);
    if (active === existing) {
      active = undefined;
    }
    await existing.backend.stop().catch((error: unknown) => log(`停止底层失败：${String(error)}`));
  };

  const createManagedEntry = (profile: BackendProfile): ManagedBackend => {
    const backend = create(profile);
    const entry: ManagedBackend = {
      backend,
      profileSignature: JSON.stringify(profile),
      boundProviderSignature: boundProviderSignatureFor(profile.id),
      extensionsSignature: backendExtensionsSignature(profile.id, installedSkills, readMcpServers()),
      workspacePath,
    };
    managedBackends.set(profile.id, entry);
    return entry;
  };

  interface ActivateBackendOptions {
    readonly openBlank?: boolean;
    readonly targetSessionId?: string;
  }

  const activateBackend = async (
    id: string,
    forceReload = false,
    options?: ActivateBackendOptions,
  ): Promise<void> =>
    withSuppressedTabSync(async () => {
      targetBackendId = id;
      const profile = profiles().find((p) => p.id === id) ?? DSH_PROFILE;
      if (forceReload) {
        await stopAndDeleteManagedBackend(profile.id);
      }
      let entry = managedBackends.get(profile.id);
      if (!entry) {
        try {
          entry = createManagedEntry(profile);
        } catch (error) {
          log(`启动底层 ${profile.name} 失败：${error instanceof Error ? error.message : String(error)}`);
          if (forceReload) {
            await stopAndDeleteManagedBackend(DSH_PROFILE.id);
          }
          entry = managedBackends.get(DSH_PROFILE.id) ?? createManagedEntry(DSH_PROFILE);
        }
      } else if (entry.workspacePath !== workspacePath) {
        entry.workspacePath = workspacePath;
        entry.backend.controller.setWorkspace(workspacePath);
      }
      let desiredBlank = options?.openBlank === true;
      let desiredSessionId = options?.targetSessionId;
      if (!unifiedTabsRestored) {
        const { restoredFromPersisted } = ensureUnifiedTabsRestored(entry);
        if (restoredFromPersisted && !options) {
          const curTab = unifiedTabs.current;
          if (curTab?.backendId === entry.backend.profile.id) {
            const currentControllerSession = entry.backend.controller.peekSnapshot?.().session.id;
            if (curTab.sessionId && curTab.sessionId !== currentControllerSession) {
              desiredSessionId = curTab.sessionId;
            } else if (!curTab.sessionId && currentControllerSession) {
              desiredBlank = true;
            }
          }
        }
      }
      active = entry;
      targetBackendId = entry.backend.profile.id;
      if (desiredBlank) {
        await entry.backend.controller.handle({ type: 'newSession', payload: {} });
      } else if (desiredSessionId) {
        await entry.backend.controller.handle({
          type: 'switchSession',
          payload: { sessionId: desiredSessionId },
        });
      }
      updateStatusBar();
      if (isAnyClientVisible()) {
        startIfNeeded();
        const snap = withUnifiedTabs(entry.backend.controller.snapshot());
        lastPostedTabsJson = JSON.stringify(snap.tabs);
        post({ type: 'snapshot', payload: snap });
      } else {
        pushBackends();
      }
    });

  let switching: Promise<void> = Promise.resolve();
  const enqueueBackendTransition = (task: () => Promise<void>): Promise<void> => {
    switching = switching.then(task, task);
    return switching;
  };

  const switchBackend = (id: string, forceReload = false): Promise<void> =>
    enqueueBackendTransition(async () => {
      if (!forceReload && active?.backend.profile.id === id) {
        if (isAnyClientVisible()) startIfNeeded();
        return;
      }
      targetBackendId = id;
      await activateBackend(id, forceReload);
      log(`已切换到底层 ${active?.backend.profile.name ?? id}`);
    });
  switchBackendFn = switchBackend;

  const openNewTabInActive = (): Promise<void> =>
    enqueueBackendTransition(async () => {
      ensureUnifiedTabsRestored(active);
      const backendId = active?.backend.profile.id ?? targetBackendId;
      unifiedTabs.openNew(backendId);
      if (active) {
        await withSuppressedTabSync(() => active!.backend.controller.handle({ type: 'newSession', payload: {} }));
      }
      pushUnifiedTabs();
    });

  /**
   * 串行化切换工作区：同一时间只有一个 cwd 处于活动状态。
   * worktree 会话靠它实现——切过去后其他工作区的会话保留在标签/历史里，但不再收到实时事件。
   */
  const switchWorkspace = async (projectPath: string, options?: { readonly skipControllerSync?: boolean }): Promise<void> => {
    const nextPath = normalizeProjectPath(projectPath) || projectPath;
    await saveRecentProjectPath(nextPath);
    if (nextPath === workspacePath) {
      pushProjects();
      return;
    }
    workspacePath = nextPath;
    await platform.workspaceState.update(FOLDER_KEY, workspacePath);
    unifiedTabsRestored = false;
    if (!options?.skipControllerSync && active) {
      active.workspacePath = workspacePath;
      active.lastObservedSessionId = undefined;
      notifierFor(active.backend.profile.id).reset();
      active.backend.controller.setWorkspace(workspacePath);
      ensureUnifiedTabsRestored(active);
      active.backend.controller.backendsChanged();
      pushUnifiedTabs(true);
    }
    pushProjects();
    void hub?.refreshSourceControl();
  };

  const openSessionInActive = (
    payload: Extract<WebviewToHost, { type: 'switchSession' }>['payload'],
  ): Promise<void> =>
    enqueueBackendTransition(async () => {
      ensureUnifiedTabsRestored(active);
      const backendId = active?.backend.profile.id ?? targetBackendId;
      unifiedTabs.open(backendId, payload.sessionId, payload.label);
      if (active) {
        await withSuppressedTabSync(() => active!.backend.controller.handle({ type: 'switchSession', payload }));
      }
      pushUnifiedTabs();
    });
  openSessionInActiveFn = openSessionInActive;

  const activateUnifiedTab = (key: string): Promise<void> =>
    enqueueBackendTransition(async () => {
      ensureUnifiedTabsRestored(active);
      const tab = unifiedTabs.setActive(key);
      if (!tab) return;
      // 多 worktree 并行标签（P1-5）：切换回绑定了独立 worktree 的标签时自动同步工作区，不中断其他后台标签执行
      if (tab.worktreePath && tab.worktreePath !== workspacePath) {
        workspacePath = tab.worktreePath;
        await platform.workspaceState.update(FOLDER_KEY, workspacePath);
        pushProjects();
        void hub?.refreshSourceControl();
      }
      if (tab.backendId !== active?.backend.profile.id) {
        await activateBackend(
          tab.backendId,
          false,
          tab.sessionId ? { targetSessionId: tab.sessionId } : { openBlank: true },
        );
        if (tab.sessionId) void refreshSessionCheckpoints(tab.worktreePath ?? workspacePath, tab.sessionId);
        log(`已通过标签切换到底层 ${active?.backend.profile.name ?? tab.backendId}`);
        return;
      }
      if (active) {
        if (tab.worktreePath && active.workspacePath !== tab.worktreePath) {
          active.workspacePath = tab.worktreePath;
          active.backend.controller.setWorkspace(tab.worktreePath);
        }
        await withSuppressedTabSync(async () => {
          if (tab.sessionId) {
            await active!.backend.controller.handle({
              type: 'switchSession',
              payload: { sessionId: tab.sessionId },
            });
          } else {
            await active!.backend.controller.handle({ type: 'newSession', payload: {} });
          }
        });
        if (tab.sessionId) void refreshSessionCheckpoints(tab.worktreePath ?? workspacePath, tab.sessionId);
      }
      pushUnifiedTabs();
    });

  type ClosedTabLike = { readonly backendId: string; readonly sessionId?: string };
  /** 统一标签关闭后的收尾：同步底层标签、切换活动标签并推送最新标签栏。 */
  const finishClosedTabs = async (
    closed: readonly ClosedTabLike[],
    activeChanged: boolean,
    nextActive: ClosedTabLike,
  ): Promise<void> => {
    for (const tab of closed) {
      await closeSessionInController(tab.backendId, tab.sessionId);
    }
    if (activeChanged && nextActive.backendId !== active?.backend.profile.id) {
      await activateBackend(
        nextActive.backendId,
        false,
        nextActive.sessionId ? { targetSessionId: nextActive.sessionId } : { openBlank: true },
      );
      pushUnifiedTabs();
      return;
    }
    if (activeChanged && active) {
      await withSuppressedTabSync(async () => {
        if (nextActive.sessionId) {
          await active!.backend.controller.handle({
            type: 'switchSession',
            payload: { sessionId: nextActive.sessionId },
          });
        } else {
          await active!.backend.controller.handle({ type: 'newSession', payload: {} });
        }
      });
    }
    pushUnifiedTabs();
  };

  const closeUnifiedTab = (key: string): Promise<void> =>
    enqueueBackendTransition(async () => {
      ensureUnifiedTabsRestored(active);
      const res = unifiedTabs.close(key);
      if (!res) return;
      await finishClosedTabs([res.closed], res.activeChanged, res.nextActive);
    });

  /** 关闭某个会话在所有底层中打开的标签（删除会话时使用）。 */
  const closeUnifiedTabsForSession = (backendId: string, sessionId: string): Promise<void> =>
    enqueueBackendTransition(async () => {
      ensureUnifiedTabsRestored(active);
      const keys = unifiedTabs.items
        .filter((tab) => tab.backendId === backendId && tab.sessionId === sessionId)
        .map((tab) => tab.key);
      const res = keys.length > 0 ? unifiedTabs.closeMany(keys) : undefined;
      if (!res) return;
      await finishClosedTabs(res.closed, res.activeChanged, res.nextActive);
    });

  /** 标签顺序只影响界面，不需要排队切底层。 */
  const moveUnifiedTab = (key: string, toIndex: number): void => {
    ensureUnifiedTabsRestored(active);
    if (unifiedTabs.move(key, toIndex)) pushUnifiedTabs();
  };

  const closeUnifiedTabs = (
    key: string,
    scope: Extract<WebviewToHost, { type: 'closeTabs' }>['payload']['scope'],
  ): Promise<void> =>
    enqueueBackendTransition(async () => {
      ensureUnifiedTabsRestored(active);
      const items = [...unifiedTabs.items];
      const index = items.findIndex((tab) => tab.key === key);
      if (index < 0) return;
      const keys = items
        .filter((_, i) => (scope === 'others' ? i !== index : scope === 'left' ? i < index : scope === 'right' ? i > index : true))
        .map((tab) => tab.key);
      const res = keys.length > 0 ? unifiedTabs.closeMany(keys) : undefined;
      if (!res) return;
      await finishClosedTabs(res.closed, res.activeChanged, res.nextActive);
    });

  const selectBackendForCurrentTab = (id: string, persistDefault = true): Promise<void> =>
    enqueueBackendTransition(async () => {
      ensureUnifiedTabsRestored(active);
      const resolved = resolveBackendId(id);
      if (persistDefault) {
        await persistDefaultBackend(resolved);
      }
      const cur = unifiedTabs.current;
      if (cur && !cur.sessionId) {
        // 当前在空的新对话标签上切换智能体：就地更新该标签的智能体归属，保留其他所有标签
        unifiedTabs.setTabBackend(cur.key, resolved);
        if (resolved !== active?.backend.profile.id) {
          await activateBackend(resolved, false, { openBlank: true });
          log(`已切换到底层 ${active?.backend.profile.name ?? resolved}`);
        } else {
          pushBackends();
          pushUnifiedTabs();
        }
        return;
      }
      if (resolved === active?.backend.profile.id) {
        pushBackends();
        return;
      }
      // 当前在已有会话的标签上切换智能体：保留当前标签，切到目标智能体已有标签或新开一个空标签
      const existing = unifiedTabs.findLastByBackend(resolved);
      if (existing) {
        unifiedTabs.setActive(existing.key);
        await activateBackend(
          resolved,
          false,
          existing.sessionId ? { targetSessionId: existing.sessionId } : { openBlank: true },
        );
      } else {
        unifiedTabs.openNew(resolved);
        await activateBackend(resolved, false, { openBlank: true });
      }
      log(`已切换到底层 ${active?.backend.profile.name ?? resolved}`);
    });

  const reloadActiveIfExtensionsChanged = (): void => {
    for (const [id, entry] of [...managedBackends.entries()]) {
      const nextSig = backendExtensionsSignature(id, installedSkills, readMcpServers());
      if (nextSig === entry.extensionsSignature) continue;
      entry.extensionsSignature = nextSig;
      if (isBackendRunningTurn(entry)) continue;
      if (id === active?.backend.profile.id) {
        void switchBackend(id, true);
      } else {
        void enqueueBackendTransition(async () => {
          await stopAndDeleteManagedBackend(id);
          pushBackends();
        });
      }
    }
  };

  void loadInstalledSkills(storageRoot).then((loaded) => {
    installedSkills = loaded;
    reloadActiveIfExtensionsChanged();
    pushExtensions();
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
      const versions = await fetchNpmVersions(npmCommand, pkg, processEnv(), process.platform);
      availableVersions.set(id, versions);
      persistEnvCache();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      versionsError.set(id, message);
      log(`读取 ${pkg} 的版本列表失败（npm: ${npmCommand}）：${message}`);
    } finally {
      versionsLoading.delete(id);
      pushBackends();
    }
  };

  /**
   * npm 只管理自己安装的底层：已安装但不是 npm 装的（Homebrew / mise / Volta / 桌面端自带），
   * 直接 `npm install -g` 只会装第二份，覆盖不到用户现有的那份，所以拒绝并让用户用原方式管理。
   */
  const ensureNpmOwned = async (id: string, name: string, pkg: string): Promise<boolean> => {
    if (!npmCommand) return false;
    const installed = await listNpmGlobalPackages(npmCommand, processEnv(), process.platform);
    const executable = cachedExecutables.get(id)?.command;
    const owned = await checkNpmOwnership({
      packageName: pkg,
      installedPackages: installed,
      ...(executable ? { executable } : {}),
      ...(npmGlobalBin ? { npmGlobalBin } : {}),
      platform: process.platform,
    });
    if (!owned) {
      log(`拒绝用 npm 覆盖 ${id}：不是 npm 安装（${executable ?? '未找到可执行文件'}）`);
      post({ type: 'toast', payload: { level: 'error', text: t('backend.notNpmOwned', name, executable ?? pkg) } });
    }
    return owned;
  };

  const installOrSwitchBackend = async (id: string, version?: string): Promise<void> => {
    if (!platform.isWorkspaceTrusted()) {
      post({ type: 'toast', payload: { level: 'error', text: t('workspace.untrusted') } });
      return;
    }
    const profile = profiles().find((p) => p.id === id);
    const name = profile?.name ?? id;
    const pkg = npmPackageFor(id);
    if (!pkg) {
      post({ type: 'toast', payload: { level: 'error', text: t('backend.noNpmPackage', name) } });
      return;
    }
    if (version !== undefined && !isValidNpmVersion(version)) {
      post({ type: 'toast', payload: { level: 'error', text: t('backend.invalidVersion', version) } });
      return;
    }
    if (backendBusy.has(id)) return;
    if (!nodeEnv.checked || !nodeEnv.hasNode || !nodeEnv.hasNpm || !npmCommand) await checkAvailability();
    if (!nodeEnv.hasNode || !nodeEnv.hasNpm || !npmCommand) {
      post({ type: 'toast', payload: { level: 'error', text: t('backend.nodeRequired') } });
      pushBackends();
      return;
    }

    const wasInstalled = availability.get(id) === true;
    if (wasInstalled && !(await ensureNpmOwned(id, name, pkg))) return;
    backendBusy.set(id, wasInstalled && version ? 'switching' : 'installing');
    pushBackends();

    try {
      await enqueueBackendTransition(async () => {
        await stopAndDeleteManagedBackend(id);
      });
      const res = await installNpmPackage(npmCommand, pkg, version, processEnv(), process.platform, runtimeLog);
      await checkAvailability();
      await enqueueBackendTransition(async () => {
        if (!active && targetBackendId === id) {
          await activateBackend(id);
        }
      });
      if (res.ok) {
        const text = version ? t('backend.installVersionOk', name, version) : t('backend.installOk', name);
        post({ type: 'toast', payload: { level: 'info', text } });
      } else {
        post({
          type: 'toast',
          payload: { level: 'error', text: t('backend.installFailed', name, res.message ?? 'unknown error') },
        });
      }
    } finally {
      backendBusy.delete(id);
      pushBackends();
    }
  };

  const uninstallBackend = async (id: string): Promise<void> => {
    if (!platform.isWorkspaceTrusted()) {
      post({ type: 'toast', payload: { level: 'error', text: t('workspace.untrusted') } });
      return;
    }
    const profile = profiles().find((p) => p.id === id);
    const name = profile?.name ?? id;
    const pkg = npmPackageFor(id);
    if (!pkg) {
      post({ type: 'toast', payload: { level: 'error', text: t('backend.noNpmPackage', name) } });
      return;
    }
    if (backendBusy.has(id)) return;
    if (!nodeEnv.checked || !nodeEnv.hasNode || !nodeEnv.hasNpm || !npmCommand) await checkAvailability();
    if (!nodeEnv.hasNode || !nodeEnv.hasNpm || !npmCommand) {
      post({ type: 'toast', payload: { level: 'error', text: t('backend.nodeRequired') } });
      pushBackends();
      return;
    }

    if (availability.get(id) === true && !(await ensureNpmOwned(id, name, pkg))) return;
    backendBusy.set(id, 'uninstalling');
    pushBackends();

    try {
      await enqueueBackendTransition(async () => {
        await stopAndDeleteManagedBackend(id);
      });
      const res = await uninstallNpmPackage(npmCommand, pkg, processEnv(), process.platform, runtimeLog);
      await checkAvailability();
      await enqueueBackendTransition(async () => {
        if (!active && targetBackendId === id) {
          await activateBackend(id);
        }
      });
      if (res.ok) {
        post({ type: 'toast', payload: { level: 'info', text: t('backend.uninstallOk', name) } });
      } else {
        post({
          type: 'toast',
          payload: { level: 'error', text: t('backend.uninstallFailed', name, res.message ?? 'unknown error') },
        });
      }
    } finally {
      backendBusy.delete(id);
      pushBackends();
    }
  };

  void activateBackend(defaultBackendId);
  const current = (): RunningBackend | undefined => active?.backend;

  const unattendedRunner = new UnattendedRunner({
    getActiveDshClient: () => managedBackends.get(DSH_PROFILE.id)?.backend.dshClient?.(),
    getDshConfig: () => ({
      configuredPath: platform.settings.get<string>('dsh.path', ''),
      profile: safeProfile(platform.settings.get<string>('dsh.profile', 'web') || 'web'),
      env: processEnv(),
    }),
    getZcodeConfig: () => ({
      configuredPath: platform.settings.get<string>('zcode.path', ''),
      env: processEnv(),
    }),
    getClaudeConfig: () => ({
      configuredPath: platform.settings.get<string>('claude.path', ''),
      env: processEnv(),
    }),
    getPiConfig: () => ({
      configuredPath: platform.settings.get<string>('pi.path', ''),
      env: processEnv(),
    }),
    getCodexConfig: () => ({
      configuredPath: platform.settings.get<string>('codex.path', ''),
      env: processEnv(),
    }),
    getCodebuddyConfig: () => ({
      configuredPath: platform.settings.get<string>('codebuddy.path', ''),
      env: processEnv(),
    }),
    getEnvForProfile: (profileEnv) => processEnv(profileEnv),
    prepareBackendLaunch: async (targetProfile) => {
      await ensureBrowserMcpReady();
      return prepareBackendLaunch({
        storageRoot,
        profile: targetProfile,
        skills: installedSkills,
        mcpServers: readEffectiveMcpServers(),
      });
    },
    extensionVersion: platform.extensionVersion,
    log,
    runtimeLog,
  });

  const contextForManaged = (entry: ManagedBackend) => ({
    backendId: entry.backend.profile.id,
    backendName: entry.backend.profile.name,
    workspacePath: entry.workspacePath,
    snapshot: entry.backend.controller.peekSnapshot?.() ?? entry.backend.controller.snapshot(),
    crossProjectSessions: entry.backend.controller.allWorkspaceSessions?.() ?? [],
    latestAssistantText: (sid: string) => entry.backend.controller.latestAssistantText?.(sid),
  });

  hub = new WorkbenchHub({
    globalState: platform.globalState,
    runner: unattendedRunner,
    locale: getLocale,
    isWorkspaceTrusted: () => platform.isWorkspaceTrusted(),
    isWebviewVisible: isAnyClientVisible,
    isBackgroundSchedulerActive: () =>
      platform.schedulerLockDir ? isSchedulerLockHeld(schedulerLockPath(platform.schedulerLockDir), process.pid) : false,
    ...(platform.onSchedulesChanged ? { onSchedulesChanged: platform.onSchedulesChanged } : {}),
    openFile: (path) => sendInlineFile(path),
    openDiff: (request, meta) => sendInlineDiff(request, meta),
    confirm: (message, detail, action) => mobileAwareWorkbench.confirm(message, detail, action),
    getDirectProvider: async () => {
      const providers = readProviders();
      const activeId = active?.backend.profile.id;
      const ordered = [
        ...(activeId ? providers.filter((p) => p.boundBackendIds.includes(activeId)) : []),
        ...providers.filter((p) => !activeId || !p.boundBackendIds.includes(activeId)),
      ];
      for (const provider of ordered) {
        if (!provider.openaiChatUrl && !provider.anthropicUrl) continue;
        const apiKey = await platform.secrets.get(providerSecretKey(provider.id));
        if (apiKey?.trim()) {
          return { provider, apiKey: apiKey.trim() };
        }
      }
      return undefined;
    },
    removeWorktree: async (target) => {
      const { mainRepoPath } = await removeProjectWorktree({ worktreePath: target, log });
      const nextRecent = removeRecentProjectFromList(readRecentProjects(), target);
      await platform.globalState.update(RECENT_PROJECTS_KEY, nextRecent);
      hub?.removeProjectSessions(target);
      if (normalizeProjectPath(target) === normalizeProjectPath(workspacePath)) {
        await switchWorkspace(mainRepoPath);
      } else {
        pushProjects();
      }
    },
    workspacePath: () => workspacePath,
    projects: projectsState,
    profiles,
    schedulePermission: readSchedulePermission,
    activeContext: () => (active ? contextForManaged(active) : undefined),
    liveContexts: () => [...managedBackends.values()].map(contextForManaged),
    backendContext: (backendId) => {
      const entry = managedBackends.get(backendId);
      return entry ? contextForManaged(entry) : undefined;
    },
    switchProjectAndBackend: async (projectPath, backendId) => {
      const targetId = backendId ?? active?.backend.profile.id;
      const switchingBackend = Boolean(targetId && targetId !== active?.backend.profile.id);
      await switchWorkspace(projectPath, { skipControllerSync: switchingBackend });
      if (switchingBackend && targetId) {
        await switchBackend(targetId);
      }
      startIfNeeded();
    },
    prepareTaskWorktree: async (repoPath, branch) => {
      const normalizedRepo = normalizeProjectPath(repoPath) || repoPath;
      const configs = parseProjectConfigs(platform.settings.get<unknown>('projects', {}));
      const config = configs[normalizedRepo] ?? EMPTY_WORKTREE_CONFIG;
      const result = await createProjectWorktree({
        repoPath: normalizedRepo,
        ...(branch?.trim() ? { branch: branch.trim() } : {}),
        config,
        log,
      });
      await saveRecentProjectPath(result.worktreePath);
      pushProjects();
      post({ type: 'toast', payload: { level: 'info', text: t('project.worktreeCreated', result.worktreePath) } });
      return { worktreePath: result.worktreePath, branch: result.branch };
    },
    startProgrammaticSession: async (req) => {
      startIfNeeded();
      ensureUnifiedTabsRestored(active);
      const backendId = active?.backend.profile.id ?? targetBackendId;
      unifiedTabs.openNew(backendId);
      const sessionId = await withSuppressedTabSync(async () =>
        current()?.controller.startProgrammaticSession?.(req),
      );
      if (sessionId) {
        unifiedTabs.bindCurrentSession(backendId, sessionId, req.title);
      }
      pushUnifiedTabs();
      return sessionId;
    },
    switchSessionInActive: async (sessionId) => {
      startIfNeeded();
      await openSessionInActive({ sessionId });
    },
    openNewSessionInActive: async () => {
      startIfNeeded();
      await openNewTabInActive();
    },
    closeSessionTabs: (backendId, sessionId) => closeUnifiedTabsForSession(backendId, sessionId),
    post,
    focusView,
    openPanel: () => platform.openWorkbenchPanel(t('workbench.title')),
    notifyScheduledComplete: (ruleName, runStatus) => {
      if (runStatus === 'succeeded') {
        void notifierFor(active?.backend.profile.id ?? defaultBackendId).notify({
          kind: 'scheduledComplete',
          message: t('notify.scheduledComplete', ruleName),
        });
      }
    },
    log,
  });

  const pushRemote = (): void => {
    if (!remoteBridgeBox.current) return;
    clientHub.broadcastIde({ type: 'remote', payload: remoteBridgeBox.current.getState() });
    updateStatusBar();
  };

  let handleWebviewMessageRef: (message: WebviewToHost, clientId?: string) => void = () => undefined;

  const remoteBridge = new RemoteBridgeServer({
    hostKind: platform.hostKind,
    globalState: platform.globalState,
    clientHub,
    deviceAuth: deviceAuthStore,
    pushService,
    ...(platform.webviewDistRoot ? { webviewDistRoot: platform.webviewDistRoot } : {}),
    ...(runtimeOptions.remotePort !== undefined ? { port: runtimeOptions.remotePort } : {}),
    ...(runtimeOptions.remoteBindHost ? { bindHost: runtimeOptions.remoteBindHost } : {}),
    locale: getLocale,
    onWebviewMessage: (msg, clientId) => handleWebviewMessageRef(msg, clientId),
    onStateChange: () => pushRemote(),
    log,
    ...(runtimeOptions.tailscaleExec ? { tailscaleExec: runtimeOptions.tailscaleExec } : {}),
  });
  remoteBridgeBox.current = remoteBridge;
  void remoteBridge.restoreIfEnabled().then(() => pushRemote());

  updateStatusBar();

  disposers.push(
    platform.onDidGrantWorkspaceTrust(() => {
      if (isAnyClientVisible()) startIfNeeded();
    }),
    platform.settings.onDidChange((changedKeys) => {
      const affects = (prefix: string): boolean => {
        if (changedKeys.has('*') || changedKeys.has(prefix)) return true;
        const dot = `${prefix}.`;
        for (const k of changedKeys) {
          if (k.startsWith(dot) || prefix.startsWith(`${k}.`)) return true;
        }
        return false;
      };
      const chat = current()?.controller;
      const pushPreferences = (): void => {
        if (chat) chat.preferencesChanged();
        else post({ type: 'preferences', payload: readPreferences() });
      };
      if (affects('dsh')) {
        log('dsh 运行时设置已修改，执行「Halo：重启智能体」后生效');
        pushPreferences();
      }
      if (affects('zcode')) {
        log('ZCode 运行时设置已修改，执行「Halo：重启智能体」后生效');
        pushPreferences();
      }
      if (affects('claude')) {
        log('Claude Code 运行时设置已修改，执行「Halo：重启智能体」后生效');
        pushPreferences();
      }
      if (affects('pi')) {
        log('Pi 运行时设置已修改，执行「Halo：重启智能体」后生效');
        pushPreferences();
      }
      if (affects('codex')) {
        log('Codex 运行时设置已修改，执行「Halo：重启智能体」后生效');
        pushPreferences();
      }
      if (affects('codebuddy')) {
        log('CodeBuddy 运行时设置已修改，执行「Halo：重启智能体」后生效');
        pushPreferences();
      }
      if (affects('defaultBackend')) {
        const configured = platform.settings.get<string>('defaultBackend', '').trim();
        if (configured) {
          const resolved = resolveBackendId(configured);
          if (resolved !== defaultBackendId) {
            defaultBackendId = resolved;
            void persistBackendKeys(resolved);
            if (resolved !== active?.backend.profile.id) {
              void selectBackendForCurrentTab(resolved, false);
            } else {
              pushBackends();
            }
          }
        }
      }
      if (affects('backends')) {
        const currentProfiles = profiles();
        const byId = new Map(currentProfiles.map((p) => [p.id, p]));
        if (!byId.has(defaultBackendId)) {
          defaultBackendId = DSH_PROFILE.id;
          void persistDefaultBackend(DSH_PROFILE.id);
        }
        if (unifiedTabsRestored) {
          for (const tab of [...unifiedTabs.items]) {
            if (!byId.has(tab.backendId)) {
              unifiedTabs.removeBackend(tab.backendId, defaultBackendId);
            }
          }
        }
        for (const [id, entry] of [...managedBackends.entries()]) {
          const updated = byId.get(id);
          if (!updated) {
            if (id === active?.backend.profile.id) {
              void enqueueBackendTransition(async () => {
                await stopAndDeleteManagedBackend(id);
                await activateBackend(defaultBackendId);
              });
            } else {
              void enqueueBackendTransition(async () => {
                await stopAndDeleteManagedBackend(id);
                pushBackends();
                pushUnifiedTabs();
              });
            }
            continue;
          }
          if (JSON.stringify(updated) !== entry.profileSignature) {
            if (id === active?.backend.profile.id) {
              void switchBackend(updated.id, true);
            } else if (!isBackendRunningTurn(entry)) {
              void enqueueBackendTransition(async () => {
                await stopAndDeleteManagedBackend(id);
                pushBackends();
              });
            }
          }
        }
        pushBackends();
        pushUnifiedTabs();
        void checkAvailability();
      }
      if (affects('dsh.path') || affects('zcode.path') || affects('claude.path') || affects('pi.path') || affects('codex.path') || affects('codebuddy.path')) {
        void checkAvailability();
      }
      if (affects('context')) {
        chat?.workspaceChanged();
        pushPreferences();
      }
      if (
        affects('ui.theme') ||
        affects('ui.preset') ||
        affects('ui.highContrast') ||
        affects('ui.fontSize') ||
        affects('ui.fontFamily') ||
        affects('ui.lineHeight') ||
        affects('ui.paragraphSpacing') ||
        affects('ui.contentWidth') ||
        affects('ui.codeFontFamily') ||
        affects('ui.terminalFontSize') ||
        affects('ui.terminalLineHeight')
      ) {
        if (chat) chat.appearanceChanged();
        else post({ type: 'appearance', payload: readAppearance() });
      }
      if (affects('ui.showTurnChanges')) {
        chat?.workspaceChanged();
        pushPreferences();
      }
      if (
        affects('notifications') ||
        affects('backendTrace') ||
        affects('schedules') ||
        affects('chatCommands')
      ) {
        pushPreferences();
      }
      if (affects('projects')) {
        pushProjects();
      }
      if (affects('mcpServers')) {
        pushExtensions();
        reloadActiveIfExtensionsChanged();
      }
      if (affects('providers') || affects('protocolGateway') || affects('accounts') || affects('backendChannels')) {
        void (async () => {
          const anyUsesProvider = [...managedBackends.values()].some((entry) =>
            Boolean(effectiveProviderFor(entry.backend.profile.id)),
          );
          if (readProtocolGatewayEnabled()) {
            await providerProxy.ensureStarted().catch((err: unknown) => log(`启动本地协议转换网关失败：${String(err)}`));
          } else if (!anyUsesProvider) {
            await providerProxy.dispose();
          }
          await refreshProviderSecretFlags();
          pushProviders();
          pushAccounts();
          syncManagedBackendsForChannelChange();
        })();
      }
      if (affects('ui.language')) {
        applyLocale();
        if (chat) chat.localeChanged();
        else post({ type: 'locale', payload: getLocale() });
        pushPreferences();
        pushBackends();
        pushUnifiedTabs();
        updateStatusBar();
      }
    }),
  );

  const commandReceipts = new CommandReceipts();

  const handleWebviewMessage = (message: WebviewToHost, clientId = 'ide'): void => {
    const client = clientHub.getClient(clientId);
    const surface: ClientSurface = client?.surface ?? 'ide';
    clientRequestContext.run(
      {
        clientId,
        surface,
        ...(message.type === 'ready' ? { unicastSnapshot: true } : {}),
      },
      () => dispatchWebviewMessage(message),
    );
  };
  handleWebviewMessageRef = handleWebviewMessage;

  const dispatchWebviewMessage = (message: WebviewToHost): void => {
    const commandId = 'commandId' in message ? message.commandId : undefined;
    if (commandId && !commandReceipts.accept(`${message.type}:${commandId}`)) return;
    if (message.type === 'fetchBackendModels') {
      void (async () => {
        const { requestId, backendId } = message.payload;
        const profile = profiles().find((p) => p.id === backendId);
        if (!profile) {
          post({
            type: 'backendModelsFetched',
            payload: { requestId, backendId, models: { options: [] } },
          });
          return;
        }
        let entry = managedBackends.get(profile.id);
        if (!entry) {
          try {
            entry = createManagedEntry(profile);
          } catch (error) {
            log(`获取运行时 ${profile.name} 模型列表失败：${error instanceof Error ? error.message : String(error)}`);
            post({
              type: 'backendModelsFetched',
              payload: { requestId, backendId, models: { options: [] } },
            });
            return;
          }
        }
        const deadline = Date.now() + 4_000;
        while (entry.backend.controller.modelState().options.length === 0 && Date.now() < deadline) {
          const snap = entry.backend.controller.peekSnapshot?.();
          if (
            snap?.models.needsApiKey ||
            snap?.runtime.kind === 'notInstalled' ||
            snap?.runtime.kind === 'unsupportedVersion'
          ) {
            break;
          }
          await new Promise<void>((resolveWait) => setTimeout(resolveWait, 150));
        }
        const models = entry.backend.controller.modelState();
        const permissions = entry.backend.controller.peekSnapshot?.().permissions;
        post({
          type: 'backendModelsFetched',
          payload: {
            requestId,
            backendId,
            models,
            ...(permissions ? { permissions } : {}),
          },
        });
      })();
      return;
    }
    if (message.type === 'pickTaskFiles') {
      void (async () => {
        const basePath = message.payload.projectPath?.trim() || workspacePath;
        const picked = await platform.pickOpenDialog({
          canSelectMany: true,
          canSelectFiles: true,
          canSelectFolders: true,
          defaultPath: basePath,
          title: t('files.pickTitle'),
        });
        if (!picked || picked.length === 0) return;
        const paths = picked.map((rawPath) => {
          if (basePath) {
            const rel = relative(basePath, rawPath);
            if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
              return rel.replace(/\\/gu, '/');
            }
          }
          return rawPath.replace(/\\/gu, '/');
        });
        post({ type: 'taskFilesPicked', payload: { paths } });
      })();
      return;
    }
    if (WORKBENCH_MESSAGE_TYPES.has(message.type)) {
      void hub?.handleMessage(message);
      return;
    }
    if (message.type === 'selectBackend') {
      void selectBackendForCurrentTab(message.payload.id, true);
      return;
    }
    if (message.type === 'newSession') {
      void openNewTabInActive();
      return;
    }
    if (message.type === 'switchSession') {
      void openSessionInActive(message.payload);
      return;
    }
    if (message.type === 'activateTab') {
      void activateUnifiedTab(message.payload.key);
      return;
    }
    if (message.type === 'closeTab') {
      void closeUnifiedTab(message.payload.key);
      return;
    }
    if (message.type === 'moveTab') {
      moveUnifiedTab(message.payload.key, message.payload.toIndex);
      return;
    }
    if (message.type === 'closeTabs') {
      void closeUnifiedTabs(message.payload.key, message.payload.scope);
      return;
    }
    if (message.type === 'checkBackendEnv') {
      void checkAvailability();
      return;
    }
    if (message.type === 'fetchAcpRegistry') {
      void (async () => {
        const url = message.payload.url.trim();
        const MAX_REGISTRY_BYTES = 262_144;
        try {
          const parsedUrl = new URL(url);
          if (parsedUrl.protocol !== 'https:') throw new Error('only https:// URLs are allowed');
          const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
          if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
          const contentLength = Number(response.headers.get('content-length'));
          if (Number.isFinite(contentLength) && contentLength > MAX_REGISTRY_BYTES) {
            throw new Error('registry is too large');
          }
          let raw: string;
          if (response.body) {
            const reader = response.body.getReader();
            const chunks: Uint8Array[] = [];
            let total = 0;
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) {
                total += value.byteLength;
                if (total > MAX_REGISTRY_BYTES) {
                  await reader.cancel().catch(() => undefined);
                  throw new Error('registry is too large');
                }
                chunks.push(value);
              }
            }
            const merged = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
              merged.set(chunk, offset);
              offset += chunk.byteLength;
            }
            raw = new TextDecoder().decode(merged);
          } else {
            raw = await response.text();
            if (Buffer.byteLength(raw, 'utf8') > MAX_REGISTRY_BYTES) throw new Error('registry is too large');
          }
          const entries = parseAcpRegistry(JSON.parse(raw));
          await platform.settings.update('acpRegistryUrl', url);
          acpRegistry = { entries, source: url, fetchedAt: Date.now() };
          post({ type: 'toast', payload: { level: 'info', text: t('backend.registryLoaded', entries.length) } });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          acpRegistry = { entries: [], source: url, error: detail, fetchedAt: Date.now() };
          post({ type: 'toast', payload: { level: 'error', text: t('backend.registryFailed', detail) } });
        }
        pushBackends();
      })();
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
        const next = upsertBackendSetting(platform.settings.get<unknown>('backends', []), message.payload);
        await writeSetting(undefined, 'backends', next);
      })();
      return;
    }
    if (message.type === 'deleteBackendProfile') {
      void (async () => {
        const next = deleteBackendSetting(platform.settings.get<unknown>('backends', []), message.payload.id);
        await writeSetting(undefined, 'backends', next.length > 0 ? next : undefined);
      })();
      return;
    }
    if (message.type === 'upsertProvider') {
      void (async () => {
        const { providers: nextProviders, provider: saved } = upsertProviderSetting(readProviders(), message.payload);
        if (message.payload.apiKey !== undefined) {
          const cleanKey = message.payload.apiKey.trim();
          if (cleanKey) {
            await platform.secrets.store(providerSecretKey(saved.id), cleanKey);
            apiKeyCache.set(saved.id, cleanKey);
            providerHasKey.add(saved.id);
          } else {
            await platform.secrets.delete(providerSecretKey(saved.id));
            apiKeyCache.delete(saved.id);
            providerHasKey.delete(saved.id);
          }
        }
        const hasOpenAiUrl = Boolean(saved.openaiChatUrl?.trim() || saved.openaiResponsesUrl?.trim());
        const needsGateway =
          hasOpenAiUrl &&
          (saved.convertOpenaiToAnthropic === true ||
            (!saved.anthropicUrl?.trim() && saved.boundBackendIds.includes('claude')));
        if (needsGateway && !readProtocolGatewayEnabled()) {
          await writeSetting(undefined, 'protocolGateway', true);
        }
        if (needsGateway || readProtocolGatewayEnabled()) {
          await providerProxy.ensureStarted().catch((err: unknown) => log(`启动本地协议转换网关失败：${String(err)}`));
        }
        await writeSetting(undefined, 'providers', nextProviders.length > 0 ? nextProviders : undefined);
        // 与旧版「服务商勾选绑定智能体」保持双向联动：勾选时切到该服务商，取消且正指向该服务商时回退官方
        let nextChannels = readBackendChannels();
        let channelsChanged = false;
        for (const bid of saved.boundBackendIds) {
          const cur = nextChannels[bid];
          if (cur?.mode !== 'provider' || cur.providerId !== saved.id) {
            nextChannels = setBackendChannelSetting(nextChannels, bid, { mode: 'provider', providerId: saved.id });
            channelsChanged = true;
          }
        }
        for (const [bid, binding] of Object.entries(nextChannels)) {
          if (binding.mode === 'provider' && binding.providerId === saved.id && !saved.boundBackendIds.includes(bid)) {
            nextChannels = setBackendChannelSetting(nextChannels, bid, { mode: 'official' });
            channelsChanged = true;
          }
        }
        if (channelsChanged) {
          await writeSetting(undefined, 'backendChannels', Object.keys(nextChannels).length > 0 ? nextChannels : undefined);
        }
        await hub?.syncProviderAgentBindings(saved);
        if (saved.defaultModel) {
          selectedProviderModels.set(saved.id, saved.defaultModel);
        }
        pushProviders();
        pushAccounts();
      })();
      return;
    }
    if (message.type === 'deleteProvider') {
      void (async () => {
        const id = message.payload.id;
        await platform.secrets.delete(providerSecretKey(id));
        apiKeyCache.delete(id);
        providerHasKey.delete(id);
        selectedProviderModels.delete(id);
        const nextProviders = deleteProviderSetting(readProviders(), id);
        await writeSetting(undefined, 'providers', nextProviders.length > 0 ? nextProviders : undefined);
        let nextChannels = readBackendChannels();
        let channelsChanged = false;
        for (const [bid, binding] of Object.entries(nextChannels)) {
          if (binding.mode === 'provider' && binding.providerId === id) {
            nextChannels = setBackendChannelSetting(nextChannels, bid, { mode: 'official' });
            channelsChanged = true;
          }
        }
        if (channelsChanged) {
          await writeSetting(undefined, 'backendChannels', Object.keys(nextChannels).length > 0 ? nextChannels : undefined);
        }
        await hub?.clearProviderAgentBindings(id);
        pushProviders();
        pushAccounts();
      })();
      return;
    }
    if (message.type === 'setProtocolGateway') {
      void (async () => {
        const enabled = message.payload.enabled;
        await writeSetting(undefined, 'protocolGateway', enabled ? true : undefined);
        const anyUsesProvider = [...managedBackends.values()].some((entry) =>
          Boolean(effectiveProviderFor(entry.backend.profile.id)),
        );
        if (enabled) {
          await providerProxy.ensureStarted().catch((err: unknown) => log(`启动本地协议转换网关失败：${String(err)}`));
        } else if (!anyUsesProvider) {
          await providerProxy.dispose();
        }
        pushProviders();
        syncManagedBackendsForChannelChange();
      })();
      return;
    }
    if (message.type === 'clearProtocolGatewayLogs') {
      if (gatewayLogTimer) {
        clearTimeout(gatewayLogTimer);
        gatewayLogTimer = undefined;
      }
      providerProxy.clearLogs();
      pushProviders();
      return;
    }
    if (message.type === 'bindProviderAgents') {
      void (async () => {
        const nextProviders = bindProviderSetting(
          readProviders(),
          message.payload.id,
          message.payload.boundBackendIds,
          message.payload.boundAgentIds,
        );
        await writeSetting(undefined, 'providers', nextProviders.length > 0 ? nextProviders : undefined);
        let nextChannels = readBackendChannels();
        let channelsChanged = false;
        for (const bid of message.payload.boundBackendIds) {
          nextChannels = setBackendChannelSetting(nextChannels, bid, { mode: 'provider', providerId: message.payload.id });
          channelsChanged = true;
        }
        for (const [bid, binding] of Object.entries(nextChannels)) {
          if (
            binding.mode === 'provider' &&
            binding.providerId === message.payload.id &&
            !message.payload.boundBackendIds.includes(bid)
          ) {
            nextChannels = setBackendChannelSetting(nextChannels, bid, { mode: 'official' });
            channelsChanged = true;
          }
        }
        if (channelsChanged) {
          await writeSetting(undefined, 'backendChannels', Object.keys(nextChannels).length > 0 ? nextChannels : undefined);
        }
        const updated = nextProviders.find((p) => p.id === message.payload.id);
        if (updated) await hub?.syncProviderAgentBindings(updated);
        pushProviders();
        pushAccounts();
      })();
      return;
    }
    if (message.type === 'fetchProviderModels') {
      void (async () => {
        const { requestId, providerId, apiKey, anthropicUrl, openaiChatUrl, openaiResponsesUrl } = message.payload;
        try {
          const effectiveKey =
            apiKey?.trim() ||
            (providerId
              ? (apiKeyCache.get(providerId) ?? (await platform.secrets.get(providerSecretKey(providerId)))?.trim())
              : undefined);
          const models = await fetchRemoteProviderModels({
            ...(effectiveKey ? { apiKey: effectiveKey } : {}),
            ...(anthropicUrl ? { anthropicUrl } : {}),
            ...(openaiChatUrl ? { openaiChatUrl } : {}),
            ...(openaiResponsesUrl ? { openaiResponsesUrl } : {}),
          });
          post({ type: 'providerModelsFetched', payload: { requestId, models } });
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          post({ type: 'providerModelsFetched', payload: { requestId, models: [], error: errMsg } });
        }
      })();
      return;
    }
    if (message.type === 'fetchQuota') {
      const { requestId } = message.payload;
      void (async () => {
        // Claude / Antigravity / CodeBuddy 分别有自己的订阅额度来源；其它底层直接回 unavailable，
        // 不读凭据、不发请求。绑定第三方服务商时（Claude / CodeBuddy）实际消耗的是编程套餐额度，
        // 官方订阅额度不再适用，同样隐藏。切换账号/重启底层期间 active 会短暂置空，必须按 targetBackendId
        // 解析当前目标底层，避免误回退到 defaultBackendId（如 dsh）导致额度标识永久消失。
        const backendId = active?.backend.profile.id ?? targetBackendId;
        const profile = active?.backend.profile ?? profiles().find((p) => p.id === backendId);
        const providerId = quotaProviderFor(profile);
        if (!providerId || (providerId !== 'antigravity' && effectiveProviderFor(backendId))) {
          post({ type: 'quotaFetched', payload: { requestId, error: t('usage.unavailable') } });
          return;
        }
        try {
          const activeAccId =
            activeOfficialAccountId(backendId, readBackendChannels(), readProviders(), readAccounts()) ??
            systemAccountId(backendId);
          const accCfg = isSystemAccountId(activeAccId)
            ? undefined
            : readAccounts().find((a) => a.id === activeAccId);
          // Antigravity 切换到尚未登录的新槽位时，磁盘仍保留上一账号的凭据文件；不误读旧账号额度
          if (providerId === 'antigravity' && !isSystemAccountId(activeAccId)) {
            const storedSlot = (await platform.secrets.get(accountSlotSecretKey(activeAccId)))?.trim();
            if (!storedSlot) {
              post({ type: 'quotaFetched', payload: { requestId, error: t('usage.unavailable') } });
              return;
            }
          }
          const accPatch = await prepareAccountLaunchPatch({
            backendId,
            accountId: activeAccId,
            ...(accCfg ? { account: accCfg } : {}),
            storageRoot,
            baseEnv: processEnv(),
            secrets: platform.secrets,
            activateSlot: false,
          });
          const query =
            providerId === 'claude'
              ? queryClaudeQuota
              : providerId === 'antigravity'
                ? queryAntigravityQuota
                : queryCodebuddyQuota;
          const clientVersion = installedVersions.get(backendId);
          const quota = await query({
            env: accPatch.env,
            getHttpProxy: () => platform.settings.getHttpProxy(),
            ...(clientVersion ? { clientVersion } : {}),
          });
          // 先回传单播结果给请求方，再广播 accounts：避免 pushAccounts 变更账号 status 导致前端提前作废当前 requestId。
          post(
            quota
              ? { type: 'quotaFetched', payload: { requestId, quota } }
              : { type: 'quotaFetched', payload: { requestId, error: t('usage.unavailable') } },
          );
          if (quota) {
            if (providerId === 'antigravity') {
              await syncActiveAntigravitySlotFromDisk({
                accountId: activeAccId,
                secrets: platform.secrets,
                env: accPatch.env,
              }).catch(() => undefined);
            }
            const prev = accountInspections.get(activeAccId);
            accountInspections.set(activeAccId, {
              status: prev?.status ?? 'authenticated',
              ...(prev?.identity ? { identity: prev.identity } : {}),
              ...(prev?.plan ? { plan: prev.plan } : {}),
              ...(prev?.expiresAt !== undefined ? { expiresAt: prev.expiresAt } : {}),
              ...(prev?.hasSecret !== undefined ? { hasSecret: prev.hasSecret } : {}),
              ...(prev?.hasUsageCookie !== undefined ? { hasUsageCookie: prev.hasUsageCookie } : {}),
              quota,
              checkedAt: Date.now(),
            });
            if (prev?.quota?.queriedAt !== quota.queriedAt) {
              pushAccounts();
            }
          } else if (platform.settings.get<boolean>('backendTrace', false)) {
            log(`订阅额度暂不可用（backend=${backendId}，provider=${providerId}，account=${activeAccId}）`);
          }
        } catch (error) {
          if (platform.settings.get<boolean>('backendTrace', false)) {
            log(`订阅额度查询异常（backend=${backendId}）：${error instanceof Error ? error.message : String(error)}`);
          }
          // 额度查询失败不应该打扰用户，前端收到 unavailable 会隐藏标识。
          post({ type: 'quotaFetched', payload: { requestId, error: t('usage.unavailable') } });
        }
      })();
      return;
    }
    if (message.type === 'upsertAccount') {
      void (async () => {
        const payload = message.payload;
        if (payload.id && isSystemAccountId(payload.id)) {
          // 本机默认账号支持自定义名称（留空恢复自动识别邮箱 / 默认名称）及附加凭据（如 CodeBuddy usage-cookie）
          await saveSystemAccountLabel(payload.id, payload.label);
          if (payload.usageCookie !== undefined) {
            const cleanCookie = payload.usageCookie.trim();
            if (cleanCookie) await platform.secrets.store(accountCookieSecretKey(payload.id), cleanCookie);
            else await platform.secrets.delete(accountCookieSecretKey(payload.id));
            bumpAccountRevision(payload.backendId);
          }
          await inspectOneAccount(payload.backendId, payload.id, undefined, false);
          pushAccounts();
          syncManagedBackendsForChannelChange(payload.backendId);
          const displayLabel =
            readSystemAccountLabels()[payload.id] ||
            accountInspections.get(payload.id)?.identity ||
            t('account.systemDefault');
          post({ type: 'toast', payload: { level: 'info', text: t('account.saved', displayLabel) } });
          return;
        }
        const existingAccounts = readAccounts();
        const trimmedLabel = payload.label.trim();
        const effectiveLabel =
          trimmedLabel ||
          (payload.id ? accountInspections.get(payload.id)?.identity : undefined) ||
          nextAutoAccountLabel(payload.backendId, existingAccounts);
        const { accounts: nextAccounts, account: saved } = upsertAccountSetting(existingAccounts, {
          ...(payload.id ? { id: payload.id } : {}),
          backendId: payload.backendId,
          label: effectiveLabel,
          ...(payload.isolateSessions !== undefined ? { isolateSessions: payload.isolateSessions } : {}),
          ...(payload.region ? { region: payload.region } : {}),
        });
        if (payload.apiKey !== undefined) {
          const cleanKey = payload.apiKey.trim();
          if (cleanKey) await platform.secrets.store(accountApiKeySecretKey(saved.id), cleanKey);
          else await platform.secrets.delete(accountApiKeySecretKey(saved.id));
          bumpAccountRevision(saved.backendId);
        }
        if (payload.usageCookie !== undefined) {
          const cleanCookie = payload.usageCookie.trim();
          if (cleanCookie) await platform.secrets.store(accountCookieSecretKey(saved.id), cleanCookie);
          else await platform.secrets.delete(accountCookieSecretKey(saved.id));
          bumpAccountRevision(saved.backendId);
        }
        await writeSetting(undefined, 'accounts', nextAccounts.length > 0 ? nextAccounts : undefined);
        if (payload.setActive) {
          const lowerSavedBackend = saved.backendId.toLowerCase();
          const prevOwner = currentSlotOwner(saved.backendId);
          if (lowerSavedBackend === 'antigravity') {
            const sw = await switchAntigravityCredentialSlot({
              targetAccountId: saved.id,
              ...(prevOwner ? { previousAccountId: prevOwner } : {}),
              secrets: platform.secrets,
              env: processEnv(),
            });
            if (sw.activated) lastActiveAntigravityAccountId = saved.id;
          } else if (lowerSavedBackend === 'codebuddy') {
            const sw = await switchCodebuddyCredentialSlot({
              targetAccountId: saved.id,
              ...(prevOwner ? { previousAccountId: prevOwner } : {}),
              secrets: platform.secrets,
              env: processEnv(),
            });
            if (sw.activated) lastActiveCodebuddyAccountId = saved.id;
          }
          clearQuotaCacheFor(quotaProviderFor(profiles().find((p) => p.id === saved.backendId)));
          const nextChannels = setBackendChannelSetting(readBackendChannels(), saved.backendId, {
            mode: 'official',
            accountId: saved.id,
          });
          await writeSetting(undefined, 'backendChannels', nextChannels);
        }
        if (payload.usageCookie !== undefined) {
          clearQuotaCacheFor(quotaProviderFor(profiles().find((p) => p.id === saved.backendId)));
        }
        await inspectOneAccount(saved.backendId, saved.id, saved, false);
        pushAccounts();
        syncManagedBackendsForChannelChange(saved.backendId);
        post({ type: 'toast', payload: { level: 'info', text: t('account.saved', saved.label) } });
      })();
      return;
    }
    if (message.type === 'deleteAccount') {
      void (async () => {
        const id = message.payload.id;
        if (isSystemAccountId(id)) return;
        const { accounts: nextAccounts, channels: nextChannels, removed } = deleteAccountSetting(
          readAccounts(),
          readBackendChannels(),
          id,
        );
        if (!removed) return;
        accountAuthFlow.cancel(id);
        await removeIsolatedAccountData({
          backendId: removed.backendId,
          accountId: removed.id,
          storageRoot,
          secrets: platform.secrets,
        });
        accountInspections.delete(id);
        await writeSetting(undefined, 'accounts', nextAccounts.length > 0 ? nextAccounts : undefined);
        await writeSetting(undefined, 'backendChannels', Object.keys(nextChannels).length > 0 ? nextChannels : undefined);
        bumpAccountRevision(removed.backendId);
        pushAccounts();
        syncManagedBackendsForChannelChange(removed.backendId);
        post({ type: 'toast', payload: { level: 'info', text: t('account.deleted', removed.label) } });
      })();
      return;
    }
    if (message.type === 'loginAccount') {
      void (async () => {
        const { id, backendId: requestedBackend } = message.payload;
        const configured = readAccounts();
        const foundAccount = isSystemAccountId(id) ? undefined : configured.find((a) => a.id === id);
        const backendId =
          foundAccount?.backendId ??
          (isSystemAccountId(id) ? id.slice('system:'.length) : requestedBackend?.trim() ?? '');
        const profile = profiles().find((p) => p.id === backendId);
        if (!profile) return;
        if (profile.kind === 'dsh') {
          if (isSystemAccountId(id)) {
            await executeCommand('configureApiKey');
            await inspectOneAccount(profile.id, id, undefined, false);
            pushAccounts();
          }
          return;
        }
        const prevOwner = currentSlotOwner(profile.id);
        await accountAuthFlow.startLogin({
          backendId: profile.id,
          backendName: profile.name,
          accountId: id,
          ...(foundAccount ? { account: foundAccount } : {}),
          ...(profile.kind === 'acp' ? { acpCommand: profile.command } : {}),
          ...(prevOwner ? { previousActiveAccountId: prevOwner } : {}),
        });
      })();
      return;
    }
    if (message.type === 'cancelAccountLogin') {
      accountAuthFlow.cancel(message.payload.id, { dismiss: message.payload.dismiss === true });
      return;
    }
    if (message.type === 'submitAccountLoginCode') {
      if (!accountAuthFlow.submitAuthCode(message.payload.id, message.payload.code)) {
        post({ type: 'toast', payload: { level: 'error', text: t('account.loginCodeNotAccepted') } });
      }
      return;
    }
    if (message.type === 'logoutAccount') {
      void (async () => {
        const id = message.payload.id;
        const foundAccount = isSystemAccountId(id) ? undefined : readAccounts().find((a) => a.id === id);
        const backendId = foundAccount?.backendId ?? (isSystemAccountId(id) ? id.slice('system:'.length) : '');
        if (!backendId) return;
        accountAuthFlow.cancel(id);
        await clearAccountCredentials({
          backendId,
          accountId: id,
          storageRoot,
          baseEnv: processEnv(),
          secrets: platform.secrets,
        });
        bumpAccountRevision(backendId);
        await inspectOneAccount(backendId, id, foundAccount, false);
        pushAccounts();
        syncManagedBackendsForChannelChange(backendId);
        post({ type: 'toast', payload: { level: 'info', text: t('account.loggedOut') } });
      })();
      return;
    }
    if (message.type === 'refreshAccounts') {
      void refreshAccountInspections({
        ...(message.payload.backendId ? { backendId: message.payload.backendId } : {}),
        includeQuota: message.payload.includeQuota !== false,
      });
      return;
    }
    if (message.type === 'setBackendChannel') {
      void (async () => {
        const { backendId, mode, accountId, providerId } = message.payload;
        const profile = profiles().find((p) => p.id === backendId);
        if (!profile) return;
        const managed = managedBackends.get(backendId);
        if (managed && isBackendRunningTurn(managed)) {
          post({ type: 'toast', payload: { level: 'error', text: t('account.switchWhileRunning') } });
          return;
        }
        const caps = backendCapabilities(profile);
        let nextBinding: BackendChannelBinding;
        if (mode === 'provider') {
          if (caps.protocols.kind !== 'supported') {
            post({ type: 'toast', payload: { level: 'error', text: t('account.providerUnsupported', profile.name) } });
            return;
          }
          const providers = readProviders();
          const target = providers.find((p) => p.id === providerId);
          if (!target) {
            post({ type: 'toast', payload: { level: 'error', text: t('account.providerMissing') } });
            return;
          }
          const ready = isProviderReadyForBackend(target, profile, {
            protocolGatewayEnabled: readProtocolGatewayEnabled(),
          });
          if (!ready) {
            post({ type: 'toast', payload: { level: 'error', text: t('account.providerIncompatible', target.name, profile.name) } });
            return;
          }
          nextBinding = { mode: 'provider', providerId: target.id };
        } else {
          const targetAccountId = accountId?.trim() || systemAccountId(backendId);
          const prevOwner = currentSlotOwner(backendId);
          nextBinding = { mode: 'official', accountId: targetAccountId };
          if (backendId.toLowerCase() === 'antigravity') {
            const sw = await switchAntigravityCredentialSlot({
              targetAccountId,
              ...(prevOwner ? { previousAccountId: prevOwner } : {}),
              secrets: platform.secrets,
              env: processEnv(),
            });
            if (sw.activated) lastActiveAntigravityAccountId = targetAccountId;
          } else if (backendId.toLowerCase() === 'codebuddy') {
            const sw = await switchCodebuddyCredentialSlot({
              targetAccountId,
              ...(prevOwner ? { previousAccountId: prevOwner } : {}),
              secrets: platform.secrets,
              env: processEnv(),
            });
            if (sw.activated) lastActiveCodebuddyAccountId = targetAccountId;
          }
        }
        clearQuotaCacheFor(quotaProviderFor(profile));
        const nextChannels = setBackendChannelSetting(readBackendChannels(), backendId, nextBinding);
        await writeSetting(undefined, 'backendChannels', nextChannels);
        pushAccounts();
        pushProviders();
        syncManagedBackendsForChannelChange(backendId);
        const sysId = systemAccountId(backendId);
        const channelLabel =
          nextBinding.mode === 'provider'
            ? (readProviders().find((p) => p.id === nextBinding.providerId)?.name ?? nextBinding.providerId)
            : nextBinding.accountId && !isSystemAccountId(nextBinding.accountId)
              ? (readAccounts().find((a) => a.id === nextBinding.accountId)?.label ?? t('account.systemDefault'))
              : (readSystemAccountLabels()[sysId] || accountInspections.get(sysId)?.identity || t('account.systemDefault'));
        post({
          type: 'toast',
          payload: {
            level: 'info',
            text:
              nextBinding.mode === 'provider'
                ? t('account.switchedToProvider', profile.name, channelLabel)
                : t('account.switchedToOfficial', profile.name, channelLabel),
          },
        });
      })();
      return;
    }
    if (message.type === 'testNotification') {
      void notifierFor(active?.backend.profile.id ?? defaultBackendId).sendTest(
        t('notify.test'),
        active?.lastObservedSessionId,
      );
      return;
    }
    if (message.type === 'scanGitSkills') {
      void (async () => {
        if (!platform.isWorkspaceTrusted()) {
          post({ type: 'toast', payload: { level: 'error', text: t('workspace.untrusted') } });
          return;
        }
        if (skillsScanning) return;
        skillsScanning = true;
        skillsError = undefined;
        pushExtensions();
        try {
          skillsScanned = await scanSkillsFromGit({
            repoUrl: message.payload.repoUrl,
            ...(message.payload.ref ? { ref: message.payload.ref } : {}),
            ...(message.payload.subpath ? { subpath: message.payload.subpath } : {}),
            env: processEnv(),
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          skillsError = msg;
          post({ type: 'toast', payload: { level: 'error', text: t('skills.scanFailed', msg) } });
        } finally {
          skillsScanning = false;
          pushExtensions();
        }
      })();
      return;
    }
    if (message.type === 'installGitSkills') {
      void (async () => {
        if (!platform.isWorkspaceTrusted()) {
          post({ type: 'toast', payload: { level: 'error', text: t('workspace.untrusted') } });
          return;
        }
        if (skillsInstalling) return;
        skillsInstalling = true;
        skillsError = undefined;
        pushExtensions();
        try {
          const res = await installSkillsFromGit({
            storageRoot,
            repoUrl: message.payload.repoUrl,
            ...(message.payload.ref ? { ref: message.payload.ref } : {}),
            ...(message.payload.subpath ? { subpath: message.payload.subpath } : {}),
            ...(message.payload.selectedSubpaths ? { selectedSubpaths: message.payload.selectedSubpaths } : {}),
            ...(message.payload.agents ? { agents: message.payload.agents } : {}),
            env: processEnv(),
          });
          installedSkills = res.all;
          skillsScanned = undefined;
          post({
            type: 'toast',
            payload: {
              level: 'info',
              text: t('skills.installOk', res.installed.length, res.installed.map((s) => s.name).join(', ')),
            },
          });
          reloadActiveIfExtensionsChanged();
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          skillsError = msg;
          post({ type: 'toast', payload: { level: 'error', text: t('skills.installFailed', msg) } });
        } finally {
          skillsInstalling = false;
          pushExtensions();
        }
      })();
      return;
    }
    if (message.type === 'updateSkill') {
      void (async () => {
        installedSkills = await updateSkillEntry({
          storageRoot,
          id: message.payload.id,
          ...(message.payload.enabled !== undefined ? { enabled: message.payload.enabled } : {}),
          ...(message.payload.agents !== undefined ? { agents: message.payload.agents } : {}),
        });
        pushExtensions();
        reloadActiveIfExtensionsChanged();
      })();
      return;
    }
    if (message.type === 'syncSkill') {
      void (async () => {
        if (!platform.isWorkspaceTrusted()) {
          post({ type: 'toast', payload: { level: 'error', text: t('workspace.untrusted') } });
          return;
        }
        const id = message.payload.id;
        if (skillBusy.has(id)) return;
        skillBusy.set(id, 'updating');
        pushExtensions();
        try {
          installedSkills = await syncInstalledSkill({
            storageRoot,
            id,
            env: processEnv(),
          });
          const updated = installedSkills.find((s) => s.id === id);
          post({
            type: 'toast',
            payload: { level: 'info', text: t('skills.syncOk', updated?.name ?? id) },
          });
          reloadActiveIfExtensionsChanged();
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          post({ type: 'toast', payload: { level: 'error', text: t('skills.syncFailed', msg) } });
        } finally {
          skillBusy.delete(id);
          pushExtensions();
        }
      })();
      return;
    }
    if (message.type === 'deleteSkill') {
      void (async () => {
        const id = message.payload.id;
        const oldName = installedSkills.find((s) => s.id === id)?.name ?? id;
        installedSkills = await deleteInstalledSkill(storageRoot, id);
        pushExtensions();
        post({ type: 'toast', payload: { level: 'info', text: t('skills.deleted', oldName) } });
        reloadActiveIfExtensionsChanged();
      })();
      return;
    }
    if (message.type === 'scanAgentSkills') {
      void (async () => {
        if (skillsScanningImport) return;
        skillsScanningImport = true;
        pushExtensions();
        try {
          const existingIds = new Set(installedSkills.map((s) => s.id));
          const scanned = await scanAgentSkills({
            workspacePath,
            storageRoot,
            existingIds,
          });
          skillImportCandidates = scanned.items;
          skillScannedSources = scanned.scannedSources;
        } finally {
          skillsScanningImport = false;
          pushExtensions();
        }
      })();
      return;
    }
    if (message.type === 'pickLocalSkillDir') {
      void (async () => {
        const picked = await platform.pickOpenDialog({
          canSelectMany: false,
          canSelectFiles: false,
          canSelectFolders: true,
          defaultPath: workspacePath,
          title: t('skills.pickDirTitle'),
        });
        const folderPath = picked[0];
        if (!folderPath) return;
        const existingIds = new Set(installedSkills.map((s) => s.id));
        const fromDir = await scanLocalSkillDirectory(folderPath, existingIds).catch(() => []);
        if (fromDir.length === 0) {
          post({ type: 'toast', payload: { level: 'info', text: t('skills.noSkillsInDir') } });
          return;
        }
        const prev = skillImportCandidates ?? [];
        const newKeys = new Set(fromDir.map((item) => item.key));
        skillImportCandidates = [...fromDir, ...prev.filter((item) => !newKeys.has(item.key))];
        skillScannedSources = [...new Set([...(skillScannedSources ?? []), folderPath])];
        pushExtensions();
      })();
      return;
    }
    if (message.type === 'importLocalSkills') {
      void (async () => {
        if (!platform.isWorkspaceTrusted()) {
          post({ type: 'toast', payload: { level: 'error', text: t('workspace.untrusted') } });
          return;
        }
        if (skillsInstalling) return;
        skillsInstalling = true;
        skillsError = undefined;
        pushExtensions();
        try {
          const res = await importLocalSkills({
            storageRoot,
            skills: message.payload.skills,
            ...(message.payload.agents ? { agents: message.payload.agents } : {}),
          });
          installedSkills = res.all;
          skillImportCandidates = undefined;
          post({
            type: 'toast',
            payload: {
              level: 'info',
              text: t('skills.imported', res.installed.length, res.installed.map((s) => s.name).join(', ')),
            },
          });
          reloadActiveIfExtensionsChanged();
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          skillsError = msg;
          post({ type: 'toast', payload: { level: 'error', text: t('skills.importFailed', msg) } });
        } finally {
          skillsInstalling = false;
          pushExtensions();
        }
      })();
      return;
    }
    if (message.type === 'upsertMcpServer') {
      void (async () => {
        const next = upsertMcpServerSetting(platform.settings.get<unknown>('mcpServers', []), message.payload);
        await writeSetting(undefined, 'mcpServers', next.length > 0 ? next : undefined);
        pushExtensions();
        post({ type: 'toast', payload: { level: 'info', text: t('mcp.saved', message.payload.name) } });
        reloadActiveIfExtensionsChanged();
      })();
      return;
    }
    if (message.type === 'toggleMcpServer') {
      void (async () => {
        const next = toggleMcpServerSetting(platform.settings.get<unknown>('mcpServers', []), message.payload);
        await writeSetting(undefined, 'mcpServers', next.length > 0 ? next : undefined);
        pushExtensions();
        reloadActiveIfExtensionsChanged();
      })();
      return;
    }
    if (message.type === 'deleteMcpServer') {
      void (async () => {
        const id = message.payload.id;
        const oldName = readMcpServers().find((s) => s.id === id)?.name ?? id;
        const next = deleteMcpServerSetting(platform.settings.get<unknown>('mcpServers', []), id);
        await writeSetting(undefined, 'mcpServers', next.length > 0 ? next : undefined);
        pushExtensions();
        post({ type: 'toast', payload: { level: 'info', text: t('mcp.deleted', oldName) } });
        reloadActiveIfExtensionsChanged();
      })();
      return;
    }
    if (message.type === 'scanAgentMcpConfigs') {
      void (async () => {
        if (mcpScanningImport) return;
        mcpScanningImport = true;
        pushExtensions();
        try {
          const existingIds = new Set(readMcpServers().map((s) => s.id));
          const scanned = await scanAgentMcpConfigs({
            workspacePath,
            dshProfile: safeProfile(platform.settings.get<string>('dsh.profile', 'web') || 'web'),
            existingIds,
          });
          mcpImportCandidates = scanned.items;
          mcpScannedSources = scanned.scannedSources;
        } finally {
          mcpScanningImport = false;
          pushExtensions();
        }
      })();
      return;
    }
    if (message.type === 'pickMcpConfigFile') {
      void (async () => {
        const picked = await platform.pickOpenDialog({
          canSelectMany: false,
          canSelectFiles: true,
          canSelectFolders: false,
          defaultPath: workspacePath,
          title: t('mcp.pickConfigTitle'),
          filters: {
            'MCP Config': ['json', 'jsonc', 'toml', 'yaml', 'yml'],
          },
        });
        const filePath = picked[0];
        if (!filePath) return;
        const content = await platform.workbench.readFile(filePath);
        if (!content) return;
        const parsed = parseMcpConfigFileContent(content, filePath, workspacePath);
        if (parsed.length === 0) {
          post({ type: 'toast', payload: { level: 'info', text: t('mcp.noServersInFile') } });
          return;
        }
        const existingIds = new Set(readMcpServers().map((s) => s.id));
        const fromFile: McpImportCandidate[] = parsed.map((server) => ({
          key: `file:${filePath}:${server.name}`,
          ...server,
          sourceAgentId: 'file',
          sourceAgentName: basename(filePath),
          sourcePath: filePath,
          ...(existingIds.has(normalizeMcpId(server.name)) ? { conflict: true } : {}),
        }));
        const prev = mcpImportCandidates ?? [];
        const prevKeys = new Set(fromFile.map((item) => item.key));
        mcpImportCandidates = [...fromFile, ...prev.filter((item) => !prevKeys.has(item.key))];
        mcpScannedSources = [...new Set([...(mcpScannedSources ?? []), filePath])];
        pushExtensions();
      })();
      return;
    }
    if (message.type === 'fetchSkillMarket') {
      void (async () => {
        const seq = ++skillMarketSeq;
        skillMarket = {
          items: skillMarket?.items ?? [],
          source: skillMarket?.source ?? 'fallback',
          loading: true,
          ...(message.payload.query ? { query: message.payload.query } : {}),
          ...(skillMarket?.updatedAt ? { updatedAt: skillMarket.updatedAt } : {}),
        };
        pushExtensions();
        const next = await fetchOnlineSkillMarket({
          query: message.payload.query,
          force: message.payload.force,
          getHttpProxy: () => platform.settings.getHttpProxy(),
        });
        if (seq !== skillMarketSeq) return;
        skillMarket = next;
        pushExtensions();
      })();
      return;
    }
    if (message.type === 'fetchMcpMarket') {
      void (async () => {
        const seq = ++mcpMarketSeq;
        mcpMarket = {
          items: mcpMarket?.items ?? [],
          source: mcpMarket?.source ?? 'fallback',
          loading: true,
          ...(message.payload.query ? { query: message.payload.query } : {}),
          ...(mcpMarket?.updatedAt ? { updatedAt: mcpMarket.updatedAt } : {}),
        };
        pushExtensions();
        const next = await fetchOnlineMcpMarket({
          query: message.payload.query,
          force: message.payload.force,
          getHttpProxy: () => platform.settings.getHttpProxy(),
        });
        if (seq !== mcpMarketSeq) return;
        mcpMarket = next;
        pushExtensions();
      })();
      return;
    }
    if (message.type === 'importMcpServers') {
      void (async () => {
        const next = importMcpServersSetting(
          platform.settings.get<unknown>('mcpServers', []),
          message.payload.servers,
          message.payload.agents,
        );
        await writeSetting(undefined, 'mcpServers', next.length > 0 ? next : undefined);
        mcpImportCandidates = undefined;
        pushExtensions();
        post({
          type: 'toast',
          payload: { level: 'info', text: t('mcp.imported', message.payload.servers.length) },
        });
        reloadActiveIfExtensionsChanged();
      })();
      return;
    }
    if (message.type === 'setProjectWorktreeConfig') {
      void (async () => {
        const currentConfigs = parseProjectConfigs(platform.settings.get<unknown>('projects', {}));
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
        const picked = await platform.pickOpenDialog({
          canSelectMany: false,
          canSelectFiles: false,
          canSelectFolders: true,
          title: t('project.pickTitle'),
        });
        const folder = picked[0];
        if (!folder) return;
        await saveRecentProjectPath(folder);
        pushProjects();
      })();
      return;
    }
    if (message.type === 'removeRecentProject') {
      void (async () => {
        const next = removeRecentProjectFromList(readRecentProjects(), message.payload.path);
        await platform.globalState.update(RECENT_PROJECTS_KEY, next);
        hub?.removeProjectSessions(message.payload.path);
        pushProjects();
      })();
      return;
    }
    if (message.type === 'openProject') {
      void (async () => {
        const targetPath = normalizeProjectPath(message.payload.path) || message.payload.path;
        const matching = folders().find((f) => (normalizeProjectPath(f.path) || f.path) === targetPath);
        if (message.payload.inPlace || matching) {
          await switchWorkspace(matching ? (normalizeProjectPath(matching.path) || matching.path) : targetPath);
        } else {
          await saveRecentProjectPath(targetPath);
          pushProjects();
          await platform.openProjectWindow(targetPath);
        }
      })();
      return;
    }
    if (message.type === 'newWorktreeSession') {
      void (async () => {
        if (!platform.isWorkspaceTrusted()) {
          post({ type: 'toast', payload: { level: 'error', text: t('workspace.untrusted') } });
          return;
        }
        const repoPath = normalizeProjectPath(message.payload.path ?? workspacePath) || (message.payload.path ?? workspacePath);
        const configs = parseProjectConfigs(platform.settings.get<unknown>('projects', {}));
        const config = configs[repoPath] ?? EMPTY_WORKTREE_CONFIG;
        const branch =
          message.payload.branch ??
          (await mobileAwareWorkbench.input({
            title: t('project.worktreeBranchPrompt'),
            prompt: t('project.worktreeBranchPrompt'),
            placeHolder: 'feat/my-task',
            allowEmpty: true,
          }));
        if (branch === undefined && message.payload.branch === undefined) return;
        try {
          const result = await createProjectWorktree({
            repoPath,
            ...(branch ? { branch } : {}),
            config,
            log,
          });
          // 多 worktree 并行标签（P1-5）：保留已有运行中的标签，独立打开绑定到该 worktree 的新标签
          await saveRecentProjectPath(result.worktreePath);
          workspacePath = result.worktreePath;
          await platform.workspaceState.update(FOLDER_KEY, workspacePath);
          startIfNeeded();
          ensureUnifiedTabsRestored(active);
          const backendId = active?.backend.profile.id ?? targetBackendId;
          unifiedTabs.openNew(backendId, { path: result.worktreePath, branch: result.branch });
          if (active) {
            active.workspacePath = result.worktreePath;
            active.backend.controller.setWorkspace(result.worktreePath);
            await withSuppressedTabSync(() => active!.backend.controller.handle({ type: 'newSession', payload: {} }));
          }
          pushProjects();
          pushUnifiedTabs(true);
          void hub?.refreshSourceControl();
          post({ type: 'toast', payload: { level: 'info', text: t('project.worktreeSessionCreated', result.worktreePath) } });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          post({ type: 'toast', payload: { level: 'error', text: t('project.worktreeFailed', msg) } });
        }
      })();
      return;
    }
    if (message.type === 'removeWorktree') {
      void (async () => {
        if (!platform.isWorkspaceTrusted()) {
          post({ type: 'toast', payload: { level: 'error', text: t('workspace.untrusted') } });
          return;
        }
        const target = normalizeProjectPath(message.payload.path) || message.payload.path;
        // 若该 worktree 上仍有并行运行的会话标签，拒绝移除，避免中断进行中的智能体
        const runningOnTarget = buildUnifiedTabsState().items.some(
          (tab) => tab.running && tab.worktreePath && (normalizeProjectPath(tab.worktreePath) || tab.worktreePath) === target,
        );
        if (runningOnTarget) {
          post({ type: 'toast', payload: { level: 'error', text: t('rollback.running') } });
          return;
        }
        const confirmed =
          message.payload.confirmed === true ||
          (await mobileAwareWorkbench.confirm(
            t('project.worktreeRemoveConfirm'),
            t('project.worktreeRemoveDetail', target),
            t('project.worktreeRemoveAction'),
          ));
        if (!confirmed) return;
        try {
          const { mainRepoPath } = await removeProjectWorktree({ worktreePath: target, log });
          const nextRecent = removeRecentProjectFromList(readRecentProjects(), target);
          await platform.globalState.update(RECENT_PROJECTS_KEY, nextRecent);
          hub?.removeProjectSessions(target);
          if (target === workspacePath) {
            await switchWorkspace(mainRepoPath);
          } else {
            pushProjects();
          }
          post({ type: 'toast', payload: { level: 'info', text: t('project.worktreeRemoved', target) } });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          post({ type: 'toast', payload: { level: 'error', text: t('project.worktreeRemoveFailed', msg) } });
        }
      })();
      return;
    }
    if (message.type === 'createWorktree') {
      void (async () => {
        if (!platform.isWorkspaceTrusted()) {
          post({ type: 'toast', payload: { level: 'error', text: t('workspace.untrusted') } });
          return;
        }
        const targetPath = normalizeProjectPath(message.payload.path) || message.payload.path;
        const configs = parseProjectConfigs(platform.settings.get<unknown>('projects', {}));
        const config = configs[targetPath] ?? EMPTY_WORKTREE_CONFIG;
        const branch =
          message.payload.branch ??
          (await mobileAwareWorkbench.input({
            title: t('project.worktreeBranchPrompt'),
            prompt: t('project.worktreeBranchPrompt'),
            placeHolder: 'feat/my-task',
            allowEmpty: true,
          }));
        if (branch === undefined && message.payload.branch === undefined) return;
        try {
          const result = await createProjectWorktree({
            repoPath: message.payload.path,
            ...(branch ? { branch } : {}),
            config,
            log,
          });
          await saveRecentProjectPath(result.worktreePath);
          pushProjects();
          post({ type: 'toast', payload: { level: 'info', text: t('project.worktreeCreated', result.worktreePath) } });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          post({ type: 'toast', payload: { level: 'error', text: t('project.worktreeFailed', msg) } });
        }
      })();
      return;
    }
    if (message.type === 'runProjectVerify') {
      void (async () => {
        if (!platform.isWorkspaceTrusted()) {
          post({ type: 'toast', payload: { level: 'error', text: t('workspace.untrusted') } });
          return;
        }
        const targetPath = normalizeProjectPath(message.payload.path) || message.payload.path;
        const configs = parseProjectConfigs(platform.settings.get<unknown>('projects', {}));
        const config = configs[targetPath] ?? EMPTY_WORKTREE_CONFIG;
        if (config.verifyCommands.length === 0) {
          post({ type: 'toast', payload: { level: 'info', text: t('project.noVerifyCommands') } });
          return;
        }
        const termName = `Verify: ${basename(message.payload.path)}`;
        await platform.runInTerminal({
          name: termName,
          cwd: message.payload.path,
          commands: config.verifyCommands,
        });
        post({ type: 'toast', payload: { level: 'info', text: t('project.verifyStarted', basename(message.payload.path)) } });
      })();
      return;
    }
    if (message.type === 'setAppearance') {
      void applyAppearancePatch(message.payload).catch((error: unknown) => {
        post({
          type: 'toast',
          payload: { level: 'error', text: t('appearance.failed', error instanceof Error ? error.message : String(error)) },
        });
        post({ type: 'appearance', payload: readAppearance() });
      });
      return;
    }
    if (message.type === 'setPreferences') {
      void applyPreferencesPatch(message.payload).catch((error: unknown) => {
        post({
          type: 'toast',
          payload: {
            level: 'error',
            text: t('preferences.failed', error instanceof Error ? error.message : String(error)),
          },
        });
        post({ type: 'preferences', payload: readPreferences() });
      });
      return;
    }
    if (message.type === 'openSettings') {
      platform.openHostSettings();
      return;
    }
    if (message.type === 'openExternal') {
      openExternalVoid(message.payload.url);
      return;
    }
    if (message.type === 'showLogs') {
      platform.showLogs();
      return;
    }
    if (message.type === 'selectFolder') {
      void selectFolderCommand();
      return;
    }
    if (message.type === 'previewFile') {
      void sendInlineFile(message.payload.path);
      return;
    }
    if (message.type === 'saveWorkspaceFile') {
      void (async () => {
        const rawPath = message.payload.path;
        if (!platform.isWorkspaceTrusted()) {
          post({ type: 'fileSaved', payload: { path: rawPath, ok: false, error: t('workspace.untrusted') } });
          post({ type: 'toast', payload: { level: 'error', text: t('workspace.untrusted') } });
          return;
        }
        const fullPath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(workspacePath, rawPath);
        const relCheck = relative(workspacePath, fullPath);
        if (relCheck.startsWith('..') || isAbsolute(relCheck)) {
          post({ type: 'fileSaved', payload: { path: rawPath, ok: false, error: 'EACCES' } });
          post({ type: 'toast', payload: { level: 'error', text: t('file.saveFailed', basename(rawPath), 'EACCES') } });
          return;
        }
        // 解析真实路径防止符号链接逃逸工作区根目录
        try {
          const realRoot = await realpath(workspacePath).catch(() => resolve(workspacePath));
          const realTarget = await realpath(fullPath).catch(async () => {
            const realParent = await realpath(dirname(fullPath));
            return resolve(realParent, basename(fullPath));
          });
          const realRel = relative(realRoot, realTarget);
          if (realRel.startsWith('..') || isAbsolute(realRel)) {
            post({ type: 'fileSaved', payload: { path: rawPath, ok: false, error: 'EACCES' } });
            post({ type: 'toast', payload: { level: 'error', text: t('file.saveFailed', basename(rawPath), 'EACCES') } });
            return;
          }
        } catch {
          // 目标目录尚不存在时依赖后续 writeFile 报错
        }
        try {
          await platform.workbench.writeFile(fullPath, message.payload.content);
          post({ type: 'fileSaved', payload: { path: rawPath, ok: true } });
          post({ type: 'toast', payload: { level: 'info', text: t('file.saved', basename(fullPath)) } });
          void hub?.refreshSourceControl();
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          post({ type: 'fileSaved', payload: { path: rawPath, ok: false, error: msg } });
          post({ type: 'toast', payload: { level: 'error', text: t('file.saveFailed', basename(fullPath), msg) } });
        }
      })();
      return;
    }
    if (message.type === 'rollbackToTurn') {
      void (async () => {
        if (!platform.isWorkspaceTrusted()) {
          post({ type: 'toast', payload: { level: 'error', text: t('workspace.untrusted') } });
          return;
        }
        const snap = active?.backend.controller.peekSnapshot?.() ?? active?.backend.controller.snapshot();
        const sid = snap?.session.id;
        if (!sid) {
          post({ type: 'toast', payload: { level: 'error', text: t('rollback.noTurn') } });
          return;
        }
        if (snap.session.running) {
          post({ type: 'toast', payload: { level: 'error', text: t('rollback.running') } });
          return;
        }
        const confirmed =
          message.payload.confirmed === true ||
          (await mobileAwareWorkbench.confirm(
            t('checkpoint.confirm', message.payload.turnSeq),
            t('checkpoint.confirmDetail', message.payload.turnSeq),
            t('checkpoint.action'),
          ));
        if (!confirmed) return;
        const targetCwd = active?.workspacePath ?? workspacePath;
        const res = await restoreTurnCheckpoint(targetCwd, sid, message.payload.turnSeq);
        if (res.ok) {
          void hub?.refreshSourceControl();
          post({ type: 'toast', payload: { level: 'info', text: t('checkpoint.restored', message.payload.turnSeq) } });
        } else {
          post({ type: 'toast', payload: { level: 'error', text: t('checkpoint.failed', res.error ?? '') } });
        }
      })();
      return;
    }
    if (message.type === 'forkSessionAtTurn' || message.type === 'editAndResendTurn') {
      void (async () => {
        const snap = active?.backend.controller.peekSnapshot?.() ?? active?.backend.controller.snapshot();
        if (!snap) return;
        const targetTurn = message.payload.turnSeq;
        const isEdit = message.type === 'editAndResendTurn';
        const targetCwd = active?.workspacePath ?? workspacePath;

        // 编辑重发且勾选了同步回滚工作区时，先回滚到上一回合检查点
        if (isEdit && message.payload.rollbackFiles && snap.session.id && targetTurn > 1) {
          await restoreTurnCheckpoint(targetCwd, snap.session.id, targetTurn - 1);
          void hub?.refreshSourceControl();
        }

        // 整理前 N 轮（编辑重发时为前 N-1 轮）的对话上下文摘要，跨所有底层通用
        const cutoffTurns = isEdit ? targetTurn - 1 : targetTurn;
        const transcriptParts: string[] = [];
        let seenTurns = 0;
        for (const item of snap.items) {
          if (item.kind === 'user' && item.pending !== 'queued' && !item.queue) {
            seenTurns += 1;
            if (seenTurns > cutoffTurns) break;
            transcriptParts.push(`User (Turn ${seenTurns}):\n${item.text.slice(0, 2_000)}`);
          } else if (item.kind === 'assistant' && seenTurns >= 1 && seenTurns <= cutoffTurns && item.markdown) {
            transcriptParts.push(`Assistant (Turn ${seenTurns}):\n${item.markdown.slice(0, 2_500)}`);
          }
        }

        try {
          await openNewTabInActive();
          const contextBlock =
            transcriptParts.length > 0
              ? `[Forked conversation context up to turn ${cutoffTurns}]\n\n${transcriptParts.join('\n\n---\n\n')}\n\n---\n\n`
              : '';

          if (isEdit) {
            const combined = `${contextBlock}${message.payload.text}`;
            await active?.backend.controller.handle({
              type: 'sendMessage',
              payload: { text: combined },
            });
          } else {
            const prompt = contextBlock
              ? `${contextBlock}Please acknowledge the forked context above concisely and wait for my next instruction.`
              : 'Continuing from forked session.';
            await active?.backend.controller.handle({
              type: 'sendMessage',
              payload: { text: prompt },
            });
            post({ type: 'toast', payload: { level: 'info', text: t('session.forked', targetTurn) } });
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          post({ type: 'toast', payload: { level: 'error', text: t('session.forkFailed', msg) } });
        }
      })();
      return;
    }
    if (message.type === 'terminalCreate') {
      if (!platform.isWorkspaceTrusted()) {
        post({ type: 'toast', payload: { level: 'error', text: t('workspace.untrusted') } });
        return;
      }
      const fallbackCwd = active?.workspacePath || workspacePath;
      let resolvedCwd = fallbackCwd;
      if (message.payload.cwd?.trim()) {
        const requested = normalizeProjectPath(message.payload.cwd.trim()) || resolve(message.payload.cwd.trim());
        const allowedRoots = [
          normalizeProjectPath(fallbackCwd) || fallbackCwd,
          normalizeProjectPath(workspacePath) || workspacePath,
          ...readRecentProjects().map((p) => p.path),
        ];
        const insideAllowed = allowedRoots.some((root) => {
          const rel = relative(root, requested);
          return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
        });
        if (insideAllowed) resolvedCwd = requested;
      }
      terminalManager.create({
        cwd: resolvedCwd,
        ...(message.payload.title ? { title: message.payload.title } : {}),
        ...(message.payload.cols !== undefined ? { cols: message.payload.cols } : {}),
        ...(message.payload.rows !== undefined ? { rows: message.payload.rows } : {}),
      });
      return;
    }
    if (message.type === 'terminalInput') {
      if (!platform.isWorkspaceTrusted()) return;
      terminalManager.write(message.payload.id, message.payload.data);
      return;
    }
    if (message.type === 'terminalResize') {
      terminalManager.resize(message.payload.id, message.payload.cols, message.payload.rows);
      return;
    }
    if (message.type === 'terminalClose') {
      terminalManager.close(message.payload.id);
      return;
    }
    if (message.type === 'terminalRestart') {
      if (!platform.isWorkspaceTrusted()) return;
      terminalManager.restart(message.payload.id);
      return;
    }
    if (message.type === 'terminalClear') {
      terminalManager.clear(message.payload.id);
      return;
    }
    if (message.type === 'terminalSelect') {
      terminalManager.select(message.payload.id);
      const scrollback = terminalManager.getScrollback(message.payload.id);
      if (scrollback) {
        post({ type: 'terminalOutput', payload: { id: message.payload.id, data: scrollback, reset: true } });
      }
      return;
    }
    if (message.type === 'browserLaunch') {
      if (!platform.isWorkspaceTrusted()) {
        post({ type: 'toast', payload: { level: 'error', text: t('workspace.untrusted') } });
        return;
      }
      void (async () => {
        await ensureBrowserMcpReady();
        await browserManager.launch(message.payload);
      })();
      return;
    }
    if (message.type === 'browserStop') {
      void browserManager.stop();
      return;
    }
    if (message.type === 'browserNavigate') {
      if (!platform.isWorkspaceTrusted()) {
        post({ type: 'toast', payload: { level: 'error', text: t('workspace.untrusted') } });
        return;
      }
      void (async () => {
        try {
          await ensureBrowserMcpReady();
          await browserManager.navigate(message.payload.url);
        } catch (error) {
          post({
            type: 'toast',
            payload: { level: 'error', text: error instanceof Error ? error.message : String(error) },
          });
        }
      })();
      return;
    }
    if (message.type === 'browserBack') {
      void browserManager.goBack().catch(() => undefined);
      return;
    }
    if (message.type === 'browserForward') {
      void browserManager.goForward().catch(() => undefined);
      return;
    }
    if (message.type === 'browserReload') {
      void browserManager.reload().catch(() => undefined);
      return;
    }
    if (message.type === 'browserResize') {
      void browserManager.resize(message.payload.width, message.payload.height, message.payload.preset);
      return;
    }
    if (message.type === 'browserMouse') {
      if (!platform.isWorkspaceTrusted()) return;
      void browserManager.dispatchMouse(message.payload).catch(() => undefined);
      return;
    }
    if (message.type === 'browserKey') {
      if (!platform.isWorkspaceTrusted()) return;
      void browserManager.dispatchKey(message.payload).catch(() => undefined);
      return;
    }
    if (message.type === 'browserSetAiEnabled') {
      browserManager.setAiEnabled(message.payload.enabled);
      if (message.payload.enabled) {
        void ensureBrowserMcpReady().then(() => pushExtensions());
      } else {
        pushExtensions();
      }
      return;
    }
    if (message.type === 'browserClearConsole') {
      browserManager.clearConsole();
      return;
    }
    if (message.type === 'browserRequestFrame') {
      if (browserManager.isAiEnabled() && !browserMcpServer.url) {
        void ensureBrowserMcpReady();
      }
      const frame = browserManager.getLastFrame();
      if (frame) {
        post({ type: 'browserFrame', payload: frame });
      }
      return;
    }
    if (message.type === 'previewMarkdown') {
      void (async () => {
        const rawPath = message.payload.path;
        const fullPath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(workspacePath, rawPath);
        const content = await platform.workbench.readFile(fullPath);
        if (content === undefined) {
          post({
            type: 'markdownPreview',
            payload: { path: rawPath, title: basename(fullPath), error: t('open.failed', basename(fullPath), 'ENOENT') },
          });
          return;
        }
        post({
          type: 'markdownPreview',
          payload: { path: rawPath, title: basename(fullPath), content: content.slice(0, 500_000) },
        });
      })();
      return;
    }
    if (message.type === 'setRemoteEnabled') {
      void remoteBridge.setEnabled(message.payload.enabled).then((state) => {
        if (state.error) {
          post({ type: 'toast', payload: { level: 'error', text: t('remote.startFailed', state.error) } });
        }
      });
      return;
    }
    if (message.type === 'setRemoteConfig') {
      void remoteBridge.updateConfig(message.payload);
      return;
    }
    if (message.type === 'generateRemotePairing') {
      void remoteBridge.generatePairing(message.payload);
      return;
    }
    if (message.type === 'clearRemotePairing') {
      remoteBridge.clearPairing();
      return;
    }
    if (message.type === 'updateRemoteDevice') {
      void remoteBridge.updateDevice(message.payload.deviceId, message.payload).then(({ affectedClientIds }) => {
        if (affectedClientIds.length > 0) {
          const base = active
            ? withUnifiedTabs(active.backend.controller.peekSnapshot?.() ?? active.backend.controller.snapshot())
            : idleSnapshot();
          const snap: HostSnapshot = {
            ...base,
            ...(base.hostKind === undefined ? { hostKind: platform.hostKind } : {}),
            ...(remoteBridgeBox.current && base.remote === undefined
              ? { remote: remoteBridgeBox.current.getState() }
              : {}),
          };
          for (const cid of affectedClientIds) {
            clientHub.sendTo(cid, { type: 'snapshot', payload: snap });
          }
        }
        post({ type: 'toast', payload: { level: 'info', text: t('remote.deviceUpdated') } });
      });
      return;
    }
    if (message.type === 'revokeRemoteDevice') {
      void remoteBridge.revokeDevice(message.payload.deviceId).then(() => {
        post({ type: 'toast', payload: { level: 'info', text: t('remote.deviceRevoked') } });
      });
      return;
    }
    if (message.type === 'disconnectAllRemote') {
      void remoteBridge.disconnectAllRemote().then(() => {
        post({ type: 'toast', payload: { level: 'info', text: t('remote.disconnectedAll') } });
      });
      return;
    }
    if (message.type === 'refreshRemoteNetwork') {
      void remoteBridge.refreshNetwork(true);
      return;
    }
    if (message.type === 'probeTailscale') {
      void remoteBridge.probeTailscale();
      return;
    }
    if (message.type === 'configureTailscaleServe') {
      void remoteBridge.configureTailscaleServe(message.payload.enabled).then((res) => {
        if (!res.ok) {
          post({
            type: 'toast',
            payload: { level: 'error', text: t('remote.tailscaleServeFailed', res.manualCommand) },
          });
        } else {
          post({
            type: 'toast',
            payload: { level: 'info', text: message.payload.enabled ? t('remote.tailscaleServeEnabled') : t('remote.tailscaleServeDisabled') },
          });
        }
      });
      return;
    }
    if (message.type === 'probeQuickTunnel') {
      void remoteBridge.probeQuickTunnel();
      return;
    }
    if (message.type === 'setQuickTunnelEnabled') {
      void remoteBridge.setQuickTunnelEnabled(message.payload.enabled).then((view) => {
        if (message.payload.enabled && view.status === 'error') {
          post({
            type: 'toast',
            payload: { level: 'error', text: t('remote.quickTunnelFailed', view.error ?? 'unknown') },
          });
        } else if (message.payload.enabled && view.url) {
          post({
            type: 'toast',
            payload: { level: 'info', text: t('remote.quickTunnelStarted', view.url) },
          });
        } else if (!message.payload.enabled) {
          post({
            type: 'toast',
            payload: { level: 'info', text: t('remote.quickTunnelStopped') },
          });
        }
      });
      return;
    }
    if (message.type === 'setRemotePushConfig') {
      void pushService.updateConfig(message.payload).then(() => pushRemote());
      return;
    }
    if (message.type === 'testRemotePush') {
      const externalUrl = remoteBridge.buildSessionUrl();
      void pushService
        .dispatch(
          {
            kind: 'test',
            title: 'Halo',
            body: t('remote.pushTestBody'),
            ...(externalUrl ? { externalUrl } : {}),
          },
          { ignoreFocusCheck: true },
        )
        .then((res) => {
          if (res.webPushSent > 0 || res.webhookSent) {
            post({ type: 'toast', payload: { level: 'info', text: t('remote.pushTestOk') } });
          } else {
            post({ type: 'toast', payload: { level: 'info', text: t('remote.pushTestNone') } });
          }
        });
      return;
    }
    if (message.type === 'ready') {
      const isIdeClient = (clientRequestContext.getStore()?.surface ?? 'ide') === 'ide';
      const dshPath = platform.settings.get<string>('dsh.path', '');
      const zcodePath = platform.settings.get<string>('zcode.path', '');
      const claudePath = platform.settings.get<string>('claude.path', '');
      const piPath = platform.settings.get<string>('pi.path', '');
      const codexPath = platform.settings.get<string>('codex.path', '');
      const codebuddyPath = platform.settings.get<string>('codebuddy.path', '');
      if (
        !isBackendEnvCacheComplete(
          { nodeEnv, availability, executables: cachedExecutables },
          profiles(),
          dshPath,
          zcodePath,
          claudePath,
          piPath,
          codexPath,
          codebuddyPath,
        )
      ) {
        // 退出请求级 AsyncLocalStorage，避免后台探测/进程继承 unicastSnapshot 上下文
        clientRequestContext.exit(() => {
          void checkAvailability();
        });
      }
      clientRequestContext.exit(() => {
        startIfNeeded();
        if (hub && !hub.state().sourceControl) {
          void hub.refreshSourceControl();
        }
      });
      if (!active) {
        post({ type: 'snapshot', payload: idleSnapshot() });
        if (isIdeClient && pendingModule) {
          post({ type: 'switchWorkbenchModule', payload: { module: pendingModule } });
          pendingModule = undefined;
        }
        return;
      }
      void active.backend.controller.handle(message).then(() => {
        if (isIdeClient && pendingModule) {
          post({ type: 'switchWorkbenchModule', payload: { module: pendingModule } });
          pendingModule = undefined;
        }
      });
      return;
    }
    void active?.backend.controller.handle(message);
  };

  const executeCommand = async (cmd: HostCommandId): Promise<void> => {
    switch (cmd) {
      case 'openWorkbench':
        pendingModule = 'overview';
        platform.openWorkbenchPanel(t('workbench.title'));
        post({ type: 'switchWorkbenchModule', payload: { module: 'overview' } });
        startIfNeeded();
        return;
      case 'openChat':
        await focusModule('sessions');
        return;
      case 'newSession':
        await focusModule('sessions');
        await openNewTabInActive();
        return;
      case 'interrupt':
        await current()?.controller.handle({ type: 'interrupt', payload: {} });
        return;
      case 'selectBackend': {
        const picked = await platform.pickQuickItem(
          profiles().map((p) => ({
            id: p.id,
            label: p.name,
            description:
              p.kind === 'dsh'
                ? 'dsh'
                : p.kind === 'claude'
                  ? 'claude -p'
                  : p.kind === 'pi'
                    ? 'pi --mode rpc'
                    : p.kind === 'zcode'
                      ? 'zcode app-server'
                      : p.kind === 'codex'
                        ? 'codex app-server'
                        : p.kind === 'codebuddy'
                          ? 'codebuddy -p'
                          : `ACP · ${p.command}`,
            picked: p.id === active?.backend.profile.id,
          })),
          { placeHolder: t('ext.selectBackend') },
        );
        if (!picked) return;
        await selectBackendForCurrentTab(picked.id, true);
        return;
      }
      case 'selectChannel': {
        const backendId = active?.backend.profile.id ?? defaultBackendId;
        const profile = profiles().find((p) => p.id === backendId);
        if (!profile) return;
        const state = accountsState();
        const curBinding = state.channels[backendId] ?? channelFor(backendId);
        const officialItems = state.items
          .filter((a) => a.backendId === backendId)
          .map((acc) => ({
            id: `official:${acc.id}`,
            label: `${t('account.officialPrefix')} · ${acc.label}`,
            description: [acc.identity, acc.plan].filter(Boolean).join(' · ') || acc.status,
            picked:
              curBinding.mode === 'official' &&
              (curBinding.accountId ?? systemAccountId(backendId)) === acc.id,
            mode: 'official' as const,
            accountId: acc.id,
          }));
        const gatewayOn = readProtocolGatewayEnabled();
        const providerItems = readProviders()
          .filter((p) => isProviderReadyForBackend(p, profile, { protocolGatewayEnabled: gatewayOn }))
          .map((p) => ({
            id: `provider:${p.id}`,
            label: `${t('account.providerPrefix')} · ${p.name}`,
            description: p.defaultModel || p.models[0]?.id || '',
            picked: curBinding.mode === 'provider' && curBinding.providerId === p.id,
            mode: 'provider' as const,
            providerId: p.id,
          }));
        const allOptions = [...officialItems, ...providerItems];
        const picked = await platform.pickQuickItem(allOptions, {
          placeHolder: t('ext.selectChannel', profile.name),
        });
        if (!picked) return;
        dispatchWebviewMessage({
          type: 'setBackendChannel',
          payload:
            picked.mode === 'provider'
              ? { backendId, mode: 'provider', providerId: picked.providerId }
              : { backendId, mode: 'official', accountId: picked.accountId },
        });
        return;
      }
      case 'loginAccount': {
        const state = accountsState();
        const backendId = active?.backend.profile.id ?? defaultBackendId;
        const profileMap = new Map(profiles().map((p) => [p.id, p]));
        const candidates = state.items
          .slice()
          .sort((a, b) => (a.backendId === backendId ? -1 : b.backendId === backendId ? 1 : 0))
          .map((acc) => ({
            id: acc.id,
            label: `${profileMap.get(acc.backendId)?.name ?? acc.backendId} · ${acc.label}`,
            description: [acc.identity, acc.status].filter(Boolean).join(' · '),
            backendId: acc.backendId,
          }));
        const picked = await platform.pickQuickItem(candidates, {
          placeHolder: t('ext.loginAccount'),
        });
        if (!picked) return;
        dispatchWebviewMessage({
          type: 'loginAccount',
          payload: { id: picked.id, backendId: picked.backendId },
        });
        return;
      }
      case 'selectModel': {
        const chat = current()?.controller;
        if (!chat) return;
        const models = chat.modelState();
        if (models.options.length === 0) {
          void platform.showMessage('info', t('ext.noModels'));
          return;
        }
        const candidates = models.options.flatMap((option) =>
          (option.efforts.length > 1 ? option.efforts : [undefined]).map((effort, idx) => {
            const description = [option.group, effort?.name].filter(Boolean).join(' · ');
            return {
              id: `${option.provider ?? ''}:${option.model}:${effort?.id ?? idx}`,
              label: option.name,
              ...(description ? { description } : {}),
              ...(option.description ? { detail: option.description } : {}),
              picked: option.provider === models.current?.provider && option.model === models.current?.model,
              option,
              effort: effort?.id ?? option.efforts[0]?.id,
            };
          }),
        );
        const picked = await platform.pickQuickItem(candidates, { placeHolder: t('ext.selectModel') });
        if (picked) {
          await chat.handle({
            type: 'selectModel',
            payload: {
              provider: picked.option.provider,
              model: picked.option.model,
              ...(picked.effort ? { reasoningEffort: picked.effort } : {}),
            },
          });
        }
        return;
      }
      case 'explainSelection': {
        const sending = current()?.controller.askAboutSelection('explain');
        await focusModule('sessions');
        await sending;
        return;
      }
      case 'fixSelection': {
        const sending = current()?.controller.askAboutSelection('fix');
        await focusModule('sessions');
        await sending;
        return;
      }
      case 'testSelection': {
        const sending = current()?.controller.askAboutSelection('test');
        await focusModule('sessions');
        await sending;
        return;
      }
      case 'addToChat':
        current()?.controller.pinActiveEditor();
        await focusModule('sessions');
        return;
      case 'configureApiKey':
        await current()?.controller.configureApiKey();
        return;
      case 'renameSession':
        await current()?.controller.renameSession();
        return;
      case 'selectFolder':
        await selectFolderCommand();
        return;
      case 'restartRuntime':
        current()?.restart();
        return;
      case 'openWebUI':
        await current()?.controller.handle({ type: 'openWebUI', payload: {} });
        return;
      case 'showLogs':
        platform.showLogs();
        return;
      case 'toggleRemoteBridge': {
        const nextEnabled = !remoteBridge.isEnabled;
        const state = await remoteBridge.setEnabled(nextEnabled);
        void platform.showMessage(
          state.error ? 'error' : 'info',
          state.error
            ? t('remote.startFailed', state.error)
            : nextEnabled
              ? t('remote.enabledNotice', state.selectedHost ?? '127.0.0.1', String(state.port ?? 0))
              : t('remote.disabledNotice'),
        );
        return;
      }
      case 'generateRemotePairing': {
        const state = await remoteBridge.generatePairing();
        if (state.pairing) {
          await platform.writeClipboard(state.pairing.url);
          void platform.showMessage('info', t('remote.pairingCopied', state.pairing.url));
        }
        return;
      }
      case 'showRemoteDevices': {
        const state = remoteBridge.getState();
        void platform.showMessage(
          'info',
          t('remote.devicesSummary', state.devices.length, state.connectedClients),
        );
        return;
      }
    }
  };

  return {
    handleWebviewMessage,
    registerIdeClient: (clientId, send) =>
      clientHub.registerClient({
        id: clientId,
        surface: 'ide',
        scope: 'operate',
        visible: true,
        send,
      }),
    onViewVisible: startIfNeeded,
    onWorkspaceChanged: () => active?.backend.controller.workspaceChanged(),
    executeCommand,
    getRemoteState: () => remoteBridge.getState(),
    generateRemotePairing: (opts) => remoteBridge.generatePairing(opts),
    dispose: async () => {
      if (gatewayLogTimer) {
        clearTimeout(gatewayLogTimer);
        gatewayLogTimer = undefined;
      }
      accountAuthFlow.dispose();
      terminalManager.dispose();
      await browserMcpServer.stop();
      await browserManager.dispose();
      for (const dispose of disposers.splice(0)) dispose();
      await remoteBridge.stop();
      clientHub.dispose();
      hub?.dispose();
      hub = undefined;
      const stops = [...managedBackends.values()].map((entry) =>
        entry.backend.stop().catch((error: unknown) => log(`停止底层失败：${String(error)}`)),
      );
      managedBackends.clear();
      lastBackendRunning.clear();
      notifiers.clear();
      active = undefined;
      await Promise.all([...stops, providerProxy.dispose()]);
    },
  };
}

function emptyWorkbenchState(): WorkbenchState {
  return {
    overview: { waiting: [], todos: [], running: [], upcoming: [], unread: [] },
    schedules: [],
    agents: [],
    tasks: { items: [], autoRun: true },
    sessionGroups: [],
  };
}
