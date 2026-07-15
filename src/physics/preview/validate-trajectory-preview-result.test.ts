import { describe, expect, it } from 'vitest';

import type { BodyState } from '../protocol/schemas';
import {
  ORBIT_PREVIEW_PROTOCOL_VERSION,
  type TrajectoryPreviewRequest,
  type TrajectoryPreviewResult,
} from './schemas';
import { validateTrajectoryPreviewResultForRequest } from './validate-trajectory-preview-result';

const bodies: readonly BodyState[] = [
  {
    id: 'reference',
    massKg: 1e20,
    radiusMeters: 1,
    positionMeters: { x: 0, y: 0, z: 0 },
    velocityMetersPerSecond: { x: 0, y: 0, z: 0 },
  },
  {
    id: 'draft',
    massKg: 1,
    radiusMeters: 1,
    positionMeters: { x: 10, y: 0, z: 0 },
    velocityMetersPerSecond: { x: 0, y: 0, z: 0 },
  },
];

const request: TrajectoryPreviewRequest = {
  version: ORBIT_PREVIEW_PROTOCOL_VERSION,
  type: 'trajectoryPreviewRequest',
  requestId: 'request-1',
  draftRevision: 4,
  bodies: [...bodies],
  draftBodyIds: ['draft'],
  referenceBodyId: 'reference',
  durationSeconds: 1,
  sampleCount: 2,
};

const result: TrajectoryPreviewResult = {
  version: ORBIT_PREVIEW_PROTOCOL_VERSION,
  type: 'trajectoryPreviewResult',
  requestId: request.requestId,
  draftRevision: request.draftRevision,
  durationSeconds: request.durationSeconds,
  tracks: [
    {
      bodyId: 'draft',
      points: [
        { timeSeconds: 0, positionMeters: { x: 10, y: 0, z: 0 } },
        { timeSeconds: 1, positionMeters: { x: 11, y: 0, z: 0 } },
      ],
    },
  ],
  risk: { kind: 'stable', bodyId: null, otherBodyId: null, timeSeconds: null },
  closestApproachMeters: 10,
};

function requireBaseTrack(): TrajectoryPreviewResult['tracks'][number] {
  const track = result.tracks[0];
  if (track === undefined) {
    throw new Error('测试数据缺少基础轨迹');
  }
  return track;
}

function requireBasePoint(
  index: number,
): TrajectoryPreviewResult['tracks'][number]['points'][number] {
  const point = requireBaseTrack().points[index];
  if (point === undefined) {
    throw new Error(`测试数据缺少基础轨迹点 ${String(index)}`);
  }
  return point;
}

const baseTrack = requireBaseTrack();
const firstPoint = requireBasePoint(0);
const lastPoint = requireBasePoint(1);

function malformedResult(value: unknown): TrajectoryPreviewResult {
  return value as TrajectoryPreviewResult;
}

describe('validateTrajectoryPreviewResultForRequest', () => {
  it('接受与请求逐项一致的响应', () => {
    expect(validateTrajectoryPreviewResultForRequest(result, request)).toBe(result);
  });

  it.each([
    ['请求 id', { ...result, requestId: 'other-request' }],
    ['草稿修订', { ...result, draftRevision: 5 }],
    ['时长', { ...result, durationSeconds: 2 }],
    ['重复轨迹', { ...result, tracks: [...result.tracks, ...result.tracks] }],
    ['未请求轨迹', { ...result, tracks: [{ ...baseTrack, bodyId: 'reference' }] }],
    ['缺少轨迹', { ...result, tracks: [] }],
    [
      '点数',
      {
        ...result,
        tracks: [
          {
            ...baseTrack,
            points: [
              ...baseTrack.points,
              { timeSeconds: 1, positionMeters: { x: 11, y: 0, z: 0 } },
            ],
          },
        ],
      },
    ],
    [
      '首点时刻',
      {
        ...result,
        tracks: [
          {
            ...baseTrack,
            points: [{ timeSeconds: 0.1, positionMeters: { x: 10, y: 0, z: 0 } }, lastPoint],
          },
        ],
      },
    ],
    [
      '末点时刻',
      {
        ...result,
        tracks: [
          {
            ...baseTrack,
            points: [firstPoint, { timeSeconds: 0.9, positionMeters: { x: 11, y: 0, z: 0 } }],
          },
        ],
      },
    ],
  ])('拒绝不匹配请求的%s', (_label, malformed) => {
    expect(() =>
      validateTrajectoryPreviewResultForRequest(malformedResult(malformed), request),
    ).toThrow();
  });

  it('拒绝非递增或超出范围的轨迹时刻', () => {
    const threePointRequest = { ...request, sampleCount: 3 };
    const nonMonotonic = {
      ...result,
      tracks: [
        {
          ...baseTrack,
          points: [
            firstPoint,
            { timeSeconds: 1, positionMeters: { x: 10.5, y: 0, z: 0 } },
            lastPoint,
          ],
        },
      ],
    };
    const outsideRange = {
      ...nonMonotonic,
      tracks: [
        {
          ...nonMonotonic.tracks[0],
          points: [
            firstPoint,
            { timeSeconds: 2, positionMeters: { x: 10.5, y: 0, z: 0 } },
            lastPoint,
          ],
        },
      ],
    };

    expect(() =>
      validateTrajectoryPreviewResultForRequest(malformedResult(nonMonotonic), threePointRequest),
    ).toThrow('严格递增');
    expect(() =>
      validateTrajectoryPreviewResultForRequest(malformedResult(outsideRange), threePointRequest),
    ).toThrow('超出请求范围');
  });

  it.each([
    {
      kind: 'collision',
      bodyId: 'reference',
      otherBodyId: 'draft',
      timeSeconds: 0.5,
    },
    { kind: 'collision', bodyId: 'draft', otherBodyId: 'missing', timeSeconds: 0.5 },
    { kind: 'collision', bodyId: 'draft', otherBodyId: 'reference', timeSeconds: 2 },
    { kind: 'escape', bodyId: 'draft', otherBodyId: 'missing', timeSeconds: 1 },
    { kind: 'escape', bodyId: 'draft', otherBodyId: 'reference', timeSeconds: 0.5 },
  ])('拒绝与请求天体或时长不一致的风险 %#', (risk) => {
    expect(() =>
      validateTrajectoryPreviewResultForRequest(malformedResult({ ...result, risk }), request),
    ).toThrow();
  });

  it('没有参考天体时拒绝 escape 风险', () => {
    const requestWithoutReference = { ...request, referenceBodyId: null };
    const escapeResult = {
      ...result,
      risk: {
        kind: 'escape',
        bodyId: 'draft',
        otherBodyId: 'reference',
        timeSeconds: request.durationSeconds,
      },
    };

    expect(() =>
      validateTrajectoryPreviewResultForRequest(
        malformedResult(escapeResult),
        requestWithoutReference,
      ),
    ).toThrow('逃逸风险与请求参考天体或末端时刻不一致');
  });
});
