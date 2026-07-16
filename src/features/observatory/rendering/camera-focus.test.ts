import { describe, expect, it } from 'vitest';

import { createTestBodyState } from '../../../test/fixtures/body-state';
import {
  computeBodyInspectionCameraFrame,
  computeFocusCameraFrame,
  computeOverviewCameraFrame,
} from './camera-focus';

function createBody(id: string, x: number, radiusMeters: number) {
  return createTestBodyState({
    id,
    radiusMeters,
    positionMeters: { x, y: 0, z: 0 },
  });
}

describe('observatory camera focus', () => {
  it('全景帧保持系统原点并容纳默认场景范围', () => {
    const frame = computeOverviewCameraFrame(16 / 9);

    expect(frame.target).toEqual({ x: 0, y: 0, z: 0 });
    expect(frame.halfExtent).toBe(10);
    expect(frame.distance).toBeGreaterThan(10);
    expect(frame.tier).toBe('system');
  });

  it('聚焦行星时以父级和天体的中点取景并容纳两者', () => {
    const sun = createBody('sun', 0, 1);
    const earth = createBody('earth', 10, 0.1);
    const frame = computeFocusCameraFrame(earth, sun, 1, 16 / 9);

    expect(frame.target).toEqual({ x: 5, y: 0, z: 0 });
    expect(frame.halfExtent).toBeGreaterThan(5);
    expect(frame.distance).toBeGreaterThan(frame.halfExtent);
    expect(frame.tier).toBe('orbit');
  });

  it('极短的卫星轨道仍获得正数取景范围', () => {
    const earth = createBody('earth', 1, 0.00004);
    const moon = createBody('moon', 1.0008, 0.00001);
    const frame = computeFocusCameraFrame(moon, earth, 1, 390 / 844);

    expect(frame.target.x).toBeCloseTo(1.0004);
    expect(frame.halfExtent).toBeGreaterThanOrEqual(0.001);
    expect(frame.distance).toBeGreaterThan(0);
  });

  it('近景观察使用真实半径，并为土星环扩大构图范围', () => {
    const saturn = createBody('saturn', 10, 0.0001);
    const bodyFrame = computeBodyInspectionCameraFrame(saturn, 1, 16 / 9);
    const ringFrame = computeBodyInspectionCameraFrame(saturn, 1, 16 / 9, 2.27);

    expect(bodyFrame.target).toEqual({ x: 10, y: 0, z: 0 });
    expect(bodyFrame.halfExtent).toBeCloseTo(0.00021, 12);
    expect(ringFrame.halfExtent).toBeCloseTo(bodyFrame.halfExtent * 2.27, 12);
    expect(ringFrame.distance).toBeGreaterThan(bodyFrame.distance);
    expect(ringFrame.minimumDistance).toBeCloseTo(0.0001 * 2.27 * 1.03, 12);
    expect(ringFrame.tier).toBe('surface');
    expect(() => computeBodyInspectionCameraFrame(saturn, 1, 1, 0)).toThrow(RangeError);
  });

  it('近景取景相对渲染原点保持局部目标坐标', () => {
    const blackHole = createBody('black-hole', 4.5e12 + 15_000, 15_000);
    const origin = { x: blackHole.positionMeters.x, y: 0, z: 0 };
    const frame = computeBodyInspectionCameraFrame(blackHole, 1e-12, 16 / 9, 3.25, origin);

    expect(frame.target).toEqual({ x: 0, y: 0, z: 0 });
    expect(frame.distance).toBeGreaterThan(frame.minimumDistance);
    expect(frame.minimumDistance).toBeGreaterThan(0);
  });
});
