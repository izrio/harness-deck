/**
 * 局域网网卡枚举与虚拟网卡过滤（HD-23）：
 * 过滤 Docker / WSL / VPN / 虚拟机等虚拟网卡，优先给出手机同一 Wi-Fi 可直连的 LAN IPv4 地址。
 */
import { networkInterfaces } from 'node:os';
import type { RemoteInterfaceCandidate } from '@harness-deck/shared';

const VIRTUAL_INTERFACE_PREFIXES = [
  'docker',
  'br-',
  'veth',
  'virbr',
  'vmnet',
  'vboxnet',
  'utun',
  'tun',
  'tap',
  'tailscale',
  'wg',
  'lo',
  'wsl',
  'vethernet',
  'hyper-v',
  'cni',
  'flannel',
];

export function isVirtualInterfaceName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return VIRTUAL_INTERFACE_PREFIXES.some((prefix) => lower.startsWith(prefix) || lower.includes(prefix));
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
      if (!entry.address || entry.address.startsWith('169.254.')) continue;
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
