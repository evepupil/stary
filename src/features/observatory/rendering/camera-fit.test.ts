import { describe, expect, it } from 'vitest';

import {
  computeCameraFitDistance,
  computeMinimumBillboardWorldRadius,
  OBSERVATORY_VERTICAL_FOV_DEGREES,
} from './camera-fit';

describe('observatory camera fitting', () => {
  it('手机竖屏会比桌面后退以容纳相同横向范围', () => {
    const desktopDistance = computeCameraFitDistance(10, 1440 / 900);
    const mobileDistance = computeCameraFitDistance(10, 390 / 844);

    expect(mobileDistance).toBeGreaterThan(desktopDistance * 2);
    expect(horizontalHalfExtentAtDistance(mobileDistance, 390 / 844)).toBeGreaterThanOrEqual(11.2);
  });

  it('宽屏距离仍满足垂直方向的完整显示', () => {
    const distance = computeCameraFitDistance(10, 16 / 9);
    const verticalHalfExtent =
      distance * Math.tan((OBSERVATORY_VERTICAL_FOV_DEGREES * Math.PI) / 360);

    expect(verticalHalfExtent).toBeGreaterThanOrEqual(11.2);
  });

  it('定位环的世界尺寸随相机距离增长并保持目标像素半径', () => {
    const nearRadius = computeMinimumBillboardWorldRadius(20, 800, 9);
    const farRadius = computeMinimumBillboardWorldRadius(80, 800, 9);

    expect(farRadius).toBeCloseTo(nearRadius * 4);
  });

  it('拒绝无效视口和视场参数', () => {
    expect(() => computeCameraFitDistance(10, 0)).toThrow('aspect');
    expect(() => computeCameraFitDistance(10, 1, 180)).toThrow('verticalFovDegrees');
    expect(() => computeMinimumBillboardWorldRadius(10, 0, 9)).toThrow('viewportHeightPixels');
  });
});

function horizontalHalfExtentAtDistance(distance: number, aspect: number): number {
  return distance * Math.tan((OBSERVATORY_VERTICAL_FOV_DEGREES * Math.PI) / 360) * aspect;
}
