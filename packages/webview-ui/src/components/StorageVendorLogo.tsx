/**
 * 远端存储厂商离线品牌徽标（Google Drive / Google Cloud Storage / WebDAV）：
 * 使用静态 `?inline` 矢量资源，零网络请求，完全兼容严格 Webview CSP。
 */
import type { RemoteStorageKind } from '@harness-deck/shared';
import { cn } from '../lib/utils.ts';
import googleCloudLogo from '../assets/storage/google-cloud.svg?inline';
import googleDriveLogo from '../assets/storage/google-drive.svg?inline';
import webdavLogo from '../assets/storage/webdav.svg?inline';

const STORAGE_LOGOS: Readonly<Record<RemoteStorageKind, string>> = {
  'google-drive': googleDriveLogo,
  'google-cloud-storage': googleCloudLogo,
  webdav: webdavLogo,
};

export function StorageVendorLogo({
  kind,
  size = 'md',
  className,
}: {
  readonly kind: RemoteStorageKind;
  readonly size?: 'sm' | 'md' | 'lg';
  readonly className?: string;
}) {
  const sizeCls =
    size === 'sm' ? 'size-4' : size === 'lg' ? 'size-8' : 'size-6';
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center overflow-hidden', sizeCls, className)}
      aria-hidden="true"
      data-storage-logo={kind}
    >
      <img src={STORAGE_LOGOS[kind]} alt="" draggable={false} className="block size-full object-contain" />
    </span>
  );
}
