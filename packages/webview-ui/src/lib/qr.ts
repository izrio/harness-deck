/**
 * 轻量纯 TypeScript QR Code 字节模式编码器（Versions 1–10，ECC-L，零外部依赖 / 零网络请求）。
 * 用于本地生成手机端配对二维码 SVG。
 */

interface VersionSpec {
  readonly version: number;
  readonly dataBytes: number;
  readonly ecPerBlock: number;
  readonly group1Blocks: number;
  readonly group1DataBytes: number;
  readonly group2Blocks: number;
  readonly group2DataBytes: number;
  readonly alignmentCenters: readonly number[];
}

// ISO/IEC 18004 ECC-L 参数表（Versions 1–10，覆盖最多 ~270 字节 URL）
const VERSION_SPECS: readonly VersionSpec[] = [
  { version: 1, dataBytes: 19, ecPerBlock: 7, group1Blocks: 1, group1DataBytes: 19, group2Blocks: 0, group2DataBytes: 0, alignmentCenters: [] },
  { version: 2, dataBytes: 34, ecPerBlock: 10, group1Blocks: 1, group1DataBytes: 34, group2Blocks: 0, group2DataBytes: 0, alignmentCenters: [6, 18] },
  { version: 3, dataBytes: 55, ecPerBlock: 15, group1Blocks: 1, group1DataBytes: 55, group2Blocks: 0, group2DataBytes: 0, alignmentCenters: [6, 22] },
  { version: 4, dataBytes: 80, ecPerBlock: 20, group1Blocks: 1, group1DataBytes: 80, group2Blocks: 0, group2DataBytes: 0, alignmentCenters: [6, 26] },
  { version: 5, dataBytes: 108, ecPerBlock: 26, group1Blocks: 1, group1DataBytes: 108, group2Blocks: 0, group2DataBytes: 0, alignmentCenters: [6, 30] },
  { version: 6, dataBytes: 136, ecPerBlock: 18, group1Blocks: 2, group1DataBytes: 68, group2Blocks: 0, group2DataBytes: 0, alignmentCenters: [6, 34] },
  { version: 7, dataBytes: 156, ecPerBlock: 20, group1Blocks: 2, group1DataBytes: 78, group2Blocks: 0, group2DataBytes: 0, alignmentCenters: [6, 22, 38] },
  { version: 8, dataBytes: 194, ecPerBlock: 24, group1Blocks: 2, group1DataBytes: 97, group2Blocks: 0, group2DataBytes: 0, alignmentCenters: [6, 24, 42] },
  { version: 9, dataBytes: 232, ecPerBlock: 30, group1Blocks: 2, group1DataBytes: 116, group2Blocks: 0, group2DataBytes: 0, alignmentCenters: [6, 26, 46] },
  { version: 10, dataBytes: 274, ecPerBlock: 18, group1Blocks: 2, group1DataBytes: 68, group2Blocks: 2, group2DataBytes: 69, alignmentCenters: [6, 28, 50] },
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255]!;
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i]!;
    for (let j = 0; j < poly.length; j += 1) {
      next[j]! ^= poly[j]!;
      next[j + 1]! ^= gfMul(poly[j]!, factor);
    }
    poly = next;
  }
  return poly;
}

function rsComputeEcc(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGeneratorPoly(ecCount);
  const res = new Uint8Array(ecCount);
  for (const byte of data) {
    const factor = byte ^ res[0]!;
    res.copyWithin(0, 1);
    res[ecCount - 1] = 0;
    for (let j = 0; j < ecCount; j += 1) {
      res[j]! ^= gfMul(gen[j + 1]!, factor);
    }
  }
  return res;
}

function pushBits(bits: number[], value: number, len: number): void {
  for (let i = len - 1; i >= 0; i -= 1) {
    bits.push((value >>> i) & 1);
  }
}

function encodeCodewords(bytes: Uint8Array, spec: VersionSpec): number[] {
  const bits: number[] = [];
  // Byte mode indicator (0100)
  pushBits(bits, 0b0100, 4);
  const countBits = spec.version >= 10 ? 16 : 8;
  pushBits(bits, bytes.length, countBits);
  for (const b of bytes) pushBits(bits, b, 8);

  const capacityBits = spec.dataBytes * 8;
  const terminatorLen = Math.min(4, capacityBits - bits.length);
  pushBits(bits, 0, terminatorLen);
  while (bits.length % 8 !== 0) bits.push(0);

  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let val = 0;
    for (let b = 0; b < 8; b += 1) val = (val << 1) | (bits[i + b] ?? 0);
    data.push(val);
  }
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (data.length < spec.dataBytes) {
    data.push(padBytes[padIdx % 2]!);
    padIdx += 1;
  }

  const dataBlocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < spec.group1Blocks; i += 1) {
    const block = Uint8Array.from(data.slice(offset, offset + spec.group1DataBytes));
    offset += spec.group1DataBytes;
    dataBlocks.push(block);
    eccBlocks.push(rsComputeEcc(block, spec.ecPerBlock));
  }
  for (let i = 0; i < spec.group2Blocks; i += 1) {
    const block = Uint8Array.from(data.slice(offset, offset + spec.group2DataBytes));
    offset += spec.group2DataBytes;
    dataBlocks.push(block);
    eccBlocks.push(rsComputeEcc(block, spec.ecPerBlock));
  }

  const interleaved: number[] = [];
  const maxDataLen = Math.max(spec.group1DataBytes, spec.group2DataBytes);
  for (let i = 0; i < maxDataLen; i += 1) {
    for (const block of dataBlocks) {
      if (i < block.length) interleaved.push(block[i]!);
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (const ecc of eccBlocks) {
      interleaved.push(ecc[i]!);
    }
  }
  return interleaved;
}

