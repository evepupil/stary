import { describe, expect, it } from 'vitest';

import type { BodyState } from '../../../../physics/protocol/schemas';
import {
  computeAngularDiskOverlapFraction,
  computeCombinedStellarTransmission,
  computeStellarVisibility,
} from './stellar-occlusion';

function body(id: string, x: number, y: number, radiusMeters: number): BodyState {
  return {
    id,
    massKg: 1,
    positionMeters: { x, y, z: 0 },
    radiusMeters,
    velocityMetersPerSecond: { x: 0, y: 0, z: 0 },
  };
}

describe('stellar occlusion', () => {
  it('区分无遮挡、全食和部分遮挡', () => {
    const target = body('target', 0, 0, 1);
    const star = body('star', 100, 0, 10);
    const totalOccluder = body('total', 50, 0, 6);
    const partialOccluder = body('partial', 50, 5, 4);
    const behindTarget = body('behind', -20, 0, 20);

    expect(computeStellarVisibility(target, star, [target, star, behindTarget])).toEqual({
      occluderIds: [],
      visibility: 1,
    });
    expect(computeStellarVisibility(target, star, [target, star, totalOccluder])).toEqual({
      occluderIds: ['total'],
      visibility: 0,
    });
    const partial = computeStellarVisibility(target, star, [target, star, partialOccluder]);
    expect(partial.occluderIds).toEqual(['partial']);
    expect(partial.visibility).toBeGreaterThan(0);
    expect(partial.visibility).toBeLessThan(1);
  });

  it('角圆盘重叠保持在零到一并拒绝无效参数', () => {
    expect(computeAngularDiskOverlapFraction(0.1, 0.05, 0.2)).toBe(0);
    expect(computeAngularDiskOverlapFraction(0.1, 0.2, 0)).toBe(1);
    expect(computeAngularDiskOverlapFraction(0.1, 0.1, 0.1)).toBeCloseTo(0.391, 3);
    expect(() => computeAngularDiskOverlapFraction(0, 1, 0)).toThrow(RangeError);
  });

  it('多个重合遮挡体按圆盘并集合并，不重复扣除同一区域', () => {
    const target = body('target', 0, 0, 1);
    const star = body('star', 100, 0, 10);
    const starAngularRadius = Math.asin(star.radiusMeters / 100);
    const halfAreaOccluderRadius = Math.sin(starAngularRadius / Math.sqrt(2)) * 50;
    const first = body('first', 50, 0, halfAreaOccluderRadius);
    const second = body('second', 50, 0, halfAreaOccluderRadius);

    const result = computeStellarVisibility(target, star, [target, star, first, second]);

    expect(result.occluderIds).toEqual(['first', 'second']);
    expect(result.visibility).toBeCloseTo(0.5, 1);
  });

  it('多恒星按遮挡前后总照度计算地表直射光比例', () => {
    expect(
      computeCombinedStellarTransmission([
        { unoccludedIlluminance: 100, visibility: 0 },
        { unoccludedIlluminance: 20, visibility: 1 },
      ]),
    ).toBeCloseTo(1 / 6, 12);
    expect(computeCombinedStellarTransmission([])).toBe(0);
    expect(() =>
      computeCombinedStellarTransmission([{ unoccludedIlluminance: -1, visibility: 1 }]),
    ).toThrow(RangeError);
  });
});
