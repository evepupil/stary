import { describe, expect, it } from 'vitest';

import type { BodyState } from '../../../physics/protocol/schemas';
import {
  createCircularSunEarthScenario,
  createEllipticalSunEarthScenario,
} from '../../../physics/scenarios/sun-earth';
import { createTestBodyState } from '../../../test/fixtures/body-state';
import { sampleOsculatingOrbit } from './orbit';

function radiusFrom(point: { readonly x: number; readonly y: number; readonly z: number }): number {
  return Math.hypot(point.x, point.y, point.z);
}

function requirePoint<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('轨道采样点缺失');
  }
  return value;
}

describe('sampleOsculatingOrbit', () => {
  it('圆轨道的采样半径保持一致并闭合', () => {
    const [sun, earth] = createCircularSunEarthScenario().bodies as readonly [BodyState, BodyState];
    const points = sampleOsculatingOrbit(sun, earth, 1e-10, 64);

    expect(points).not.toBeNull();
    if (points === null) {
      throw new Error('圆轨道应产生采样点');
    }
    expect(points).toHaveLength(65);
    const first = requirePoint(points[0]);
    const quarter = requirePoint(points[16]);
    const last = requirePoint(points[64]);
    const sceneSun = {
      x: sun.positionMeters.x * 1e-10,
      y: sun.positionMeters.y * 1e-10,
      z: sun.positionMeters.z * 1e-10,
    };
    const relativeRadius = (point: typeof first): number =>
      radiusFrom({
        x: point.x - sceneSun.x,
        y: point.y - sceneSun.y,
        z: point.z - sceneSun.z,
      });
    expect(relativeRadius(first)).toBeCloseTo(relativeRadius(quarter), 8);
    expect(last.x).toBeCloseTo(first.x, 8);
    expect(last.y).toBeCloseTo(first.y, 8);
  });

  it('椭圆轨道包含符合偏心率的近日点和远日点', () => {
    const scenario = createEllipticalSunEarthScenario();
    const [sun, earth] = scenario.bodies as readonly [BodyState, BodyState];
    const points = sampleOsculatingOrbit(sun, earth, 1, 128);
    if (points === null) {
      throw new Error('椭圆轨道应产生采样点');
    }
    const distancesFromSun = points.map((point) =>
      Math.hypot(
        point.x - sun.positionMeters.x,
        point.y - sun.positionMeters.y,
        point.z - sun.positionMeters.z,
      ),
    );
    const periapsis = Math.min(...distancesFromSun);
    const apoapsis = Math.max(...distancesFromSun);

    expect(apoapsis / periapsis).toBeCloseTo(
      (1 + scenario.eccentricity) / (1 - scenario.eccentricity),
      8,
    );
  });

  it('径向运动没有可绘制的闭合轨道', () => {
    const primary = createTestBodyState({
      id: 'primary',
      massKg: 1e20,
    });
    const body = createTestBodyState({
      ...primary,
      id: 'body',
      massKg: 1,
      positionMeters: { x: 10, y: 0, z: 0 },
      velocityMetersPerSecond: { x: 1, y: 0, z: 0 },
    });

    expect(sampleOsculatingOrbit(primary, body, 1)).toBeNull();
  });

  it('减去巨大渲染原点后保留相同的相对轨道形状', () => {
    const [sun, earth] = createCircularSunEarthScenario().bodies as readonly [BodyState, BodyState];
    const offset = { x: 4.5e15, y: -3.2e15, z: 7.5e14 };
    const shiftedSun = {
      ...sun,
      positionMeters: {
        x: sun.positionMeters.x + offset.x,
        y: sun.positionMeters.y + offset.y,
        z: sun.positionMeters.z + offset.z,
      },
    };
    const shiftedEarth = {
      ...earth,
      positionMeters: {
        x: earth.positionMeters.x + offset.x,
        y: earth.positionMeters.y + offset.y,
        z: earth.positionMeters.z + offset.z,
      },
    };
    const baseline = sampleOsculatingOrbit(sun, earth, 1e-10, 64, sun.positionMeters);
    const shifted = sampleOsculatingOrbit(
      shiftedSun,
      shiftedEarth,
      1e-10,
      64,
      shiftedSun.positionMeters,
    );

    expect(shifted).not.toBeNull();
    expect(baseline).not.toBeNull();
    expect(shifted?.[0]?.x).toBeCloseTo(baseline?.[0]?.x ?? 0, 4);
    expect(shifted?.[16]?.y).toBeCloseTo(baseline?.[16]?.y ?? 0, 4);
  });
});
