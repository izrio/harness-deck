/**
 * 本地二维码 SVG 渲染组件（HD-23）：
 * 零外网请求、纯前端生成标准 QR 矩阵，并保留白底静区以确保浅/深色主题下均可被手机相机可靠识别。
 */
import { useMemo } from 'react';
import { encodeQrMatrix } from '../lib/qr.ts';

export function QrCodeSvg({
  value,
  size = 180,
  label = 'Pairing QR Code',
}: {
  readonly value: string;
  readonly size?: number;
  readonly label?: string;
}) {
  const matrix = useMemo(() => {
    try {
      return encodeQrMatrix(value);
    } catch {
      return undefined;
    }
  }, [value]);

  if (!matrix) return null;

  const margin = 4;
  const viewSize = matrix.size + margin * 2;
  const rects: string[] = [];
  for (let r = 0; r < matrix.size; r += 1) {
    for (let c = 0; c < matrix.size; c += 1) {
      if (matrix.modules[r]?.[c]) {
        rects.push(`M${c + margin},${r + margin}h1v1h-1z`);
      }
    }
  }

  return (
    <svg
      role="img"
      aria-label={label}
      data-testid="remote-pairing-qr"
      width={size}
      height={size}
      viewBox={`0 0 ${viewSize} ${viewSize}`}
      shapeRendering="crispEdges"
      className="shrink-0 rounded-control bg-white p-1 shadow-card"
    >
      <rect width={viewSize} height={viewSize} fill="#ffffff" />
      <path d={rects.join('')} fill="#111111" />
    </svg>
  );
}
