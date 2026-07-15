import { describe, expect, it } from 'vitest';

import type { BodyState } from '../../../physics/protocol/schemas';
import {
  computeMetersToSceneUnit,
  computePositionRingRadius,
  computeScenePhysicalExtentMeters,
  physicalRadiusToSceneUnits,
  positionMetersToScene,
  reprojectScenePosition,
  shouldRecomputeSceneScale,
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

  it('先减渲染原点再换算，保留远处天体附近的小尺度差值', () => {
    const origin = { x: 4.5e15, y: -2.3e15, z: 8.1e14 };
    const projected = positionMetersToScene(
      { x: origin.x + 1_000, y: origin.y - 250, z: origin.z + 4 },
      0.01,
      origin,
    );

    expect(projected).toEqual({ x: 10, y: -2.5, z: 0.04 });
  });

  it('跟随同一天体移动原点时保留本地相机位置，只应用尺度变化', () => {
    expect(
      reprojectScenePosition(
        { x: 12, y: -3, z: 0.5 },
        {
          nextMetersToSceneUnit: 0.02,
          nextOriginMeters: { x: 4.5e15 + 1e9, y: 0, z: 0 },
          originTracksSameBody: true,
          previousMetersToSceneUnit: 0.01,
          previousOriginMeters: { x: 4.5e15, y: 0, z: 0 },
        },
      ),
    ).toEqual({ x: 24, y: -6, z: 1 });
  });

  it('切换渲染原点时保持相机对应的世界位置', () => {
    expect(
      reprojectScenePosition(
        { x: 10, y: 2, z: -4 },
        {
          nextMetersToSceneUnit: 0.5,
          nextOriginMeters: { x: 120, y: 8, z: 0 },
          originTracksSameBody: false,
          previousMetersToSceneUnit: 0.25,
          previousOriginMeters: { x: 100, y: 0, z: 0 },
        },
      ),
    ).toEqual({ x: 10, y: 0, z: -8 });
  });

  it('物理范围只在明显扩大或缩小时触发场景重标定', () => {
    expect(computeScenePhysicalExtentMeters([body('near', 20, 1), body('far', -50, 1)])).toBe(50);
    expect(shouldRecomputeSceneScale(100, 104)).toBe(false);
    expect(shouldRecomputeSceneScale(100, 106)).toBe(true);
    expect(shouldRecomputeSceneScale(100, 50)).toBe(false);
    expect(shouldRecomputeSceneScale(100, 49)).toBe(true);
    expect(shouldRecomputeSceneScale(0, 1)).toBe(true);
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
    expect(() =>
      positionMetersToScene({ x: 0, y: 0, z: 0 }, 1, { x: Number.NaN, y: 0, z: 0 }),
    ).toThrow('originMeters');
    expect(() => computePositionRingRadius(-1, 1)).toThrow('physicalRadiusSceneUnits');
    expect(() => shouldRecomputeSceneScale(-1, 1)).toThrow('previousExtentMeters');
  });
});
