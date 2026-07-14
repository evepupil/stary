import { describe, expect, it } from 'vitest';

import {
  CUBIC_KILOMETERS_TO_CUBIC_METERS,
  GRAVITATIONAL_CONSTANT_SI,
  KILOMETERS_TO_METERS,
} from '../constants';
import type { BodyState, PositionMeters } from '../protocol/schemas';
import { centerBodiesOnCenterOfMass, computeCenterOfMass } from './center-of-mass';
import {
  SOLAR_SYSTEM_EPOCH,
  SOLAR_SYSTEM_HORIZONS_RECORDS,
  type HorizonsBodyRecord,
} from './solar-system-data';
import { createSolarSystemScenario } from './solar-system';

const EXPECTED_IDS = [
  'sun',
  'mercury',
  'venus',
  'earth',
  'moon',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
] as const;

function vectorDifference(left: PositionMeters, right: PositionMeters): PositionMeters {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z,
  };
}

function bodyById(bodies: readonly BodyState[], id: string): BodyState {
  const body = bodies.find((candidate) => candidate.id === id);
  if (body === undefined) {
    throw new Error(`缺少天体 ${id}`);
  }
  return body;
}

function sourceById(id: string): HorizonsBodyRecord {
  const source = SOLAR_SYSTEM_HORIZONS_RECORDS.find((record) => record.id === id);
  if (source === undefined) {
    throw new Error(`缺少 Horizons 源数据 ${id}`);
  }
  return source;
}

describe('太阳系 J2000 场景', () => {
  it('固定 10 个主要天体、历元和 SI 物理量', () => {
    const scenario = createSolarSystemScenario();

    expect(scenario.epoch).toEqual(SOLAR_SYSTEM_EPOCH);
    expect(scenario.bodies.map((body) => body.id)).toEqual(EXPECTED_IDS);

    for (const body of scenario.bodies) {
      const source = sourceById(body.id);
      expect(body.massKg).toBeCloseTo(
        (source.gmKm3PerSecond2 * CUBIC_KILOMETERS_TO_CUBIC_METERS) / GRAVITATIONAL_CONSTANT_SI,
        12,
      );
      expect(body.radiusMeters).toBe(source.meanRadiusKm * KILOMETERS_TO_METERS);
      expect(Object.values(body.positionMeters).every(Number.isFinite)).toBe(true);
      expect(Object.values(body.velocityMetersPerSecond).every(Number.isFinite)).toBe(true);
    }
  });

  it('转换到模型质心系且保持地月相对状态', () => {
    const scenario = createSolarSystemScenario();
    const center = computeCenterOfMass(scenario.bodies);
    expect(Math.hypot(...Object.values(center.positionMeters))).toBeLessThan(0.01);
    expect(Math.hypot(...Object.values(center.velocityMetersPerSecond))).toBeLessThan(1e-9);

    const earth = bodyById(scenario.bodies, 'earth');
    const moon = bodyById(scenario.bodies, 'moon');
    const earthSource = sourceById('earth');
    const moonSource = sourceById('moon');
    const expectedPosition = {
      x: (moonSource.positionKm[0] - earthSource.positionKm[0]) * KILOMETERS_TO_METERS,
      y: (moonSource.positionKm[1] - earthSource.positionKm[1]) * KILOMETERS_TO_METERS,
      z: (moonSource.positionKm[2] - earthSource.positionKm[2]) * KILOMETERS_TO_METERS,
    };
    const actualPosition = vectorDifference(moon.positionMeters, earth.positionMeters);
    expect(actualPosition.x).toBeCloseTo(expectedPosition.x, 3);
    expect(actualPosition.y).toBeCloseTo(expectedPosition.y, 3);
    expect(actualPosition.z).toBeCloseTo(expectedPosition.z, 3);
  });

  it('每次创建都返回独立对象', () => {
    const first = createSolarSystemScenario();
    const second = createSolarSystemScenario();

    expect(first.bodies).not.toBe(second.bodies);
    const firstSun = bodyById(first.bodies, 'sun');
    const secondSun = bodyById(second.bodies, 'sun');
    expect(firstSun).not.toBe(secondSun);
    expect(firstSun.positionMeters).not.toBe(secondSun.positionMeters);
  });
});

describe('质心换算', () => {
  it('拒绝空数组和非法质量', () => {
    expect(() => computeCenterOfMass([])).toThrow('至少需要一个天体');
    expect(() =>
      centerBodiesOnCenterOfMass([
        {
          id: 'invalid',
          massKg: 0,
          radiusMeters: 1,
          positionMeters: { x: 0, y: 0, z: 0 },
          velocityMetersPerSecond: { x: 0, y: 0, z: 0 },
        },
      ]),
    ).toThrow('质量必须是正有限数');
  });
});