function setFinder(modules: number[][], isFunction: boolean[][], row: number, col: number): void {
  const size = modules.length;
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const r = row + dy;
      const c = col + dx;
      if (r < 0 || c < 0 || r >= size || c >= size) continue;
      const on =
        dy >= 0 &&
        dy <= 6 &&
        dx >= 0 &&
        dx <= 6 &&
        (dy === 0 || dy === 6 || dx === 0 || dx === 6 || (dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4));
      modules[r]![c] = on ? 1 : 0;
      isFunction[r]![c] = true;
    }
  }
}

function setAlignment(modules: number[][], isFunction: boolean[][], row: number, col: number): void {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const on = Math.max(Math.abs(dy), Math.abs(dx)) !== 1;
      modules[row + dy]![col + dx] = on ? 1 : 0;
      isFunction[row + dy]![col + dx] = true;
    }
  }
}

function drawFormatBits(modules: number[][], isFunction: boolean[][], mask: number): void {
  const size = modules.length;
  // ECC Level L = 01，共 15 位：bit 14 为最高位（MSB），bit 0 为最低位（LSB）
  const data = (0b01 << 3) | mask;
  let rem = data << 10;
  for (let i = 4; i >= 0; i -= 1) {
    if ((rem >>> (i + 10)) & 1) rem ^= 0x537 << i;
  }
  const bits = ((data << 10) | rem) ^ 0x5412;

  // 副本 1（左上定位符周围）：(8, 0..5) = bits 14..9，(8, 7) = bit 8，(8, 8) = bit 7，(7, 8) = bit 6，(5..0, 8) = bits 5..0
  for (let i = 0; i < 6; i += 1) {
    const bit = (bits >>> (14 - i)) & 1;
    modules[8]![i] = bit;
    isFunction[8]![i] = true;
  }
  modules[8]![7] = (bits >>> 8) & 1;
  isFunction[8]![7] = true;
  modules[8]![8] = (bits >>> 7) & 1;
  isFunction[8]![8] = true;
  modules[7]![8] = (bits >>> 6) & 1;
  isFunction[7]![8] = true;
  for (let row = 5; row >= 0; row -= 1) {
    modules[row]![8] = (bits >>> row) & 1;
    isFunction[row]![8] = true;
  }

  // 副本 2（左下 + 右上）：(size-1..size-7, 8) = bits 14..8，(size-8, 8) = 固定暗模块 1，(8, size-8..size-1) = bits 7..0
  for (let i = 0; i < 7; i += 1) {
    modules[size - 1 - i]![8] = (bits >>> (14 - i)) & 1;
    isFunction[size - 1 - i]![8] = true;
  }
  modules[size - 8]![8] = 1;
  isFunction[size - 8]![8] = true;
  for (let i = 0; i < 8; i += 1) {
    modules[8]![size - 8 + i] = (bits >>> (7 - i)) & 1;
    isFunction[8]![size - 8 + i] = true;
  }
}

function drawVersionBits(modules: number[][], isFunction: boolean[][], version: number): void {
  if (version < 7) return;
  const size = modules.length;
  let rem = version << 12;
  for (let i = 5; i >= 0; i -= 1) {
    if ((rem >>> (i + 12)) & 1) rem ^= 0x1f25 << i;
  }
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i += 1) {
    const bit = (bits >>> i) & 1;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    modules[a]![b] = bit;
    isFunction[a]![b] = true;
    modules[b]![a] = bit;
    isFunction[b]![a] = true;
  }
}

