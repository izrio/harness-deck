/**
 * 局域网网卡枚举、虚拟网卡过滤与 WSL2 宿主机网卡探测（HD-23）：
 * - 过滤 Docker / WSL / VPN / 虚拟机等虚拟网卡，优先给出手机同一 Wi-Fi 可直连的 LAN IPv4 地址
 * - 在 WSL 环境中只读探测 Windows 宿主机物理局域网网卡（`ipconfig.exe`）与 `netsh portproxy` 规则，
 *   避免默认暴露手机无法直达的 WSL 内部 NAT IP（如 `172.x.x.x`）
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import type { RemoteInterfaceCandidate } from '@harness-deck/shared';
import { isWslEnvironment } from '../runtime/wsl.ts';

const VIRTUAL_INTERFACE_PREFIXES = [
  'docker',
  'br-',
  'veth',
  'virbr',
  'vmnet',
  'vmware',
  'vboxnet',
  'virtualbox',
  'utun',
  'tun',
  'tap',
  'tailscale',
  'wg',
  'wireguard',
  'lo',
  'loopback',
  'wsl',
  'vethernet',
  'hyper-v',
  'cni',
  'flannel',
  'zerotier',
  'clash',
  'mihomo',
  'sing-box',
  'radmin',
  'hamachi',
  'npcap',
  'bluetooth',
  '蓝牙',
];

const WINDOWS_ADAPTER_TYPE_PREFIX_RE =
  /^(?:ethernet\s+adapter|wireless\s+lan\s+adapter|unknown\s+adapter|tunnel\s+adapter|ppp\s+adapter|以太网适配器|无线局域网适配器|未知适配器|隧道适配器)\s+/iu;

const IPV4_RE = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/u;
const IPV4_LINE_KEY_RE = /ipv4/iu;
const GATEWAY_KEY_RE =
  /default\s*gateway|默认网关|預設閘道|デフォルト\s*ゲートウェイ|standardgateway|passerelle|puerta\s+de\s+enlace|기본\s*게이트웨이/iu;
const SUBNET_MASK_KEY_RE = /subnet\s*mask|子网掩码|子網路遮罩|サブネット\s*マスク|subnetzmaske|masque|máscara|서브넷/iu;

const WSL_PROBE_TIMEOUT_MS = 3_000;

export interface WindowsHostInterface {
  readonly name: string;
  readonly address: string;
  readonly hasGateway: boolean;
}

export interface WindowsPortProxyRule {
  readonly listenAddress: string;
  readonly listenPort: number;
  readonly connectAddress: string;
  readonly connectPort: number;
}

export interface WslHostNetworkSnapshot {
  readonly windowsInterfaces: readonly WindowsHostInterface[];
  readonly portProxyRules: readonly WindowsPortProxyRule[];
}

export type WslHostNetworkProbe = () => Promise<WslHostNetworkSnapshot | undefined>;

export function isVirtualInterfaceName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return VIRTUAL_INTERFACE_PREFIXES.some((prefix) => lower.startsWith(prefix) || lower.includes(prefix));
}

function isValidIpv4(address: string): boolean {
  const parts = address.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/u.test(part)) return false;
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

function isUsableLanIpv4(address: string): boolean {
  if (!isValidIpv4(address)) return false;
  if (address.startsWith('127.') || address.startsWith('169.254.') || address === '0.0.0.0') return false;
  return true;
}

function isPrivateLanIpv4(address: string): boolean {
  if (address.startsWith('192.168.') || address.startsWith('10.')) return true;
  const match = /^172\.(\d+)\./u.exec(address);
  if (!match) return false;
  const second = Number(match[1]);
  return second >= 16 && second <= 31;
}

export function listLanInterfaces(
  interfacesMap: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): {
  readonly candidates: readonly RemoteInterfaceCandidate[];
  readonly preferredAddress: string;
} {
  const physical: RemoteInterfaceCandidate[] = [];
  const fallback: RemoteInterfaceCandidate[] = [];

  for (const [name, list] of Object.entries(interfacesMap)) {
    if (!list) continue;
    for (const entry of list) {
      const family = String((entry as { readonly family: string | number }).family);
      if ((family !== 'IPv4' && family !== '4') || entry.internal) continue;
      if (!entry.address || !isUsableLanIpv4(entry.address)) continue;
      const item: RemoteInterfaceCandidate = { name, address: entry.address };
      if (isVirtualInterfaceName(name)) {
        fallback.push(item);
      } else {
        physical.push(item);
      }
    }
  }

  physical.sort((a, b) => {
    const aPriv = isPrivateLanIpv4(a.address) ? 0 : 1;
    const bPriv = isPrivateLanIpv4(b.address) ? 0 : 1;
    return aPriv - bPriv || a.name.localeCompare(b.name);
  });

  const candidates = physical.length > 0 ? physical : fallback;
  return {
    candidates,
    preferredAddress: candidates[0]?.address ?? '127.0.0.1',
  };
}

/** 解码 Windows 控制台原始字节（UTF-8 优先，简体中文回退 GB18030，最后 Latin-1）。 */
export function decodeWindowsConsoleBuffer(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buf);
    } catch {
      return buf.toString('latin1');
    }
  }
}

