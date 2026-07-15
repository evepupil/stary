import { COLLISION_MODEL_VERSION } from './model-sources';
import { deterministicSeedInputSchema, type DeterministicSeedInput } from './schemas';
import { compareUtf8 } from './stable-order';

const FNV_1A_64_OFFSET = 0xcbf29ce484222325n;
const FNV_1A_64_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;
const SEED_ENCODING_VERSION = 'collision-seed-v1';

function encodeLength(length: number): readonly number[] {
  if (!Number.isSafeInteger(length) || length < 0 || length > 0xffffffff) {
    throw new RangeError('seed 字段长度超出 32 位范围');
  }
  return [length >>> 24, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff];
}

function hashBytes(bytes: Iterable<number>): bigint {
  let hash = FNV_1A_64_OFFSET;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_1A_64_PRIME) & UINT64_MASK;
  }
  return hash;
}

export function createDeterministicCollisionSeed(input: DeterministicSeedInput): string {
  const parsed = deterministicSeedInputSchema.parse(input);
  const [firstParentId, secondParentId] =
    compareUtf8(parsed.firstParentId, parsed.secondParentId) < 0
      ? [parsed.firstParentId, parsed.secondParentId]
      : [parsed.secondParentId, parsed.firstParentId];
  const fields = [
    SEED_ENCODING_VERSION,
    COLLISION_MODEL_VERSION,
    parsed.eventId,
    firstParentId,
    secondParentId,
    parsed.fragmentKind,
    String(parsed.fragmentOrdinal),
  ];
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (const field of fields) {
    const encoded = encoder.encode(field);
    bytes.push(...encodeLength(encoded.length), ...encoded);
  }
  return hashBytes(bytes).toString(16).padStart(16, '0');
}
