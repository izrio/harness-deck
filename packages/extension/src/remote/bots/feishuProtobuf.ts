/**
 * 飞书 / Lark 长连接 PBBP2（Protocol Buffers）帧编解码器（零第三方依赖）。
 *
 * 对应官方 proto3 定义：
 * ```proto
 * package pbbp2;
 * message Header { string key = 1; string value = 2; }
 * message Frame {
 *   uint64 SeqID = 1;
 *   uint64 LogID = 2;
 *   int32 service = 3;
 *   int32 method = 4;       // 0 = CONTROL, 1 = DATA
 *   repeated Header headers = 5;
 *   string payload_encoding = 6;
 *   string payload_type = 7;
 *   bytes payload = 8;
 *   string LogIDNew = 9;
 * }
 * ```
 */

export const FEISHU_FRAME_METHOD_CONTROL = 0;
export const FEISHU_FRAME_METHOD_DATA = 1;

export interface FeishuPbHeader {
  readonly key: string;
  readonly value: string;
}

export interface FeishuPbFrame {
  readonly seqId: bigint;
  readonly logId: bigint;
  readonly service: number;
  readonly method: number;
  readonly headers: readonly FeishuPbHeader[];
  readonly payloadEncoding?: string;
  readonly payloadType?: string;
  readonly payload?: Buffer;
  readonly logIdNew?: string;
}

function encodeVarintBigInt(value: bigint): Buffer {
  const bytes: number[] = [];
  let v = value < 0n ? BigInt.asUintN(64, value) : value;
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0n);
  return Buffer.from(bytes);
}

function encodeVarintNumber(value: number): Buffer {
  return encodeVarintBigInt(BigInt(Math.trunc(value)));
}

function decodeVarint(buf: Buffer, offset: number): { readonly value: bigint; readonly nextOffset: number } {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos]!;
    result |= BigInt(byte & 0x7f) << shift;
    pos += 1;
    if ((byte & 0x80) === 0) {
      return { value: result, nextOffset: pos };
    }
    shift += 7n;
    if (shift > 70n) {
      throw new Error('Malformed protobuf varint');
    }
  }
  throw new Error('Truncated protobuf varint');
}

function encodeTag(fieldNumber: number, wireType: number): Buffer {
  return encodeVarintNumber((fieldNumber << 3) | wireType);
}

function encodeBytesField(fieldNumber: number, data: Buffer): Buffer {
  return Buffer.concat([encodeTag(fieldNumber, 2), encodeVarintNumber(data.length), data]);
}

function encodeStringField(fieldNumber: number, text: string): Buffer {
  return encodeBytesField(fieldNumber, Buffer.from(text, 'utf8'));
}

function encodeHeader(header: FeishuPbHeader): Buffer {
  const parts: Buffer[] = [];
  if (header.key) parts.push(encodeStringField(1, header.key));
  if (header.value) parts.push(encodeStringField(2, header.value));
  return Buffer.concat(parts);
}

function decodeHeader(buf: Buffer): FeishuPbHeader {
  let key = '';
  let value = '';
  let pos = 0;
  while (pos < buf.length) {
    const tag = decodeVarint(buf, pos);
    pos = tag.nextOffset;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (wireType === 2) {
      const len = decodeVarint(buf, pos);
      pos = len.nextOffset;
      const end = pos + Number(len.value);
      const slice = buf.subarray(pos, end);
      pos = end;
      if (fieldNumber === 1) key = slice.toString('utf8');
      else if (fieldNumber === 2) value = slice.toString('utf8');
    } else if (wireType === 0) {
      pos = decodeVarint(buf, pos).nextOffset;
    } else if (wireType === 1) {
      pos += 8;
    } else if (wireType === 5) {
      pos += 4;
    } else {
      throw new Error(`Unsupported protobuf wire type: ${wireType}`);
    }
  }
  return { key, value };
}

export function encodeFeishuPbFrame(frame: FeishuPbFrame): Buffer {
  const parts: Buffer[] = [];
  if (frame.seqId !== 0n) {
    parts.push(encodeTag(1, 0), encodeVarintBigInt(frame.seqId));
  }
  if (frame.logId !== 0n) {
    parts.push(encodeTag(2, 0), encodeVarintBigInt(frame.logId));
  }
  if (frame.service !== 0) {
    parts.push(encodeTag(3, 0), encodeVarintNumber(frame.service));
  }
  if (frame.method !== 0) {
    parts.push(encodeTag(4, 0), encodeVarintNumber(frame.method));
  }
  for (const header of frame.headers) {
    parts.push(encodeBytesField(5, encodeHeader(header)));
  }
  if (frame.payloadEncoding) {
    parts.push(encodeStringField(6, frame.payloadEncoding));
  }
  if (frame.payloadType) {
    parts.push(encodeStringField(7, frame.payloadType));
  }
  if (frame.payload && frame.payload.length > 0) {
    parts.push(encodeBytesField(8, frame.payload));
  }
  if (frame.logIdNew) {
    parts.push(encodeStringField(9, frame.logIdNew));
  }
  return Buffer.concat(parts);
}

export function decodeFeishuPbFrame(buf: Buffer): FeishuPbFrame {
  let seqId = 0n;
  let logId = 0n;
  let service = 0;
  let method = 0;
  const headers: FeishuPbHeader[] = [];
  let payloadEncoding: string | undefined;
  let payloadType: string | undefined;
  let payload: Buffer | undefined;
  let logIdNew: string | undefined;

  let pos = 0;
  while (pos < buf.length) {
    const tag = decodeVarint(buf, pos);
    pos = tag.nextOffset;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);

    if (wireType === 0) {
      const val = decodeVarint(buf, pos);
      pos = val.nextOffset;
      if (fieldNumber === 1) seqId = val.value;
      else if (fieldNumber === 2) logId = val.value;
      else if (fieldNumber === 3) service = Number(BigInt.asIntN(32, val.value));
      else if (fieldNumber === 4) method = Number(BigInt.asIntN(32, val.value));
    } else if (wireType === 2) {
      const len = decodeVarint(buf, pos);
      pos = len.nextOffset;
      const end = pos + Number(len.value);
      if (end > buf.length) throw new Error('Truncated protobuf length-delimited field');
      const slice = buf.subarray(pos, end);
      pos = end;
      if (fieldNumber === 5) headers.push(decodeHeader(slice));
      else if (fieldNumber === 6) payloadEncoding = slice.toString('utf8');
      else if (fieldNumber === 7) payloadType = slice.toString('utf8');
      else if (fieldNumber === 8) payload = Buffer.from(slice);
      else if (fieldNumber === 9) logIdNew = slice.toString('utf8');
    } else if (wireType === 1) {
      pos += 8;
    } else if (wireType === 5) {
      pos += 4;
    } else {
      throw new Error(`Unsupported protobuf wire type: ${wireType}`);
    }
  }

  return {
    seqId,
    logId,
    service,
    method,
    headers,
    ...(payloadEncoding !== undefined ? { payloadEncoding } : {}),
    ...(payloadType !== undefined ? { payloadType } : {}),
    ...(payload !== undefined ? { payload } : {}),
    ...(logIdNew !== undefined ? { logIdNew } : {}),
  };
}

export function getFeishuHeader(headers: readonly FeishuPbHeader[], key: string): string | undefined {
  return headers.find((h) => h.key === key)?.value;
}
