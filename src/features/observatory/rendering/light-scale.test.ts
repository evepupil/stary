import { describe, expect, it } from 'vitest';

import {
  MAXIMUM_STELLAR_LIGHT_INTENSITY,
  STELLAR_LIGHT_DISTANCE_DECAY,
  STELLAR_LIGHT_REFERENCE_METERS_TO_SCENE_UNIT,
  computeScaledStellarLightIntensity,
} from './light-scale';

const ASTRONOMICAL_UNIT_METERS = 149_597_870_700;

describe('stellar light scene scaling', () => {
  it('在参考太阳系比例下保留基础强度', () => {
    expect(
      computeScaledStellarLightIntensity(3.2, STELLAR_LIGHT_REFERENCE_METERS_TO_SCENE_UNIT),
    ).toBeCloseTo(3.2, 12);
  });

  it('按场景比例平方补偿点光源强度，保持同一物理距离的照度稳定', () => {
    const smallerSceneScale = STELLAR_LIGHT_REFERENCE_METERS_TO_SCENE_UNIT / 10;
    const referenceIntensity = computeScaledStellarLightIntensity(
      3.2,
      STELLAR_LIGHT_REFERENCE_METERS_TO_SCENE_UNIT,
    );
    const scaledIntensity = computeScaledStellarLightIntensity(3.2, smallerSceneScale);
    const referenceWorldDistance =
      ASTRONOMICAL_UNIT_METERS * STELLAR_LIGHT_REFERENCE_METERS_TO_SCENE_UNIT;
    const scaledWorldDistance = ASTRONOMICAL_UNIT_METERS * smallerSceneScale;

    expect(STELLAR_LIGHT_DISTANCE_DECAY).toBe(2);
    expect(scaledIntensity).toBeCloseTo(0.032, 12);
    expect(referenceIntensity / referenceWorldDistance ** STELLAR_LIGHT_DISTANCE_DECAY).toBeCloseTo(
      scaledIntensity / scaledWorldDistance ** STELLAR_LIGHT_DISTANCE_DECAY,
      12,
    );
  });

  it('让零强度保持为零，并拒绝无效输入', () => {
    expect(computeScaledStellarLightIntensity(0, Number.MAX_VALUE)).toBe(0);
    expect(() => computeScaledStellarLightIntensity(-1, 1)).toThrow(RangeError);
    expect(() => computeScaledStellarLightIntensity(1, 0)).toThrow(RangeError);
  });

  it('在极端场景比例下返回有限的显示上限', () => {
    expect(computeScaledStellarLightIntensity(1, Number.MAX_VALUE)).toBe(
      MAXIMUM_STELLAR_LIGHT_INTENSITY,
    );
  });
});
