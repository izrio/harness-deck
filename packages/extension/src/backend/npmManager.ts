/**
 * 系统 Node.js / npm 环境探测，以及通过 npm 安装、卸载、切换底层版本。
 * 不依赖 vscode API，便于单元测试和跨平台复用（Windows 上自动通过 spawnSpec 调 npm.cmd）。
 */
import { execFile, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { NodeEnvState } from '@harness-deck/shared';
import { locateExecutable } from '../runtime/locate.ts';
import { LineSplitter, spawnSpec, stopRuntime, trackChild } from '../runtime/launch.ts';
import { parseVersion } from '../runtime/version.ts';
import { isWslEnvironment, isWslWindowsPath } from '../runtime/wsl.ts';

const NPM_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,99}$/u;
const MAX_RETURNED_VERSIONS = 80;

export interface NodeEnvDetection {
  readonly state: NodeEnvState;
  readonly nodeCommand?: string;
  readonly npmCommand?: string;
  readonly npmGlobalBin?: string;
}

export interface NpmCommandResult {
  readonly ok: boolean;
  readonly message?: string;
}

/** 校验传入 `npm install -g <pkg>@<version>` 的版本号或 dist-tag，防止参数注入。 */
export function isValidNpmVersion(version: string): boolean {
  return NPM_VERSION_RE.test(version);
}

/** 解析 `npm list -g --depth=0 --json` 的输出，返回 `包名 -> 版本号`。 */
export function parseNpmGlobalList(stdout: string): Record<string, string> {
  try {
    const parsed = JSON.parse(stdout) as { dependencies?: Record<string, { version?: unknown }> };
    const deps = parsed?.dependencies;
    if (!deps || typeof deps !== 'object') return {};
    const versions: Record<string, string> = {};
    for (const [pkg, info] of Object.entries(deps)) {
      if (typeof info?.version === 'string' && info.version.trim()) {
        versions[pkg] = info.version.trim();
      }
    }
    return versions;
  } catch {
    return {};
  }
}

/** 解析 `npm view <pkg> versions --json` 的输出，返回从新到旧去重后的版本列表。 */
export function parseNpmVersionsOutput(stdout: string): string[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  const raw = typeof parsed === 'string' ? [parsed] : Array.isArray(parsed) ? parsed : [];
  const valid = raw.filter((item): item is string => typeof item === 'string' && isValidNpmVersion(item));
  return [...new Set(valid)].reverse().slice(0, MAX_RETURNED_VERSIONS);
}

/** 在环境变量的 PATH 里补充一个目录（例如 npm 全局 bin），避免重复添加。 */
export function envWithExtraPath(
  env: Readonly<Record<string, string | undefined>>,
  extraDir: string | undefined,
  platform: NodeJS.Platform = process.platform,
): Record<string, string | undefined> {
  const dir = extraDir?.trim();
  if (!dir) return { ...env };
  const sep = platform === 'win32' ? ';' : ':';
  const key = platform === 'win32' && env.Path !== undefined && env.PATH === undefined ? 'Path' : 'PATH';
  const current = env.PATH ?? env.Path ?? '';
  const parts = current.split(sep).filter(Boolean);
  const exists = parts.some((entry) => (platform === 'win32' ? entry.toLowerCase() === dir.toLowerCase() : entry === dir));
  if (exists) return { ...env };
  return { ...env, [key]: [dir, ...parts].join(sep) };
}

interface ExecResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
  readonly timedOut?: boolean;
}

function runCommand(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  timeoutMs: number,
  cwd?: string,
): Promise<ExecResult> {
  const spec = spawnSpec(command, args, platform, env);
  return new Promise((resolve) => {
    execFile(
      spec.file,
      spec.args,
      {
        env: env as NodeJS.ProcessEnv,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        ...(cwd ? { cwd } : {}),
        ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      },
      (error, stdout, stderr) => {
        const exitCode = error && 'code' in error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
        resolve({
          code: exitCode,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          ...(error ? { error } : {}),
          ...(error?.killed === true ? { timedOut: true } : {}),
        });
      },
    );
  });
}

function runStreamingNpm(
  npmCommand: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  timeoutMs: number,
  onLog?: (line: string, stream: 'stdout' | 'stderr') => void,
): Promise<NpmCommandResult> {
  const spec = spawnSpec(npmCommand, args, platform, env);
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(spec.file, spec.args, {
      env: { ...env, NO_COLOR: '1' } as NodeJS.ProcessEnv,
      // npm 读项目目录的 .npmrc；在 IDE 里 cwd 是工作区，切到 home 才与用户在终端里的行为一致。
      cwd: homedir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: platform !== 'win32',
      windowsHide: true,
      ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    trackChild(child);

    const tail: string[] = [];
    const recordLine = (raw: string, stream: 'stdout' | 'stderr') => {
      const line = raw.trimEnd();
      if (!line) return;
      tail.push(line);
      if (tail.length > 20) tail.shift();
      onLog?.(line, stream);
    };
    const stdout = new LineSplitter((line) => recordLine(line, 'stdout'));
    const stderr = new LineSplitter((line) => recordLine(line, 'stderr'));

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void stopRuntime(child, 2_000);
      resolve({ ok: false, message: `npm ${args[0] ?? ''} timed out` });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, message: error.message });
    });
    child.once('exit', (code) => {
      stdout.flush();
      stderr.flush();
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, message: tail.slice(-5).join('\n') || `npm exited with code ${String(code)}` });
    });
  });
}

