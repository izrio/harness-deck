/**
 * 官方渠道登录编排器（AccountAuthFlow）：
 *
 * 支持两种模式：
 * 1. 托管子进程 OAuth（Codex / Antigravity）：
 *    在受控隔离环境中启动官方 CLI 登录子进程，挂载 BrowserBridge 自动在宿主机打开 OAuth 页面，
 *    实时解析 stdout/stderr 中的授权链接与设备码并推送 `AccountLoginProgress` 给 Webview。
 * 2. IDE 集成终端交互引导（Claude Code / Pi / CodeBuddy / OpenCode / ZCode）：
 *    通过 `HostPlatform.runInTerminal` 注入隔离环境变量后启动官方 CLI 登录命令，
 *    同时后台轮询凭据文件落地，检测到登录成功后自动完成并刷新账号视图。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { AccountConfig, AccountLoginProgress } from '@harness-deck/shared';
import type { SecretStore } from '../host/HostPlatform.ts';
import { BrowserBridge, extractAuthUrlsFromOutput, shouldEnableBrowserBridgeAsync } from '../runtime/browserBridge.ts';
import { extraSearchDirsForCommand, locateExecutable } from '../runtime/locate.ts';
import { locateClaude } from '../claude/locate.ts';
import { locateCodebuddy } from '../codebuddy/locate.ts';
import { locateCodex } from '../codex/locate.ts';
import { locatePi } from '../pi/locate.ts';
import { locateZcode } from '../zcode/locate.ts';
import { accountSlotSecretKey, isSystemAccountId, systemAccountId } from './AccountStore.ts';
import {
  clearAntigravityPrimaryDiskToken,
  clearCodebuddyDiskAuth,
  prepareAccountLaunchPatch,
  readAntigravityDiskTokenRaw,
  readAntigravityPrimaryTokenRaw,
  readCodebuddyDiskAuthSnapshot,
  writeAntigravityDiskTokenRaw,
  writeCodebuddyDiskAuthSnapshot,
} from './AccountIsolation.ts';
import { inspectOfficialAccount } from './AccountInspector.ts';

const DEVICE_CODE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{4,5})\b/u;
/** 官方 CLI 提示用户粘贴授权码 / 回调地址（如 `agy acp --login` 的 "paste the authorization code"）。 */
const AUTH_CODE_PROMPT_RE =
  /paste\s+(?:the\s+|your\s+)?(?:authori[sz]ation|auth|verification)\s+code|enter\s+(?:the\s+|your\s+)?(?:authori[sz]ation|auth)\s+code|full\s+url\s+of\s+the\s+page\s+you\s+land\s+on/iu;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const TERMINAL_POLL_INTERVAL_MS = 2_000;

/** 判断官方 CLI 输出是否在等待用户粘贴授权码。 */
export function detectAuthCodePrompt(output: string): boolean {
  return AUTH_CODE_PROMPT_RE.test(output);
}

export interface AccountLoginHostDeps {
  readonly storageRoot: string;
  readonly workspacePath: () => string;
  readonly processEnv: () => Record<string, string | undefined>;
  readonly settingsGet: <T>(key: string, defaultValue: T) => T;
  readonly secrets: SecretStore;
  readonly openExternal: (url: string) => Promise<boolean>;
  readonly runInTerminal: (options: {
    readonly name: string;
    readonly cwd: string;
    readonly commands: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
  }) => Promise<void>;
  readonly log: (line: string) => void;
  readonly onProgress: (progress: AccountLoginProgress | undefined) => void;
  readonly onComplete: (accountId: string, backendId: string) => Promise<void>;
}

