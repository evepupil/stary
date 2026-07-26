const FNV_1A_64_OFFSET = 0xcbf29ce484222325n;
const FNV_1A_64_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

/**
 * 把任意 JSON 兼容值序列化为规范化字符串:对象键按 UTF-16 码元升序、
 * 数组保序、数值使用 JSON 最短往返表示(`-0` 归一为 `0`)。
 * 同一内容在任何平台都得到同一字符串,是内容哈希与快照 ID 的唯一输入。
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number': {
      if (!Number.isFinite(value)) {
        throw new RangeError('规范化 JSON 不允许非有限数值');
      }
      return JSON.stringify(value);
    }
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJsonStringify(item)).join(',')}]`;
      }
      const record = value as Readonly<Record<string, unknown>>;
      const keys = Object.keys(record).sort();
      const entries = keys.map(
        (key) => `${JSON.stringify(key)}:${canonicalJsonStringify(record[key])}`,
      );
      return `{${entries.join(',')}}`;
    }
    default:
      throw new TypeError(`规范化 JSON 不支持 ${typeof value} 类型`);
  }
}

/**
 * 对规范化字符串的 UTF-8 字节计算 FNV-1a 64,输出 16 位十六进制。
 */
export function fnv1a64Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let hash = FNV_1A_64_OFFSET;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_1A_64_PRIME) & UINT64_MASK;
  }
  return hash.toString(16).padStart(16, '0');
}
