import { describe, expect, it } from 'vitest';

import type { BodyState } from '../../../physics/protocol/schemas';
import { findMostMassiveBody, findOrbitParent } from './orbit-parent';

function createBody(id: string, massKg: number): BodyState {
  return {
    id,
    massKg,
    radiusMeters: 1,
    positionMeters: { x: 0, y: 0, z: 0 },
    velocityMetersPerSecond: { x: 0, y: 0, z: 0 },
  };
}

describe('orbit parent', () => {
  const sun = createBody('sun', 1e30);
  const earth = createBody('earth', 6e24);
  const moon = createBody('moon', 7e22);
  const bodies = [sun, earth, moon];

  it('行星使用目录声明的太阳父级', () => {
    expect(findOrbitParent(earth, bodies)).toBe(sun);
  });

  it('月球使用地球父级', () => {
    expect(findOrbitParent(moon, bodies)).toBe(earth);
  });

  it('主星没有轨道父级，未知天体回退到最大质量天体', () => {
    const comet = createBody('custom-comet', 1e12);
    const extendedBodies = [...bodies, comet];

    expect(findOrbitParent(sun, extendedBodies)).toBeNull();
    expect(findOrbitParent(comet, extendedBodies)).toBe(sun);
    expect(findMostMassiveBody(extendedBodies)).toBe(sun);
  });
});