interface ActiveLoginSession {
  readonly accountId: string;
  readonly backendId: string;
  cancel: () => void;
  /** 把用户粘贴的授权码写入登录子进程 stdin；仅托管 OAuth 子进程提供。 */
  submitCode?: (code: string) => boolean;
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:-]+$/u.test(value)) return value;
  if (process.platform === 'win32') {
    return `"${value.replace(/"/gu, '\\"')}"`;
  }
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function buildTerminalEnvPrefix(env: Readonly<Record<string, string>>): string {
  const entries = Object.entries(env).filter(([, v]) => v.length > 0);
  if (entries.length === 0) return '';
  if (process.platform === 'win32') {
    return '';
  }
  return `${entries.map(([k, v]) => `${k}=${shellQuote(v)}`).join(' ')} `;
}

export class AccountAuthFlowManager {
  private active: ActiveLoginSession | undefined;
  private currentProgress: AccountLoginProgress | undefined;

  constructor(private readonly deps: AccountLoginHostDeps) {}

  get progress(): AccountLoginProgress | undefined {
    return this.currentProgress;
  }

  private emit(progress: AccountLoginProgress | undefined): void {
    this.currentProgress = progress;
    this.deps.onProgress(progress);
  }

  /**
   * 取消进行中的登录；`dismiss` 为 true 时同时清除进度（关闭弹窗）。
   * 登录已结束（成功 / 失败 / 已取消）时没有活动会话，此时直接清除残留进度，保证弹窗能关闭。
   */
  cancel(accountId?: string, options?: { readonly dismiss?: boolean }): void {
    if (!this.active) {
      if (this.currentProgress && (!accountId || this.currentProgress.accountId === accountId)) {
        this.emit(undefined);
      }
      return;
    }
    if (accountId && this.active.accountId !== accountId) return;
    const prev = this.active;
    this.active = undefined;
    prev.cancel();
    if (options?.dismiss) {
      this.emit(undefined);
      return;
    }
    this.emit({
      accountId: prev.accountId,
      backendId: prev.backendId,
      phase: 'cancelled',
    });
  }

  /** 提交用户从浏览器授权页拿到的授权码（或回调页完整网址）。返回是否已交给登录进程。 */
  submitAuthCode(accountId: string | undefined, code: string): boolean {
    const session = this.active;
    if (!session?.submitCode) return false;
    if (accountId && session.accountId !== accountId) return false;
    const trimmed = code.trim();
    if (!trimmed) return false;
    return session.submitCode(trimmed);
  }

  dispose(): void {
    this.active?.cancel();
    this.active = undefined;
    this.currentProgress = undefined;
  }

  async startLogin(params: {
    readonly backendId: string;
    readonly backendName: string;
    readonly accountId: string;
    readonly account?: AccountConfig;
    readonly acpCommand?: string;
    readonly previousActiveAccountId?: string;
  }): Promise<void> {
    const { backendId, backendName, accountId, account, acpCommand, previousActiveAccountId } = params;
    // 先结束前一个未完成的登录会话
    if (this.active) {
      this.active.cancel();
      this.active = undefined;
    }

    const baseEnv = this.deps.processEnv();
    this.emit({ accountId, backendId, phase: 'starting' });

    const normalized = backendId.toLowerCase();

    // 1. 托管子进程 OAuth 模式：Codex & Antigravity
    if (normalized === 'codex' || normalized === 'antigravity') {
      await this.runManagedCliOAuth({
        backendId,
        backendName,
        accountId,
        ...(account ? { account } : {}),
        ...(acpCommand ? { acpCommand } : {}),
        ...(previousActiveAccountId ? { previousActiveAccountId } : {}),
        baseEnv,
      });
      return;
    }

    // 2. 交互终端引导模式：Claude Code / Pi / CodeBuddy / OpenCode / ZCode / 其它 ACP
    await this.runTerminalGuidedLogin({
      backendId,
      backendName,
      accountId,
      ...(account ? { account } : {}),
      ...(acpCommand ? { acpCommand } : {}),
      ...(previousActiveAccountId ? { previousActiveAccountId } : {}),
      baseEnv,
    });
  }