/**
 * 解析 Windows `ipconfig.exe` 输出（兼容中/英/日等多语言区域设置）：
 * - 提取所有可用 IPv4 网卡及是否具备默认网关
 * - 过滤 vEthernet (WSL) / Docker / VPN 等虚拟网卡，并将带默认网关的物理局域网网卡排在最前
 */
export function parseWindowsIpconfigOutput(output: string): readonly WindowsHostInterface[] {
  const physical: WindowsHostInterface[] = [];
  const fallback: WindowsHostInterface[] = [];

  let currentName: string | undefined;
  let currentAddresses: string[] = [];
  let currentHasGateway = false;
  let seenSubnetMask = false;

  const flush = () => {
    if (!currentName || currentAddresses.length === 0) return;
    const cleanName = currentName.replace(WINDOWS_ADAPTER_TYPE_PREFIX_RE, '').trim() || currentName;
    const virtual = isVirtualInterfaceName(currentName) || isVirtualInterfaceName(cleanName);
    for (const address of currentAddresses) {
      const item: WindowsHostInterface = {
        name: cleanName,
        address,
        hasGateway: currentHasGateway,
      };
      if (virtual) {
        fallback.push(item);
      } else {
        physical.push(item);
      }
    }
  };

  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.replace(/\r$/u, '');
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 新的网卡分段标题：无前导空白且以冒号结尾
    if (!/^\s/u.test(line) && /[:：]$/u.test(trimmed)) {
      flush();
      currentName = trimmed.replace(/[:：]$/u, '').trim();
      currentAddresses = [];
      currentHasGateway = false;
      seenSubnetMask = false;
      continue;
    }

    if (!currentName) continue;

    // 匹配 "Key . . . : Value" 或续行网关值
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx < 0) {
      if (currentHasGateway || seenSubnetMask) {
        const extraGw = IPV4_RE.exec(trimmed)?.[1];
        if (extraGw && isValidIpv4(extraGw) && extraGw !== '0.0.0.0') {
          currentHasGateway = true;
        }
      }
      continue;
    }

    const key = trimmed.slice(0, colonIdx).replace(/\.+$/u, '').trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    const ipv4 = IPV4_RE.exec(value)?.[1];

    if (IPV4_LINE_KEY_RE.test(key)) {
      if (ipv4 && isUsableLanIpv4(ipv4) && !currentAddresses.includes(ipv4)) {
        currentAddresses.push(ipv4);
      }
      continue;
    }

    if (SUBNET_MASK_KEY_RE.test(key)) {
      seenSubnetMask = true;
      continue;
    }

    if (GATEWAY_KEY_RE.test(key)) {
      if (ipv4 && isValidIpv4(ipv4) && ipv4 !== '0.0.0.0') {
        currentHasGateway = true;
      }
      continue;
    }

    // 兜底：若未知区域语言未命中网关关键字，但在子网掩码之后出现非掩码的 IPv4，也视为有网关
    if (seenSubnetMask && ipv4 && isUsableLanIpv4(ipv4) && !ipv4.startsWith('255.')) {
      currentHasGateway = true;
    }
  }

  flush();

  const sortList = (list: WindowsHostInterface[]) =>
    list.sort((a, b) => {
      const aGw = a.hasGateway ? 0 : 1;
      const bGw = b.hasGateway ? 0 : 1;
      if (aGw !== bGw) return aGw - bGw;
      const aPriv = isPrivateLanIpv4(a.address) ? 0 : 1;
      const bPriv = isPrivateLanIpv4(b.address) ? 0 : 1;
      return aPriv - bPriv || a.name.localeCompare(b.name);
    });

  sortList(physical);
  sortList(fallback);

  const selected = physical.length > 0 ? physical : fallback;
  const deduped: WindowsHostInterface[] = [];
  const seen = new Set<string>();
  for (const item of selected) {
    if (seen.has(item.address)) continue;
    seen.add(item.address);
    deduped.push(item);
  }
  return deduped;
}

