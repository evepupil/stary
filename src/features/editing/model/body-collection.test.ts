import { describe, expect, it } from 'vitest';

import type { BodyState } from '../../../physics/protocol/schemas';
import { createTestBodyState } from '../../../test/fixtures/body-state';
import {
  deleteBody,
  replaceEditedBody,
  selectFallbackBodyIdAfterDeletion,
} from './body-collection';

function body(id: string, massKg: number, x: number): BodyState {
  return {
    ...createTestBodyState({
      id,
      positionMeters: { x: Number.isFinite(x) ? x : 0, y: 0, z: 0 },
    }),
    massKg,
    positionMeters: { x, y: 0, z: 0 },
  };
}

describe('body collection editing', () => {
  it('从冻结输入中替换一个天体并深拷贝输出', () => {
    const sun = body('sun', 1e30, 0);
    const earth = body('earth', 6e24, 10);
    Object.freeze(sun.positionMeters);
    Object.freeze(sun.velocityMetersPerSecond);
    Object.freeze(sun.spinAngularMomentumKgMetersSquaredPerSecond);
    sun.materialLayers.forEach(Object.freeze);
    Object.freeze(sun.materialLayers);
    Object.freeze(sun);
    Object.freeze(earth.positionMeters);
    Object.freeze(earth.velocityMetersPerSecond);
    Object.freeze(earth.spinAngularMomentumKgMetersSquaredPerSecond);
    earth.materialLayers.forEach(Object.freeze);
    Object.freeze(earth.materialLayers);
    Object.freeze(earth);
    const bodies = Object.freeze([sun, earth]);
    const replacement = { ...earth, massKg: 7e24 };

    const result = replaceEditedBody(bodies, 'earth', replacement);

    expect(result).toEqual([sun, replacement]);
    expect(result).not.toBe(bodies);
    expect(result[0]).not.toBe(sun);
    expect(result[0]?.positionMeters).not.toBe(sun.positionMeters);
    expect(result[0]?.spinAngularMomentumKgMetersSquaredPerSecond).not.toBe(
      sun.spinAngularMomentumKgMetersSquaredPerSecond,
    );
    expect(result[0]?.materialLayers).not.toBe(sun.materialLayers);
    expect(result[0]?.materialLayers[0]).not.toBe(sun.materialLayers[0]);
  });

  it('替换时拒绝不存在、重复或被修改的 id', () => {
    const sun = body('sun', 1e30, 0);
    const earth = body('earth', 6e24, 10);

    expect(() => replaceEditedBody([sun], 'earth', earth)).toThrow('找不到');
    expect(() => replaceEditedBody([sun, sun], 'sun', sun)).toThrow('重复');
    expect(() => replaceEditedBody([sun, earth], 'earth', body('mars', 1, 1))).toThrow('必须保留');
  });

  it('删除指定天体且不修改冻结输入', () => {
    const sun = Object.freeze(body('sun', 1e30, 0));
    const earth = Object.freeze(body('earth', 6e24, 10));
    const bodies = Object.freeze([sun, earth]);

    const result = deleteBody(bodies, 'earth');

    expect(result).toEqual([sun]);
    expect(result[0]).not.toBe(sun);
    expect(result[0]?.materialLayers).not.toBe(sun.materialLayers);
    expect(result[0]?.spinAngularMomentumKgMetersSquaredPerSecond).not.toBe(
      sun.spinAngularMomentumKgMetersSquaredPerSecond,
    );
    expect(bodies).toHaveLength(2);
  });

  it('删除时拒绝不存在、重复以及最后一个天体', () => {
    const sun = body('sun', 1e30, 0);

    expect(() => deleteBody([sun], 'earth')).toThrow('找不到');
    expect(() => deleteBody([sun, sun], 'sun')).toThrow('重复');
    expect(() => deleteBody([sun], 'sun')).toThrow('至少需要保留');
  });

  it('删除后优先选择仍存在的声明父体', () => {
    const sun = body('sun', 1e30, 0);
    const earth = body('earth', 6e24, 100);
    const moon = body('moon', 7e22, 101);

    expect(selectFallbackBodyIdAfterDeletion([sun, earth], moon, 'earth')).toBe('earth');
  });

  it('父体不存在时选择对删除位置引力占优的天体', () => {
    const distantStar = body('distant-star', 1e30, 1e12);
    const nearbyPlanet = body('nearby-planet', 1e25, 1_000);
    const deleted = body('deleted', 1, 1_100);

    expect(
      selectFallbackBodyIdAfterDeletion([distantStar, nearbyPlanet], deleted, 'missing-parent'),
    ).toBe('nearby-planet');
  });

  it('无法比较引力时回退到首个合理天体，无剩余天体时返回 null', () => {
    const invalid = body('invalid', Number.NaN, 0);
    const valid = body('valid', 1, 1);
    const deleted = body('deleted', 1, Number.NaN);

    expect(selectFallbackBodyIdAfterDeletion([invalid, valid], deleted, null)).toBe('valid');
    expect(selectFallbackBodyIdAfterDeletion([], deleted, null)).toBeNull();
  });
});
