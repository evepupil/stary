import { describe, expect, it } from 'vitest';

import type { BodyState } from '../../../physics/protocol/schemas';
import {
  computeMetersToSceneUnit,
  computePositionRingRadius,
  physicalRadiusToSceneUnits,
  positionMetersToScene,
} from './coordinates';

function body(id: string, x: number, radiusMeters: number): BodyState {
  return {
    id,
    massKg: 1,
    radiusMeters,
    positionMeters: { x, y: 0, z: 0 },
    velocityMetersPerSecond: { x: 0, y: 0, z: 0 },
  };
}

describe('observatory coordinate projection', () => {
  it('用统一比例把最远天体映射到场景边界', () => {
    const farBody = body('far', -50, 1);
    const bodies = [body('near', 20, 1), farBody];

    expect(computeMetersToSceneUnit(bodies, 10)).toBeCloseTo(0.2);
    expect(positionMetersToScene(farBody.positionMeters, 0.2)).toEqual({
      x: -10,
      y: 0,
      z: 0,
    });
  });

  it('所有天体重合时使用物理半径确定比例', () => {
    expect(computeMetersToSceneUnit([body('origin', 0, 5)], 10)).toBe(2);
    expect(computeMetersToSceneUnit([], 10)).toBe(1);
  });

  it('球体保留物理半径，定位环单独应用可见下限', () => {
    expect(physicalRadiusToSceneUnits(2, 0.1)).toBeCloseTo(0.2);
    expect(computePositionRingRadius(0.2, 0.5)).toBe(0.5);
    expect(computePositionRingRadius(2, 0.5)).toBeCloseTo(3.3);
  });

  it('拒绝会产生无效场景坐标的比例', () => {
    expect(() => computeMetersToSceneUnit([], 0)).toThrow('sceneExtent');
    expect(() => positionMetersToScene({ x: 0, y: 0, z: 0 }, Number.NaN)).toThrow(
      'metersToSceneUnit',
    );
    expect(() => computePositionRingRadius(-1, 1)).toThrow('physicalRadiusSceneUnits');
  });
});
