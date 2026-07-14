import { z } from 'zod';

import { JULIAN_DAY_SECONDS } from '../constants';
import { bodyStatesSchema } from '../protocol/schemas';

export const ORBIT_PREVIEW_PROTOCOL_VERSION = 1 as const;
export const MIN_TRAJECTORY_PREVIEW_SAMPLE_COUNT = 2;
export const MAX_TRAJECTORY_PREVIEW_SAMPLE_COUNT = 2_048;
export const MAX_TRAJECTORY_PREVIEW_DURATION_SECONDS = 366 * JULIAN_DAY_SECONDS;

const finiteNumberSchema = z.number();
const nonNegativeFiniteNumberSchema = finiteNumberSchema.nonnegative();
const positiveFiniteNumberSchema = finiteNumberSchema.positive();
const safeNonNegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim().length > 0, '标识不能为空白');

const previewPointSchema = z.strictObject({
  timeSeconds: nonNegativeFiniteNumberSchema,
  positionMeters: z.strictObject({
    x: finiteNumberSchema,
    y: finiteNumberSchema,
    z: finiteNumberSchema,
  }),
});

const previewTrackSchema = z.strictObject({
  bodyId: identifierSchema,
  points: z.array(previewPointSchema).min(MIN_TRAJECTORY_PREVIEW_SAMPLE_COUNT),
});

export const trajectoryPreviewRequestSchema = z
  .strictObject({
    version: z.literal(ORBIT_PREVIEW_PROTOCOL_VERSION),
    type: z.literal('trajectoryPreviewRequest'),
    requestId: identifierSchema,
    draftRevision: safeNonNegativeIntegerSchema,
    bodies: bodyStatesSchema,
    draftBodyIds: z.array(identifierSchema).min(1).max(512),
    referenceBodyId: identifierSchema,
    durationSeconds: positiveFiniteNumberSchema.max(MAX_TRAJECTORY_PREVIEW_DURATION_SECONDS),
    sampleCount: z
      .number()
      .int()
      .min(MIN_TRAJECTORY_PREVIEW_SAMPLE_COUNT)
      .max(MAX_TRAJECTORY_PREVIEW_SAMPLE_COUNT),
  })
  .superRefine((request, context) => {
    const bodyIds = new Set(request.bodies.map((body) => body.id));
    const draftBodyIds = new Set<string>();

    request.draftBodyIds.forEach((bodyId, index) => {
      if (draftBodyIds.has(bodyId)) {
        context.addIssue({
          code: 'custom',
          message: `草稿天体 id 重复：${bodyId}`,
          path: ['draftBodyIds', index],
        });
      }
      if (!bodyIds.has(bodyId)) {
        context.addIssue({
          code: 'custom',
          message: `草稿天体不存在：${bodyId}`,
          path: ['draftBodyIds', index],
        });
      }
      draftBodyIds.add(bodyId);
    });

    if (!bodyIds.has(request.referenceBodyId)) {
      context.addIssue({
        code: 'custom',
        message: `参考天体不存在：${request.referenceBodyId}`,
        path: ['referenceBodyId'],
      });
    } else if (draftBodyIds.has(request.referenceBodyId)) {
      context.addIssue({
        code: 'custom',
        message: '参考天体不能是草稿天体',
        path: ['referenceBodyId'],
      });
    }
  });

const stableTrajectoryPreviewRiskSchema = z.strictObject({
  kind: z.literal('stable'),
  bodyId: z.null(),
  otherBodyId: z.null(),
  timeSeconds: z.null(),
});

const collisionTrajectoryPreviewRiskSchema = z.strictObject({
  kind: z.literal('collision'),
  bodyId: identifierSchema,
  otherBodyId: identifierSchema,
  timeSeconds: nonNegativeFiniteNumberSchema,
});

const escapeTrajectoryPreviewRiskSchema = z.strictObject({
  kind: z.literal('escape'),
  bodyId: identifierSchema,
  otherBodyId: identifierSchema,
  timeSeconds: nonNegativeFiniteNumberSchema,
});

export const trajectoryPreviewRiskSchema = z.discriminatedUnion('kind', [
  stableTrajectoryPreviewRiskSchema,
  collisionTrajectoryPreviewRiskSchema,
  escapeTrajectoryPreviewRiskSchema,
]);

export const trajectoryPreviewResultSchema = z.strictObject({
  version: z.literal(ORBIT_PREVIEW_PROTOCOL_VERSION),
  type: z.literal('trajectoryPreviewResult'),
  requestId: identifierSchema,
  draftRevision: safeNonNegativeIntegerSchema,
  durationSeconds: positiveFiniteNumberSchema.max(MAX_TRAJECTORY_PREVIEW_DURATION_SECONDS),
  tracks: z.array(previewTrackSchema).min(1).max(512),
  risk: trajectoryPreviewRiskSchema,
  closestApproachMeters: nonNegativeFiniteNumberSchema,
});

export const trajectoryPreviewErrorSchema = z.strictObject({
  version: z.literal(ORBIT_PREVIEW_PROTOCOL_VERSION),
  type: z.literal('trajectoryPreviewError'),
  requestId: identifierSchema.nullable(),
  draftRevision: safeNonNegativeIntegerSchema.nullable(),
  code: z.enum(['invalidRequest', 'previewFailed', 'messageError']),
  message: z.string().min(1).max(1_024),
});

export const trajectoryPreviewResponseSchema = z.discriminatedUnion('type', [
  trajectoryPreviewResultSchema,
  trajectoryPreviewErrorSchema,
]);

export type TrajectoryPreviewRequest = z.infer<typeof trajectoryPreviewRequestSchema>;
export type TrajectoryPreviewPoint = z.infer<typeof previewPointSchema>;
export type TrajectoryPreviewTrack = z.infer<typeof previewTrackSchema>;
export type TrajectoryPreviewRisk = z.infer<typeof trajectoryPreviewRiskSchema>;
export type TrajectoryPreviewResult = z.infer<typeof trajectoryPreviewResultSchema>;
export type TrajectoryPreviewError = z.infer<typeof trajectoryPreviewErrorSchema>;
export type TrajectoryPreviewResponse = z.infer<typeof trajectoryPreviewResponseSchema>;
