/// <reference types="node" />

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { BodyState } from '../protocol/schemas';
import { createReboundSimulation } from '../rebound/rebound-simulation';
import { ASTRONOMICAL_UNIT_METERS, createCircularSunEarthScenario } from '../scenarios/sun-earth';
import { generateTrajectoryPreview } from './generate-trajectory-preview';
import { ORBIT_PREVIEW_PROTOCOL_VERSION } from './schemas';

const SOLAR_MASS_KG = 1.988_47e30;

function expectPositionClose(
  actual: BodyState['positionMeters'] | undefined,
  expected: BodyState['positionMeters'],
): void {
  expect(actual).toBeDefined();
  for (const axis of ['x', 'y', 'z'] as const) {
    const toleranceMeters = Math.max(1e-6, Math.abs(expected[axis]) * 1e-13);
    expect(Math.abs((actual?.[axis] ?? Number.NaN) - expected[axis])).toBeLessThanOrEqual(
      toleranceMeters,
    );
  }
}

describe('真实 REBOUND 轨道预览', () => {
  it('按固定目标时刻输出有限 IAS15 轨迹', async () => {
    const scenario = createCircularSunEarthScenario();
    const draft: BodyState = {
      id: 'draft-planet',
      massKg: 1e20,
      radiusMeters: 1_000,
      positionMeters: { x: ASTRONOMICAL_UNIT_METERS * 2, y: 0, z: 0 },
      velocityMetersPerSecond: { x: 0, y: 20_000, z: 0 },
    };
    const result = await generateTrajectoryPreview(
      {
        version: ORBIT_PREVIEW_PROTOCOL_VERSION,
        type: 'trajectoryPreviewRequest',
        requestId: 'rebound-preview',
        draftRevision: 1,
        bodies: [...scenario.bodies, draft],
        draftBodyIds: [draft.id],
        referenceBodyId: 'sun',
        durationSeconds: 86_400,
        sampleCount: 5,
      },
      (bodies) =>
        createReboundSimulation(bodies, {
          locateFile: () => path.resolve('spikes', 'rebound-wasm', 'dist', 'rebound.wasm'),
        }),
    );

    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]?.points.map((point) => point.timeSeconds)).toEqual([
      0, 21_600, 43_200, 64_800, 86_400,
    ]);
    expect(
      result.tracks[0]?.points.every((point) =>
        Object.values(point.positionMeters).every(Number.isFinite),
      ),
    ).toBe(true);
    expect(result.closestApproachMeters).toBeGreaterThan(0);
    expect(result.risk.kind).toBe('stable');
  });

  it.each([
    ['太阳质量恒星', SOLAR_MASS_KG, 696_340_000],
    ['5 倍太阳质量黑洞', 5 * SOLAR_MASS_KG, 14_766],
  ])('%s 的首个轨迹点保持输入惯性坐标', async (_label, massKg, radiusMeters) => {
    const reference: BodyState = {
      id: 'reference-planet',
      massKg: 5.972_2e24,
      radiusMeters: 6_371_000,
      positionMeters: { x: -3e11, y: 1e11, z: -2e9 },
      velocityMetersPerSecond: { x: -4_000, y: 8_000, z: -20 },
    };
    const draft: BodyState = {
      id: 'draft-massive-body',
      massKg,
      radiusMeters,
      positionMeters: { x: 4e11, y: -2e11, z: 3e9 },
      velocityMetersPerSecond: { x: 1_234, y: -567, z: 89 },
    };

    const result = await generateTrajectoryPreview(
      {
        version: ORBIT_PREVIEW_PROTOCOL_VERSION,
        type: 'trajectoryPreviewRequest',
        requestId: 'massive-body-frame-preview',
        draftRevision: 2,
        bodies: [reference, draft],
        draftBodyIds: [draft.id],
        referenceBodyId: reference.id,
        durationSeconds: 60,
        sampleCount: 2,
      },
      (bodies) =>
        createReboundSimulation(bodies, {
          locateFile: () => path.resolve('spikes', 'rebound-wasm', 'dist', 'rebound.wasm'),
        }),
    );

    expectPositionClose(result.tracks[0]?.points[0]?.positionMeters, draft.positionMeters);
  });
});