  private async resolveCommandForBackend(
    backendId: string,
    acpCommand: string | undefined,
    env: Readonly<Record<string, string | undefined>>,
  ): Promise<{ readonly command: string; readonly display: string } | undefined> {
    const normalized = backendId.toLowerCase();
    if (normalized === 'claude') {
      const configured = this.deps.settingsGet<string>('claude.path', '');
      const loc = await locateClaude({ configuredPath: configured, env, platform: process.platform });
      return loc.kind === 'found' ? { command: loc.command, display: 'claude' } : undefined;
    }
    if (normalized === 'codex') {
      const configured = this.deps.settingsGet<string>('codex.path', '');
      const loc = await locateCodex({ configuredPath: configured, env, platform: process.platform });
      return loc.kind === 'found' ? { command: loc.command, display: 'codex' } : undefined;
    }
    if (normalized === 'codebuddy') {
      const configured = this.deps.settingsGet<string>('codebuddy.path', '');
      const loc = await locateCodebuddy({ configuredPath: configured, env, platform: process.platform });
      return loc.kind === 'found' ? { command: loc.command, display: 'codebuddy' } : undefined;
    }
    if (normalized === 'pi') {
      const configured = this.deps.settingsGet<string>('pi.path', '');
      const loc = await locatePi({ configuredPath: configured, env, platform: process.platform });
      return loc.kind === 'found' ? { command: loc.command, display: 'pi' } : undefined;
    }
    if (normalized === 'zcode') {
      const configured = this.deps.settingsGet<string>('zcode.path', '');
      const loc = await locateZcode({
        configuredPath: configured,
        env,
        platform: process.platform,
        fallbackNodePath: process.execPath,
      });
      if (loc.kind !== 'found') return undefined;
      return { command: loc.command, display: 'zcode' };
    }
    const targetCmd = acpCommand?.trim() || (normalized === 'antigravity' ? 'agy' : normalized === 'opencode' ? 'opencode' : '');
    if (!targetCmd) return undefined;
    const loc = await locateExecutable(targetCmd, {
      env,
      platform: process.platform,
      extraDirs: extraSearchDirsForCommand(targetCmd, env, process.platform),
    });
    return loc.kind === 'found' ? { command: loc.command, display: targetCmd } : undefined;
  }