/** 解析 `netsh interface portproxy show v4tov4` 输出。 */
export function parseWindowsPortProxyV4(output: string): readonly WindowsPortProxyRule[] {
  const rules: WindowsPortProxyRule[] = [];
  for (const rawLine of output.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const match = /^(\*|\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,5})\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,5})$/u.exec(trimmed);
    if (!match) continue;
    const listenAddress = match[1]!;
    const listenPort = Number(match[2]);
    const connectAddress = match[3]!;
    const connectPort = Number(match[4]);
    if (
      listenPort < 1 ||
      listenPort > 65535 ||
      connectPort < 1 ||
      connectPort > 65535 ||
      (listenAddress !== '*' && !isValidIpv4(listenAddress)) ||
      !isValidIpv4(connectAddress)
    ) {
      continue;
    }
    rules.push({ listenAddress, listenPort, connectAddress, connectPort });
  }
  return rules;
}

export function hasMatchingPortProxyRule(
  rules: readonly WindowsPortProxyRule[],
  port: number,
  wslAddress: string,
  windowsAddress: string,
): boolean {
  return rules.some(
    (rule) =>
      rule.listenPort === port &&
      rule.connectPort === port &&
      (rule.listenAddress === '*' || rule.listenAddress === '0.0.0.0' || rule.listenAddress === windowsAddress) &&
      (rule.connectAddress === wslAddress || rule.connectAddress === '127.0.0.1'),
  );
}

/** 生成在 Windows 管理员 PowerShell 中一次性配置 WSL2 端口转发与防火墙放行的命令。 */
export function buildWslPortProxyCommand(port: number, wslAddress: string): string {
  return [
    `netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=${port} 2>$null`,
    `netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=${port} connectaddress=${wslAddress} connectport=${port}`,
    `if (-not (Get-NetFirewallRule -DisplayName "Harness Deck Remote (${port})" -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName "Harness Deck Remote (${port})" -Direction Inbound -LocalPort ${port} -Protocol TCP -Action Allow | Out-Null }`,
  ].join('; ');
}

/**
 * 合并 Linux/WSL 本机网卡与（可选的）Windows 宿主机局域网网卡：
 * - 非 WSL 或未探测到 Windows 网卡时原样返回本机网卡
 * - WSL2 镜像网络（Mirrored）模式下，Windows LAN IP 已存在于本机网卡中，直接去重且不视为 NAT
 * - WSL2 NAT 模式下，Windows 宿主机 LAN IP 排在首位并作为默认首选地址，WSL 虚拟网卡保留为备选项
 */
