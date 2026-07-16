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
import {
  getSolarSystemPhysicalProfile,
  SOLAR_SYSTEM_PHYSICAL_PROFILES,
} from './solar-system-physical-profiles';
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
      const profile = getSolarSystemPhysicalProfile(body.id as (typeof EXPECTED_IDS)[number]);
      expect(body).toMatchObject({
        collisionModel: profile.collisionModel,
        materialLayers: profile.materialLayers,
        momentOfInertiaFactor: profile.momentOfInertiaFactor,
        spinAngularMomentumKgMetersSquaredPerSecond:
          profile.spinAngularMomentumKgMetersSquaredPerSecond,
      });
    }
  });

  it('星历与碰撞物理资料双向覆盖同一组固定 id', () => {
    const horizonsIds = SOLAR_SYSTEM_HORIZONS_RECORDS.map((record) => record.id);
    const profileIds = SOLAR_SYSTEM_PHYSICAL_PROFILES.map((profile) => profile.id);
    const horizonsIdSet = new Set(horizonsIds);
    const profileIdSet = new Set(profileIds);

    expect(profileIds).toEqual(EXPECTED_IDS);
    expect(new Set(profileIds).size).toBe(profileIds.length);
    expect(horizonsIds.every((id) => profileIdSet.has(id))).toBe(true);
    expect(profileIds.every((id) => horizonsIdSet.has(id))).toBe(true);
  });

  it('固定资料满足材料、惯性和自转字段约束', () => {
    const materialOrder = { gas: 0, ice: 1, silicate: 2, iron: 3 } as const;

    for (const profile of SOLAR_SYSTEM_PHYSICAL_PROFILES) {
      expect(profile.momentOfInertiaFactor).toBeGreaterThan(0);
      expect(profile.momentOfInertiaFactor).toBeLessThanOrEqual(0.4);
      expect(profile.materialLayers.length).toBeGreaterThan(0);
      expect(
        profile.materialLayers.reduce((sum, layer) => sum + layer.massFraction, 0),
      ).toBeCloseTo(1, 12);
      for (let index = 1; index < profile.materialLayers.length; index += 1) {
        const previous = profile.materialLayers[index - 1];
        const current = profile.materialLayers[index];
        expect(previous).toBeDefined();
        expect(current).toBeDefined();
        if (previous !== undefined && current !== undefined) {
          expect(materialOrder[current.material]).toBeGreaterThan(materialOrder[previous.material]);
        }
      }
      expect(
        Object.values(profile.spinAngularMomentumKgMetersSquaredPerSecond).every(Number.isFinite),
      ).toBe(true);
      expect(Math.hypot(...Object.values(profile.spinAxisEclipticJ2000))).toBeCloseTo(1, 12);
      const body = bodyById(createSolarSystemScenario().bodies, profile.id);
      const expectedSpinMagnitude =
        (profile.momentOfInertiaFactor * body.massKg * body.radiusMeters ** 2 * 2 * Math.PI) /
        profile.rotationPeriodSeconds;
      const actualSpin = profile.spinAngularMomentumKgMetersSquaredPerSecond;
      const actualSpinMagnitude = Math.hypot(actualSpin.x, actualSpin.y, actualSpin.z);
      expect(
        Math.abs(actualSpinMagnitude / expectedSpinMagnitude - 1),
        `${profile.id} 自转角动量模长`,
      ).toBeLessThan(1e-3);
      expect(actualSpin.x / actualSpinMagnitude).toBeCloseTo(profile.spinAxisEclipticJ2000.x, 12);
      expect(actualSpin.y / actualSpinMagnitude).toBeCloseTo(profile.spinAxisEclipticJ2000.y, 12);
      expect(actualSpin.z / actualSpinMagnitude).toBeCloseTo(profile.spinAxisEclipticJ2000.z, 12);
    }

    expect(
      getSolarSystemPhysicalProfile('venus').spinAngularMomentumKgMetersSquaredPerSecond.z,
    ).toBeLessThan(0);
    expect(
      getSolarSystemPhysicalProfile('uranus').spinAngularMomentumKgMetersSquaredPerSecond.z,
    ).toBeLessThan(0);
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
    expect(firstSun.spinAngularMomentumKgMetersSquaredPerSecond).not.toBe(
      secondSun.spinAngularMomentumKgMetersSquaredPerSecond,
    );
    expect(firstSun.materialLayers).not.toBe(secondSun.materialLayers);
    expect(firstSun.materialLayers[0]).not.toBe(secondSun.materialLayers[0]);
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
          spinAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 0 },
          momentOfInertiaFactor: 0.4,
          materialLayers: [{ material: 'silicate', massFraction: 1 }],
          collisionModel: 'gravitySolid',
        },
      ]),
    ).toThrow('质量必须是正有限数');
  });
});