  private async runManagedCliOAuth(params: {
    readonly backendId: string;
    readonly backendName: string;
    readonly accountId: string;
    readonly account?: AccountConfig;
    readonly acpCommand?: string;
    readonly previousActiveAccountId?: string;
    readonly baseEnv: Readonly<Record<string, string | undefined>>;
  }): Promise<void> {
    const { backendId, backendName, accountId, account, acpCommand, previousActiveAccountId, baseEnv } = params;
    const normalized = backendId.toLowerCase();
    const resolved = await this.resolveCommandForBackend(backendId, acpCommand, baseEnv);
    if (!resolved) {
      this.emit({
        accountId,
        backendId,
        phase: 'failed',
        message: `${backendName} CLI not found`,
      });
      return;
    }

    const patch = await prepareAccountLaunchPatch({
      backendId,
      accountId,
      ...(account ? { account } : {}),
      storageRoot: this.deps.storageRoot,
      baseEnv,
      secrets: this.deps.secrets,
      activateSlot: false,
    });

    // Antigravity 登录独立槽位前先备份磁盘上已有的官方凭据，并清理主凭据文件，避免 CLI 静默复用旧账号凭据
    let backupDiskToken: string | undefined;
    if (normalized === 'antigravity') {
      backupDiskToken = await readAntigravityDiskTokenRaw(baseEnv);
      if (backupDiskToken) {
        const owner = previousActiveAccountId || systemAccountId('antigravity');
        if (owner !== accountId) {
          await this.deps.secrets.store(accountSlotSecretKey(owner), backupDiskToken);
        }
        if (!isSystemAccountId(accountId)) {
          await clearAntigravityPrimaryDiskToken(baseEnv);
        }
      }
    }

    let launchEnv: Record<string, string | undefined> = { ...patch.env };
    let bridge: BrowserBridge | undefined;
    let openedUrl = false;
    let latestAuthUrl: string | undefined;
    let latestDeviceCode: string | undefined;
    let awaitingCode = false;
    let outputTail = '';

    const emitWaitingBrowser = (): void => {
      this.emit({
        accountId,
        backendId,
        phase: 'waiting-browser',
        ...(latestAuthUrl ? { authUrl: latestAuthUrl } : {}),
        ...(latestDeviceCode ? { deviceCode: latestDeviceCode } : {}),
        ...(awaitingCode ? { needsAuthCode: true } : {}),
      });
    };

    const handleUrl = (url: string): void => {
      if (latestAuthUrl !== url) {
        latestAuthUrl = url;
        emitWaitingBrowser();
      }
      if (!openedUrl) {
        openedUrl = true;
        void this.deps.openExternal(url);
      }
    };

    if (await shouldEnableBrowserBridgeAsync(launchEnv, process.platform)) {
      try {
        bridge = new BrowserBridge({
          storageRoot: this.deps.storageRoot,
          onOpenUrl: handleUrl,
          log: this.deps.log,
        });
        await bridge.start();
        if (bridge.running) {
          launchEnv = bridge.patchEnv(launchEnv);
        }
      } catch (err) {
        this.deps.log(`启动登录浏览器桥接失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const args = normalized === 'codex' ? ['login'] : ['acp', '--login'];
    // stdin 保持为管道：部分官方 CLI（如 `agy acp --login`）在浏览器授权后需要用户粘贴授权码 / 回调地址
    const child: ChildProcess = spawn(resolved.command, args, {
      cwd: this.deps.workspacePath(),
      env: launchEnv as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdin?.on('error', () => undefined);

    let finished = false;
    let cancelled = false;
    let stderrTail = '';

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (child.stdin && !child.stdin.destroyed) child.stdin.end();
      void bridge?.dispose();
    };

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill();
      cleanup();
      this.active = undefined;
      this.emit({
        accountId,
        backendId,
        phase: 'failed',
        message: 'Login timed out',
      });
    }, LOGIN_TIMEOUT_MS);

    this.active = {
      accountId,
      backendId,
      cancel: () => {
        if (finished) return;
        cancelled = true;
        finished = true;
        child.kill();
        cleanup();
        if (normalized === 'antigravity' && backupDiskToken && !isSystemAccountId(accountId)) {
          void readAntigravityPrimaryTokenRaw(baseEnv).then((cur) => {
            if (!cur) return writeAntigravityDiskTokenRaw(backupDiskToken!, baseEnv);
            return undefined;
          }).catch(() => undefined);
        }
      },
      submitCode: (code: string) => {
        if (finished || !awaitingCode || !child.stdin || child.stdin.destroyed || !child.stdin.writable) return false;
        child.stdin.write(`${code}\n`);
        awaitingCode = false;
        outputTail = '';
        this.emit({ accountId, backendId, phase: 'verifying' });
        return true;
      },
    };

    this.emit({
      accountId,
      backendId,
      phase: 'waiting-browser',
      command: `${resolved.display} ${args.join(' ')}`,
    });

    const observeLine = (raw: string): void => {
      const urls = extractAuthUrlsFromOutput(raw);
      if (urls[0]) handleUrl(urls[0]);
      const codeMatch = DEVICE_CODE_RE.exec(raw);
      if (codeMatch?.[1] && latestDeviceCode !== codeMatch[1]) {
        latestDeviceCode = codeMatch[1];
        emitWaitingBrowser();
      }
      // 输出可能被拆分成多个 chunk，拼接尾部后再识别「粘贴授权码」提示
      outputTail = `${outputTail}${raw}`.slice(-4_000);
      if (!awaitingCode && detectAuthCodePrompt(outputTail)) {
        awaitingCode = true;
        emitWaitingBrowser();
      }
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => observeLine(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-2_000);
      observeLine(chunk);
    });

    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      cleanup();
      this.active = undefined;
      this.emit({
        accountId,
        backendId,
        phase: 'failed',
        message: error.message,
      });
    });

    child.on('exit', (code) => {
      if (finished) return;
      finished = true;
      cleanup();
      this.active = undefined;
      if (cancelled) return;

      void (async () => {
        if (code !== 0) {
          // 登录失败时如果曾备份了 Antigravity 磁盘凭据且主凭据文件被清理或破坏，恢复原凭据
          if (normalized === 'antigravity' && backupDiskToken && !(await readAntigravityPrimaryTokenRaw(baseEnv))) {
            await writeAntigravityDiskTokenRaw(backupDiskToken, baseEnv).catch(() => undefined);
          }
          this.emit({
            accountId,
            backendId,
            phase: 'failed',
            message: stderrTail.trim().split('\n').slice(-3).join(' ') || `Exit code ${String(code)}`,
          });
          return;
        }

        this.emit({ accountId, backendId, phase: 'verifying' });
        if (normalized === 'antigravity') {
          // 独立槽位只认 CLI 刚写入的主凭据文件，绝不回退读取 IDE 独立凭据文件以免串号
          const newToken = isSystemAccountId(accountId)
            ? await readAntigravityDiskTokenRaw(baseEnv)
            : await readAntigravityPrimaryTokenRaw(baseEnv);
          if (newToken) {
            await this.deps.secrets.store(accountSlotSecretKey(accountId), newToken);
          }
        }
        await this.deps.onComplete(accountId, backendId);
        this.emit({ accountId, backendId, phase: 'succeeded' });
      })();
    });
  }

  private async runTerminalGuidedLogin(params: {
    readonly backendId: string;
    readonly backendName: string;
    readonly accountId: string;
    readonly account?: AccountConfig;
    readonly acpCommand?: string;
    readonly previousActiveAccountId?: string;
    readonly baseEnv: Readonly<Record<string, string | undefined>>;
  }): Promise<void> {
    const { backendId, backendName, accountId, account, acpCommand, previousActiveAccountId, baseEnv } = params;
    const normalized = backendId.toLowerCase();
    const resolved = await this.resolveCommandForBackend(backendId, acpCommand, baseEnv);

    // CodeBuddy OAuth 凭据存放在用户级 CodeBuddyExtension/Data/Public/auth/*.info（不随 CODEBUDDY_CONFIG_DIR 隔离）；
    // 登录独立新账号前先备份原磁盘凭据并清理旧槽位，避免 CLI 直接复用已有账号而不弹出登录。
    let backupCodebuddyDiskAuth: string | undefined;
    if (normalized === 'codebuddy' && !isSystemAccountId(accountId)) {
      backupCodebuddyDiskAuth = await readCodebuddyDiskAuthSnapshot(baseEnv);
      if (backupCodebuddyDiskAuth) {
        const owner = previousActiveAccountId || systemAccountId('codebuddy');
        if (owner !== accountId) {
          await this.deps.secrets.store(accountSlotSecretKey(owner), backupCodebuddyDiskAuth);
        }
        await clearCodebuddyDiskAuth(baseEnv);
      }
    }

    const patch = await prepareAccountLaunchPatch({
      backendId,
      accountId,
      ...(account ? { account } : {}),
      storageRoot: this.deps.storageRoot,
      baseEnv,
      secrets: this.deps.secrets,
      activateSlot: false,
    });

    // 收集该账号特有的隔离环境变量（仅传差异项，避免污染用户终端的 PATH 等）
    const isolatedEnv: Record<string, string> = {};
    for (const key of [
      'CLAUDE_CONFIG_DIR',
      'CODEX_HOME',
      'PI_CODING_AGENT_DIR',
      'CODEBUDDY_CONFIG_DIR',
      'CODEBUDDY_INTERNET_ENVIRONMENT',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
    ]) {
      const val = patch.env[key];
      if (val && val !== baseEnv[key]) {
        isolatedEnv[key] = val;
      }
    }

    const bin = resolved?.command ? shellQuote(resolved.command) : (acpCommand?.trim() || normalized);
    let cliCommand: string;
    if (normalized === 'claude') {
      cliCommand = `${bin}`;
    } else if (normalized === 'opencode') {
      cliCommand = `${bin} auth login`;
    } else if (normalized === 'pi') {
      cliCommand = `${bin}`;
    } else if (normalized === 'codebuddy') {
      cliCommand = `${bin}`;
    } else if (normalized === 'zcode') {
      cliCommand = `${bin}`;
    } else {
      cliCommand = bin;
    }

    const envPrefix = buildTerminalEnvPrefix(isolatedEnv);
    const displayCommand = `${envPrefix}${cliCommand}`;

    const termName = `Halo: ${backendName}${account ? ` (${account.label})` : ''}`;
    try {
      await this.deps.runInTerminal({
        name: termName,
        cwd: this.deps.workspacePath(),
        commands: [process.platform === 'win32' ? cliCommand : displayCommand],
        ...(Object.keys(isolatedEnv).length > 0 ? { env: isolatedEnv } : {}),
      });
    } catch (error) {
      this.emit({
        accountId,
        backendId,
        phase: 'failed',
        command: displayCommand,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    this.emit({
      accountId,
      backendId,
      phase: 'waiting-terminal',
      command: displayCommand,
    });

    // 后台轮询凭据是否已经落地（若用户在登录前本来就是已登录态，也允许前端点击「立即检测」完成）
    const initialCheck = await inspectOfficialAccount({
      backendId,
      accountId,
      ...(account ? { account } : {}),
      isActiveSlot: normalized === 'codebuddy',
      storageRoot: this.deps.storageRoot,
      baseEnv,
      secrets: this.deps.secrets,
    });
    const startedAuthenticated = initialCheck.status === 'authenticated';
    let stopped = false;

    const restoreCodebuddyIfNeeded = async () => {
      if (normalized === 'codebuddy' && backupCodebuddyDiskAuth && !(await readCodebuddyDiskAuthSnapshot(baseEnv))) {
        await writeCodebuddyDiskAuthSnapshot(backupCodebuddyDiskAuth, baseEnv).catch(() => undefined);
      }
    };

    const pollTimer = setInterval(() => {
      if (stopped) return;
      void (async () => {
        const res = await inspectOfficialAccount({
          backendId,
          accountId,
          ...(account ? { account } : {}),
          isActiveSlot: normalized === 'codebuddy',
          storageRoot: this.deps.storageRoot,
          baseEnv,
          secrets: this.deps.secrets,
        });
        if (stopped) return;
        const becameAuthenticated =
          res.status === 'authenticated' &&
          (!startedAuthenticated ||
            res.identity !== initialCheck.identity ||
            res.expiresAt !== initialCheck.expiresAt ||
            !isSystemAccountId(accountId));
        if (becameAuthenticated) {
          stopped = true;
          clearInterval(pollTimer);
          clearTimeout(timeoutTimer);
          this.active = undefined;
          await this.deps.onComplete(accountId, backendId);
          this.emit({ accountId, backendId, phase: 'succeeded' });
        }
      })();
    }, TERMINAL_POLL_INTERVAL_MS);
    pollTimer.unref?.();

    const timeoutTimer = setTimeout(() => {
      if (stopped) return;
      stopped = true;
      clearInterval(pollTimer);
      this.active = undefined;
      void restoreCodebuddyIfNeeded();
      this.emit(undefined);
    }, LOGIN_TIMEOUT_MS);
    timeoutTimer.unref?.();

    this.active = {
      accountId,
      backendId,
      cancel: () => {
        if (stopped) return;
        stopped = true;
        clearInterval(pollTimer);
        clearTimeout(timeoutTimer);
        void restoreCodebuddyIfNeeded();
      },
    };
  }
}