export function mergeLanInterfaces(
  linuxInterfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
  windowsHostInterfaces: readonly WindowsHostInterface[] = [],
): {
  readonly candidates: readonly RemoteInterfaceCandidate[];
  readonly preferredAddress: string;
  readonly localAddresses: ReadonlySet<string>;
  readonly wslAddress?: string;
} {
  const local = listLanInterfaces(linuxInterfaces);
  const localAddresses = new Set(local.candidates.map((c) => c.address));
  const wslAddress = local.candidates[0]?.address;

  if (windowsHostInterfaces.length === 0) {
    return {
      candidates: local.candidates,
      preferredAddress: local.preferredAddress,
      localAddresses,
      ...(wslAddress ? { wslAddress } : {}),
    };
  }

  const merged: RemoteInterfaceCandidate[] = [];
  const seen = new Set<string>();

  for (const win of windowsHostInterfaces) {
    if (seen.has(win.address)) continue;
    seen.add(win.address);
    const label = localAddresses.has(win.address) ? win.name : `Windows · ${win.name}`;
    merged.push({ name: label, address: win.address });
  }

  for (const item of local.candidates) {
    if (seen.has(item.address)) continue;
    seen.add(item.address);
    merged.push({ name: `WSL · ${item.name}`, address: item.address });
  }

  return {
    candidates: merged,
    preferredAddress: merged[0]?.address ?? local.preferredAddress,
    localAddresses,
    ...(wslAddress ? { wslAddress } : {}),
  };
}

function resolveWindowsSystemTool(exeName: string): string {
  const knownPaths = [
    `/mnt/c/Windows/System32/${exeName}`,
    `/mnt/c/WINDOWS/system32/${exeName}`,
    `/mnt/c/WINDOWS/System32/${exeName}`,
  ];
  for (const candidate of knownPaths) {
    if (existsSync(candidate)) return candidate;
  }
  return exeName;
}

function runWindowsToolRaw(exeName: string, args: readonly string[]): Promise<Buffer | undefined> {
  const cmd = resolveWindowsSystemTool(exeName);
  return new Promise((resolveOut) => {
    let settled = false;
    const chunks: Buffer[] = [];
    const finish = (value: Buffer | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveOut(value);
    };

    let child;
    try {
      // 显式关闭 stdin（'ignore'），避免 WSL interop 下的 Windows 控制台工具阻塞等待输入
      child = spawn(cmd, [...args], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      finish(undefined);
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish(undefined);
    }, WSL_PROBE_TIMEOUT_MS);
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.once('error', () => finish(undefined));
    child.once('close', (code) => {
      if (code !== 0 && chunks.length === 0) {
        finish(undefined);
        return;
      }
      finish(Buffer.concat(chunks));
    });
  });
}

/** 在 WSL 环境中只读探测 Windows 宿主机局域网网卡与 `netsh portproxy` 规则；非 WSL 直接返回 undefined。 */
export async function probeWslHostNetwork(): Promise<WslHostNetworkSnapshot | undefined> {
  if (process.platform !== 'linux' || !isWslEnvironment()) return undefined;
  const [ipconfigBuf, portProxyBuf] = await Promise.all([
    runWindowsToolRaw('ipconfig.exe', []),
    runWindowsToolRaw('netsh.exe', ['interface', 'portproxy', 'show', 'v4tov4']),
  ]);
  const windowsInterfaces = ipconfigBuf ? parseWindowsIpconfigOutput(decodeWindowsConsoleBuffer(ipconfigBuf)) : [];
  const portProxyRules = portProxyBuf ? parseWindowsPortProxyV4(decodeWindowsConsoleBuffer(portProxyBuf)) : [];
  if (windowsInterfaces.length === 0 && portProxyRules.length === 0) return undefined;
  return { windowsInterfaces, portProxyRules };
}