/** 探测本机是否存在 `node` 和 `npm`，并获取版本号与 npm 全局可执行目录。 */
export async function detectNodeEnv(options: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly isWsl?: boolean;
  readonly wslMountRoots?: readonly string[];
}): Promise<NodeEnvDetection> {
  const platform = options.platform ?? process.platform;
  const inWsl = platform === 'linux' && (options.isWsl ?? isWslEnvironment(options.env));
  const locateOpts = {
    env: options.env,
    platform,
    ...(options.isWsl !== undefined ? { isWsl: options.isWsl } : {}),
    ...(options.wslMountRoots !== undefined ? { wslMountRoots: options.wslMountRoots } : {}),
  };
  const [nodeLoc, npmLoc] = await Promise.all([
    locateExecutable('node', locateOpts),
    locateExecutable('npm', locateOpts),
  ]);

  let hasNode = nodeLoc.kind === 'found';
  let nodeVersion: string | undefined;
  if (nodeLoc.kind === 'found') {
    const res = await runCommand(nodeLoc.command, ['--version'], options.env, platform, 5_000);
    if (res.code === 0 && res.stdout.trim()) nodeVersion = res.stdout.trim();
    else if (res.error) hasNode = false;
  }

  let hasNpm = npmLoc.kind === 'found';
  let npmVersion: string | undefined;
  let npmGlobalBin: string | undefined;
  if (npmLoc.kind === 'found') {
    const [verRes, prefixRes] = await Promise.all([
      runCommand(npmLoc.command, ['--version'], options.env, platform, 5_000, homedir()),
      runCommand(npmLoc.command, ['prefix', '-g'], options.env, platform, 5_000, homedir()),
    ]);
    if (verRes.code === 0 && verRes.stdout.trim()) npmVersion = verRes.stdout.trim();
    else if (verRes.error) hasNpm = false;
    if (prefixRes.code === 0 && prefixRes.stdout.trim()) {
      const prefix = prefixRes.stdout.trim();
      const candidateBin = platform === 'win32' ? prefix : join(prefix, 'bin');
      if (!inWsl || !isWslWindowsPath(candidateBin, options.wslMountRoots)) {
        npmGlobalBin = candidateBin;
      }
    }
  }

  return {
    state: {
      checked: true,
      hasNode,
      hasNpm,
      ...(nodeVersion ? { nodeVersion } : {}),
      ...(npmVersion ? { npmVersion } : {}),
    },
    ...(hasNode && nodeLoc.kind === 'found' ? { nodeCommand: nodeLoc.command } : {}),
    ...(hasNpm && npmLoc.kind === 'found' ? { npmCommand: npmLoc.command } : {}),
    ...(npmGlobalBin ? { npmGlobalBin } : {}),
  };
}

/** 读取 `npm list -g --depth=0 --json` 中已安装的全局包版本。 */
export async function listNpmGlobalPackages(
  npmCommand: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Promise<Record<string, string>> {
  const res = await runCommand(npmCommand, ['list', '-g', '--depth=0', '--json'], env, platform, 10_000, homedir());
  if (!res.stdout.trim()) return {};
  return parseNpmGlobalList(res.stdout);
}

/** 查询 npm registry 上某个包的可安装版本列表（从新到旧）。 */
export async function fetchNpmVersions(
  npmCommand: string,
  pkg: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  const timeoutMs = 20_000;
  // 让 npm 自己快速失败并打印真实错误码，而不是在内置重试里耗到被外层 kill（那时 stderr 往往为空）。
  const res = await runCommand(
    npmCommand,
    ['view', pkg, 'versions', '--json', '--fetch-retries=0', '--fetch-timeout=8000'],
    env,
    platform,
    timeoutMs,
    homedir(),
  );
  if (res.timedOut) {
    throw new Error(`npm view 超时（${String(timeoutMs)}ms），请检查网络、代理或 registry 配置`);
  }
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || res.error?.message || `npm view failed (${String(res.code)})`);
  }
  try {
    return parseNpmVersionsOutput(res.stdout);
  } catch (error) {
    const snippet = res.stdout.trim().slice(0, 200).replace(/\s+/gu, ' ');
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`npm view 输出不是合法 JSON${snippet ? `：${snippet}` : ''}（${detail}）`);
  }
}

/** 通过 `npm install -g <pkg>[@<version>]` 安装或切换版本。 */
export async function installNpmPackage(
  npmCommand: string,
  pkg: string,
  version: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
  onLog?: (line: string, stream: 'stdout' | 'stderr') => void,
): Promise<NpmCommandResult> {
  if (version !== undefined && !isValidNpmVersion(version)) {
    return { ok: false, message: `Invalid version: ${version}` };
  }
  const spec = version ? `${pkg}@${version}` : pkg;
  onLog?.(`$ npm install -g ${spec}`, 'stdout');
  return runStreamingNpm(npmCommand, ['install', '-g', spec], env, platform, 180_000, onLog);
}

/** 通过 `npm uninstall -g <pkg>` 卸载全局包。 */
export async function uninstallNpmPackage(
  npmCommand: string,
  pkg: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
  onLog?: (line: string, stream: 'stdout' | 'stderr') => void,
): Promise<NpmCommandResult> {
  onLog?.(`$ npm uninstall -g ${pkg}`, 'stdout');
  return runStreamingNpm(npmCommand, ['uninstall', '-g', pkg], env, platform, 60_000, onLog);
}

/** 对非 npm 安装的命令（例如 DeepSeek Desktop 自带的 dsh）通过 `--version` 读取版本号。 */
export async function probeCommandVersion(
  command: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  const res = await runCommand(command, ['--version'], env, platform, 3_000);
  if (res.code !== 0 || !res.stdout.trim()) return undefined;
  const parsed = parseVersion(res.stdout.trim());
  if (parsed) return res.stdout.trim().replace(/^v/u, '');
  const first = res.stdout.trim().split(/\r?\n/u, 1)[0]?.trim();
  const match = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/u.exec(first ?? '');
  return match?.[0];
}
