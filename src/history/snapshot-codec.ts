import { z } from 'zod';

import { canonicalJsonStringify, fnv1a64Hex } from './canonical-json';
import {
  snapshotContentSchema,
  starySnapshotSchema,
  STARY_SNAPSHOT_FORMAT,
  STARY_SNAPSHOT_FORMAT_VERSION,
  type SnapshotContent,
  type StarySnapshot,
} from './snapshot-schema';

export const SNAPSHOT_JSON_MAX_BYTES = 64 * 1024 * 1024;

export type SnapshotCodecErrorCode =
  | 'contentHashMismatch'
  | 'invalidJson'
  | 'malformedSnapshot'
  | 'snapshotTooLarge'
  | 'unsupportedFormat'
  | 'unsupportedVersion';

export class SnapshotCodecError extends Error {
  readonly code: SnapshotCodecErrorCode;

  constructor(code: SnapshotCodecErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SnapshotCodecError';
    this.code = code;
  }
}

export interface CreateStarySnapshotInput {
  readonly content: SnapshotContent;
  readonly label?: string | null;
  readonly capturedAtUnixMilliseconds: number;
}

/**
 * 内容哈希只覆盖可恢复内容;规范化序列化保证同一内容在任何平台
 * 得到同一哈希,`-0` 在此过程中归一为 `0`。
 */
export function computeSnapshotContentHash(content: SnapshotContent): string {
  const parsed = snapshotContentSchema.parse(content);
  return fnv1a64Hex(canonicalJsonStringify(parsed));
}

export function createStarySnapshot(input: CreateStarySnapshotInput): StarySnapshot {
  const content = snapshotContentSchema.parse(input.content);
  const normalizedContent = JSON.parse(canonicalJsonStringify(content)) as SnapshotContent;
  const contentHash = fnv1a64Hex(canonicalJsonStringify(normalizedContent));
  return starySnapshotSchema.parse({
    format: STARY_SNAPSHOT_FORMAT,
    formatVersion: STARY_SNAPSHOT_FORMAT_VERSION,
    snapshotId: `snapshot-${contentHash}`,
    label: input.label ?? null,
    capturedAtUnixMilliseconds: input.capturedAtUnixMilliseconds,
    ...normalizedContent,
    contentHash,
  });
}

export function snapshotContentOf(snapshot: StarySnapshot): SnapshotContent {
  return {
    simulationTimeSeconds: snapshot.simulationTimeSeconds,
    bodyRevision: snapshot.bodyRevision,
    timeScale: snapshot.timeScale,
    physicsState: snapshot.physicsState,
  };
}

export function verifySnapshotIntegrity(snapshot: StarySnapshot): void {
  const contentHash = computeSnapshotContentHash(snapshotContentOf(snapshot));
  if (contentHash !== snapshot.contentHash) {
    throw new SnapshotCodecError(
      'contentHashMismatch',
      `快照内容哈希不匹配:期望 ${snapshot.contentHash},实际 ${contentHash}`,
    );
  }
  if (snapshot.snapshotId !== `snapshot-${contentHash}`) {
    throw new SnapshotCodecError(
      'contentHashMismatch',
      `快照 ID 与内容哈希不一致:${snapshot.snapshotId}`,
    );
  }
}

export function encodeStarySnapshotToJson(snapshot: StarySnapshot): string {
  const parsed = starySnapshotSchema.parse(snapshot);
  verifySnapshotIntegrity(parsed);
  return canonicalJsonStringify(parsed);
}

function readFormatEnvelope(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SnapshotCodecError('malformedSnapshot', '快照必须是 JSON 对象');
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (record.format !== STARY_SNAPSHOT_FORMAT) {
    throw new SnapshotCodecError('unsupportedFormat', '文件不是 STARY 快照格式');
  }
  if (record.formatVersion !== STARY_SNAPSHOT_FORMAT_VERSION) {
    throw new SnapshotCodecError(
      'unsupportedVersion',
      `不支持的快照格式版本:${String(record.formatVersion)}`,
    );
  }
}

export function decodeStarySnapshotFromJson(text: string): StarySnapshot {
  if (text.length > SNAPSHOT_JSON_MAX_BYTES) {
    throw new SnapshotCodecError(
      'snapshotTooLarge',
      `快照文本超过 ${String(SNAPSHOT_JSON_MAX_BYTES)} 字符上限`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new SnapshotCodecError('invalidJson', '快照不是合法 JSON', { cause: error });
  }
  readFormatEnvelope(value);
  let snapshot: StarySnapshot;
  try {
    snapshot = starySnapshotSchema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new SnapshotCodecError('malformedSnapshot', 'STARY 快照结构非法', { cause: error });
    }
    throw error;
  }
  verifySnapshotIntegrity(snapshot);
  return snapshot;
}