function maskBit(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

function penaltyScore(modules: number[][]): number {
  const size = modules.length;
  let score = 0;

  // N1: 5+ consecutive same-color modules in rows/cols
  for (let r = 0; r < size; r += 1) {
    let runColor = modules[r]![0]!;
    let runLen = 1;
    for (let c = 1; c < size; c += 1) {
      if (modules[r]![c] === runColor) {
        runLen += 1;
      } else {
        if (runLen >= 5) score += 3 + (runLen - 5);
        runColor = modules[r]![c]!;
        runLen = 1;
      }
    }
    if (runLen >= 5) score += 3 + (runLen - 5);
  }
  for (let c = 0; c < size; c += 1) {
    let runColor = modules[0]![c]!;
    let runLen = 1;
    for (let r = 1; r < size; r += 1) {
      if (modules[r]![c] === runColor) {
        runLen += 1;
      } else {
        if (runLen >= 5) score += 3 + (runLen - 5);
        runColor = modules[r]![c]!;
        runLen = 1;
      }
    }
    if (runLen >= 5) score += 3 + (runLen - 5);
  }

  // N2: 2x2 blocks of same color
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = modules[r]![c]!;
      if (v === modules[r]![c + 1] && v === modules[r + 1]![c] && v === modules[r + 1]![c + 1]) {
        score += 3;
      }
    }
  }

  // N3: 1:1:3:1:1 finder-like pattern with 4 light modules on either side
  const isFinderLike = (seq: readonly number[], start: number): boolean => {
    const a =
      seq[start] === 1 &&
      seq[start + 1] === 0 &&
      seq[start + 2] === 1 &&
      seq[start + 3] === 1 &&
      seq[start + 4] === 1 &&
      seq[start + 5] === 0 &&
      seq[start + 6] === 1 &&
      seq[start + 7] === 0 &&
      seq[start + 8] === 0 &&
      seq[start + 9] === 0 &&
      seq[start + 10] === 0;
    const b =
      seq[start] === 0 &&
      seq[start + 1] === 0 &&
      seq[start + 2] === 0 &&
      seq[start + 3] === 0 &&
      seq[start + 4] === 1 &&
      seq[start + 5] === 0 &&
      seq[start + 6] === 1 &&
      seq[start + 7] === 1 &&
      seq[start + 8] === 1 &&
      seq[start + 9] === 0 &&
      seq[start + 10] === 1;
    return a || b;
  };
  for (let r = 0; r < size; r += 1) {
    const row = modules[r]!;
    for (let c = 0; c <= size - 11; c += 1) {
      if (isFinderLike(row, c)) score += 40;
    }
  }
  for (let c = 0; c < size; c += 1) {
    const col = modules.map((row) => row[c]!);
    for (let r = 0; r <= size - 11; r += 1) {
      if (isFinderLike(col, r)) score += 40;
    }
  }

  // N4: dark ratio deviation from 50%
  let dark = 0;
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) dark += modules[r]![c]!;
  }
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

export interface QrMatrix {
  readonly version: number;
  readonly size: number;
  readonly modules: readonly (readonly boolean[])[];
}

export function encodeQrMatrix(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const spec = VERSION_SPECS.find((s) => bytes.length + (s.version >= 10 ? 3 : 2) <= s.dataBytes);
  if (!spec) {
    throw new Error('QR payload exceeds supported length');
  }

  const size = spec.version * 4 + 17;
  const modules = Array.from({ length: size }, () => Array<number>(size).fill(0));
  const isFunction = Array.from({ length: size }, () => Array<boolean>(size).fill(false));

  setFinder(modules, isFunction, 0, 0);
  setFinder(modules, isFunction, 0, size - 7);
  setFinder(modules, isFunction, size - 7, 0);

  for (let i = 8; i < size - 8; i += 1) {
    const bit = i % 2 === 0 ? 1 : 0;
    modules[6]![i] = bit;
    isFunction[6]![i] = true;
    modules[i]![6] = bit;
    isFunction[i]![6] = true;
  }

  const centers = spec.alignmentCenters;
  for (const r of centers) {
    for (const c of centers) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      setAlignment(modules, isFunction, r, c);
    }
  }

  // Reserve format info + version info areas before placing data
  drawFormatBits(modules, isFunction, 0);
  drawVersionBits(modules, isFunction, spec.version);

  const codewords = encodeCodewords(bytes, spec);
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      const r = upward ? size - 1 - vert : vert;
      for (let dx = 0; dx < 2; dx += 1) {
        const c = right - dx;
        if (isFunction[r]![c]) continue;
        let bit = 0;
        if (bitIndex < totalBits) {
          const byte = codewords[bitIndex >>> 3]!;
          bit = (byte >>> (7 - (bitIndex & 7))) & 1;
          bitIndex += 1;
        }
        modules[r]![c] = bit;
      }
    }
    upward = !upward;
  }

  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    const trial = modules.map((row, r) =>
      row.map((val, c) => (isFunction[r]![c] ? val : val ^ (maskBit(mask, r, c) ? 1 : 0))),
    );
    drawFormatBits(trial, isFunction, mask);
    const score = penaltyScore(trial);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
    }
  }

  const finalModules = modules.map((row, r) =>
    row.map((val, c) => (isFunction[r]![c] ? val : val ^ (maskBit(bestMask, r, c) ? 1 : 0))),
  );
  drawFormatBits(finalModules, isFunction, bestMask);

  return {
    version: spec.version,
    size,
    modules: finalModules.map((row) => row.map((v) => v === 1)),
  };
}
