import { describe, expect, it } from 'vitest';

import type { BodyState } from '../protocol/schemas';
import {
  MAX_TRAJECTORY_PREVIEW_DURATION_SECONDS,
  MAX_TRAJECTORY_PREVIEW_SAMPLE_COUNT,
  ORBIT_PREVIEW_PROTOCOL_VERSION,
  trajectoryPreviewRequestSchema,
  trajectoryPreviewResponseSchema,
} from './schemas';
import { createPreviewTestBody } from './test-helpers';

const referenceBody: BodyState = createPreviewTestBody({
  id: 'reference',
  massKg: 1e20,
  radiusMeters: 1,
  positionMeters: { x: 0, y: 0, z: 0 },
  velocityMetersPerSecond: { x: 0, y: 0, z: 0 },
});
const draftBody: BodyState = {
  ...referenceBody,
  id: 'draft',
  massKg: 1,
  positionMeters: { x: 10, y: 0, z: 0 },
};
const request = {
  version: ORBIT_PREVIEW_PROTOCOL_VERSION,
  type: 'trajectoryPreviewRequest',
  requestId: 'request-1',
  draftRevision: 3,
  bodies: [referenceBody, draftBody],
  draftBodyIds: ['draft'],
  referenceBodyId: 'reference',
  durationSeconds: 60,
  sampleCount: 16,
} as const;

describe('trajectory preview protocol', () => {
  it('接受严格完整的预览请求', () => {
    expect(trajectoryPreviewRequestSchema.parse(request)).toEqual(request);
  });

  it('接受没有参考天体的预览请求', () => {
    const input = { ...request, referenceBodyId: null };

    expect(trajectoryPreviewRequestSchema.parse(input)).toEqual(input);
  });

  it.each([1, 2])('严格拒绝 v%s 旧版预览请求', (version) => {
    expect(() => trajectoryPreviewRequestSchema.parse({ ...request, version })).toThrow();
  });

  it.each([
    'spinAngularMomentumKgMetersSquaredPerSecond',
    'momentOfInertiaFactor',
    'materialLayers',
    'collisionModel',
  ] as const)('拒绝缺少 v3 天体字段 %s 的请求', (field) => {
    const incompleteBody = Object.fromEntries(
      Object.entries(referenceBody).filter(([property]) => property !== field),
    );

    expect(() =>
      trajectoryPreviewRequestSchema.parse({
        ...request,
        bodies: [incompleteBody, draftBody],
      }),
    ).toThrow();
  });

  it.each([
    { ...request, extra: true },
    { ...request, draftBodyIds: ['draft', 'draft'] },
    { ...request, draftBodyIds: ['missing'] },
    { ...request, referenceBodyId: 'missing' },
    { ...request, referenceBodyId: 'draft' },
    { ...request, durationSeconds: 0 },
    { ...request, durationSeconds: MAX_TRAJECTORY_PREVIEW_DURATION_SECONDS + 1 },
    { ...request, sampleCount: 1 },
    { ...request, sampleCount: MAX_TRAJECTORY_PREVIEW_SAMPLE_COUNT + 1 },
  ])('拒绝非法或不一致请求 %#', (input) => {
    expect(() => trajectoryPreviewRequestSchema.parse(input)).toThrow();
  });

  it('响应协议拒绝非有限轨迹点和未知风险类型', () => {
    const baseResult = {
      version: ORBIT_PREVIEW_PROTOCOL_VERSION,
      type: 'trajectoryPreviewResult',
      requestId: 'request-1',
      draftRevision: 3,
      durationSeconds: 60,
      tracks: [
        {
          bodyId: 'draft',
          points: [
            { timeSeconds: 0, positionMeters: { x: 0, y: 0, z: 0 } },
            { timeSeconds: 60, positionMeters: { x: 1, y: 0, z: 0 } },
          ],
        },
      ],
      risk: { kind: 'stable', bodyId: null, otherBodyId: null, timeSeconds: null },
      closestApproachMeters: 1,
    } as const;

    expect(trajectoryPreviewResponseSchema.parse(baseResult)).toEqual(baseResult);
    expect(
      trajectoryPreviewResponseSchema.parse({ ...baseResult, closestApproachMeters: null }),
    ).toMatchObject({ closestApproachMeters: null });
    expect(() =>
      trajectoryPreviewResponseSchema.parse({
        ...baseResult,
        tracks: [
          {
            bodyId: 'draft',
            points: [
              { timeSeconds: 0, positionMeters: { x: Number.NaN, y: 0, z: 0 } },
              { timeSeconds: 60, positionMeters: { x: 1, y: 0, z: 0 } },
            ],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      trajectoryPreviewResponseSchema.parse({
        ...baseResult,
        risk: { ...baseResult.risk, kind: 'unknown' },
      }),
    ).toThrow();
  });

  it.each([1, 2])('严格拒绝 v%s 旧版预览响应', (version) => {
    expect(() =>
      trajectoryPreviewResponseSchema.parse({
        version,
        type: 'trajectoryPreviewResult',
        requestId: 'request-1',
        draftRevision: 3,
        durationSeconds: 60,
        tracks: [
          {
            bodyId: 'draft',
            points: [
              { timeSeconds: 0, positionMeters: { x: 0, y: 0, z: 0 } },
              { timeSeconds: 60, positionMeters: { x: 1, y: 0, z: 0 } },
            ],
          },
        ],
        risk: { kind: 'stable', bodyId: null, otherBodyId: null, timeSeconds: null },
        closestApproachMeters: 1,
      }),
    ).toThrow();
  });

  it.each([
    { kind: 'stable', bodyId: 'draft', otherBodyId: null, timeSeconds: null },
    { kind: 'collision', bodyId: null, otherBodyId: 'reference', timeSeconds: 1 },
    { kind: 'escape', bodyId: 'draft', otherBodyId: null, timeSeconds: 60 },
  ])('风险类型拒绝不符合该类型的字段组合 %#', (risk) => {
    expect(() =>
      trajectoryPreviewResponseSchema.parse({
        version: ORBIT_PREVIEW_PROTOCOL_VERSION,
        type: 'trajectoryPreviewResult',
        requestId: 'request-1',
        draftRevision: 3,
        durationSeconds: 60,
        tracks: [
          {
            bodyId: 'draft',
            points: [
              { timeSeconds: 0, positionMeters: { x: 0, y: 0, z: 0 } },
              { timeSeconds: 60, positionMeters: { x: 1, y: 0, z: 0 } },
            ],
          },
        ],
        risk,
        closestApproachMeters: 1,
      }),
    ).toThrow();
  });
});
