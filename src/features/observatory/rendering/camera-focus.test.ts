import { describe, expect, it } from 'vitest';

import type { BodyState } from '../../../physics/protocol/schemas';
import { computeFocusCameraFrame, computeOverviewCameraFrame } from './camera-focus';

function createBody(id: string, x: number, radiusMeters: number): BodyState {
  return {
    id,
    massKg: 1,
    radiusMeters,
    positionMeters: { x, y: 0, z: 0 },
    velocityMetersPerSecond: { x: 0, y: 0, z: 0 },
  };
}

describe('observatory camera focus', () => {
  it('全景帧保持系统原点并容纳默认场景范围', () => {
    const frame = computeOverviewCameraFrame(16 / 9);

    expect(frame.target).toEqual({ x: 0, y: 0, z: 0 });
    expect(frame.halfExtent).toBe(10);
    expect(frame.distance).toBeGreaterThan(10);
  });

  it('聚焦行星时以父级和天体的中点取景并容纳两者', () => {
    const sun = createBody('sun', 0, 1);
    const earth = createBody('earth', 10, 0.1);
    const frame = computeFocusCameraFrame(earth, sun, 1, 16 / 9);

    expect(frame.target).toEqual({ x: 5, y: 0, z: 0 });
    expect(frame.halfExtent).toBeGreaterThan(5);
    expect(frame.distance).toBeGreaterThan(frame.halfExtent);
  });

  it('极短的卫星轨道仍获得正数取景范围', () => {
    const earth = createBody('earth', 1, 0.00004);
    const moon = createBody('moon', 1.0008, 0.00001);
    const frame = computeFocusCameraFrame(moon, earth, 1, 390 / 844);

    expect(frame.target.x).toBeCloseTo(1.0004);
    expect(frame.halfExtent).toBeGreaterThanOrEqual(0.001);
    expect(frame.distance).toBeGreaterThan(0);
  });
});
