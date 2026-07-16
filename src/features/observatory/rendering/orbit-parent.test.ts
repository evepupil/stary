import { describe, expect, it } from 'vitest';

import { createTestBodyState } from '../../../test/fixtures/body-state';
import { findMostMassiveBody, findOrbitParent } from './orbit-parent';

function createBody(id: string, massKg: number, x = 0) {
  return createTestBodyState({
    id,
    massKg,
    positionMeters: { x, y: 0, z: 0 },
  });
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

  it('删除地球后月球按引力优势回退到太阳', () => {
    expect(findOrbitParent(moon, [sun, moon])).toBe(sun);
  });

  it('删除太阳后行星按当前位置重新选择主导父体', () => {
    const movedEarth = createBody('earth', 6e24, 1_000_000);
    const nearbyPlanet = createBody('custom-nearby-planet', 1e25, 1_001_000);
    const distantGiant = createBody('custom-distant-giant', 1e28, 1e12);

    expect(findOrbitParent(movedEarth, [movedEarth, nearbyPlanet, distantGiant])).toBe(
      nearbyPlanet,
    );
  });

  it('主星没有轨道父级，未知天体回退到最大质量天体', () => {
    const comet = createBody('custom-comet', 1e12);
    const extendedBodies = [...bodies, comet];

    expect(findOrbitParent(sun, extendedBodies)).toBeNull();
    expect(findOrbitParent(sun, [earth, moon])).toBeNull();
    expect(findOrbitParent(comet, extendedBodies)).toBe(sun);
    expect(findMostMassiveBody(extendedBodies)).toBe(sun);
  });

  it('用户创建的卫星按当前位置选择引力最强的父体', () => {
    const createdMoon = {
      ...createBody('created-moon-01', 7e22),
      positionMeters: { x: 1_000_001, y: 0, z: 0 },
    };
    const distantSun = {
      ...sun,
      positionMeters: { x: 0, y: 0, z: 0 },
    };
    const nearbyEarth = {
      ...earth,
      positionMeters: { x: 1_000_000, y: 0, z: 0 },
    };

    expect(findOrbitParent(createdMoon, [distantSun, nearbyEarth, createdMoon])).toBe(nearbyEarth);
  });
});
