import { z } from 'zod';

import { MAX_TIME_SCALE, physicsStateSchema } from '../physics/protocol/schemas';

export const STARY_SNAPSHOT_FORMAT = 'stary-snapshot' as const;
export const STARY_SNAPSHOT_FORMAT_VERSION = 1 as const;
export const SNAPSHOT_LABEL_MAX_LENGTH = 120;

const nonNegativeFiniteNumberSchema = z.number().nonnegative();
const safeNonNegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * 可恢复内容:恢复宇宙所需的全部信息。内容哈希与快照 ID 只覆盖这一部分。
 */
export const snapshotContentSchema = z.strictObject({
  simulationTimeSeconds: nonNegativeFiniteNumberSchema,
  bodyRevision: safeNonNegativeIntegerSchema,
  timeScale: z.number().positive().max(MAX_TIME_SCALE),
  physicsState: physicsStateSchema,
});

export const snapshotContentHashSchema = z
  .string()
  .regex(/^[0-9a-f]{16}$/, '内容哈希必须是 16 位小写十六进制');

export const snapshotIdSchema = z
  .string()
  .regex(/^snapshot-[0-9a-f]{16}$/, '快照 ID 必须由内容哈希派生');

export const starySnapshotSchema = z.strictObject({
  format: z.literal(STARY_SNAPSHOT_FORMAT),
  formatVersion: z.literal(STARY_SNAPSHOT_FORMAT_VERSION),
  snapshotId: snapshotIdSchema,
  label: z.string().min(1).max(SNAPSHOT_LABEL_MAX_LENGTH).nullable(),
  capturedAtUnixMilliseconds: safeNonNegativeIntegerSchema,
  simulationTimeSeconds: snapshotContentSchema.shape.simulationTimeSeconds,
  bodyRevision: snapshotContentSchema.shape.bodyRevision,
  timeScale: snapshotContentSchema.shape.timeScale,
  physicsState: physicsStateSchema,
  contentHash: snapshotContentHashSchema,
});

export type SnapshotContent = z.infer<typeof snapshotContentSchema>;
export type StarySnapshot = z.infer<typeof starySnapshotSchema>;
