import { describe, expect, it } from 'vitest';

import type { ObservatoryCameraFrame } from './camera-focus';
import {
  computeCameraNavigationSettings,
  computeCameraTransitionDurationMilliseconds,
  easeCameraTransitionProgress,
  interpolateCameraDistance,
} from './camera-navigation';

const frame: ObservatoryCameraFrame = {
  distance: 6,
  halfExtent: 2,
  minimumDistance: 1.03,
  target: { x: 0, y: 0, z: 0 },
  tier: 'surface',
};

describe('camera navigation', () => {
  it('随尺度收紧交互速度，并让近景最小距离留在可观察轮廓之外', () => {
    const system = computeCameraNavigationSettings('system', 30, frame, 30);
    const orbit = computeCameraNavigationSettings('orbit', 10, frame, 30);
    const surface = computeCameraNavigationSettings('surface', 6, frame, 30);

    expect(system.zoomSpeed).toBeGreaterThan(orbit.zoomSpeed);
    expect(orbit.zoomSpeed).toBeGreaterThan(surface.zoomSpeed);
    expect(system.rotateSpeed).toBeGreaterThan(orbit.rotateSpeed);
    expect(orbit.rotateSpeed).toBeGreaterThan(surface.rotateSpeed);
    expect(surface.minDistance).toBe(1.03);
    expect(surface.near).toBeGreaterThan(0);
    expect(surface.near).toBeLessThan(6 - 1);
    expect(surface.far).toBeGreaterThan(6 + 1);
    expect(surface.maxDistance).toBeGreaterThanOrEqual(30 * 1.35);
  });

  it('为三档尺度提供有限且有序的裁剪面', () => {
    for (const tier of ['system', 'orbit', 'surface'] as const) {
      const settings = computeCameraNavigationSettings(tier, 1e-7, frame, 30);
      expect(settings.near).toBeGreaterThan(0);
      expect(settings.far).toBeGreaterThan(settings.near);
      expect(Number.isFinite(settings.far)).toBe(true);
    }
  });

  it('相同构图跨尺度档位时保持连续的近裁剪面和深度精度', () => {
    const earthFrame: ObservatoryCameraFrame = {
      distance: 1.15e-4,
      halfExtent: 2.1e-5,
      minimumDistance: 2.06e-5,
      target: { x: 0, y: 0, z: 0 },
      tier: 'surface',
    };
    const settings = (['system', 'orbit', 'surface'] as const).map((tier) =>
      computeCameraNavigationSettings(tier, earthFrame.distance, earthFrame, 30),
    );

    expect(settings[0]?.near).toBe(settings[1]?.near);
    expect(settings[1]?.near).toBe(settings[2]?.near);
    expect(settings[0]?.near ?? 0).toBeGreaterThan(1e-8);
  });

  it('按投影大小连续收紧交互速度，跨档位时没有速度跳变', () => {
    const beforeOrbit = computeCameraNavigationSettings('system', 20, frame, 30, 13.9);
    const afterOrbit = computeCameraNavigationSettings('orbit', 20, frame, 30, 14.1);
    const beforeSurface = computeCameraNavigationSettings('orbit', 6, frame, 30, 143.9);
    const afterSurface = computeCameraNavigationSettings('surface', 6, frame, 30, 144.1);

    expect(beforeOrbit.zoomSpeed).toBeGreaterThan(afterOrbit.zoomSpeed);
    expect(Math.abs(beforeOrbit.zoomSpeed - afterOrbit.zoomSpeed)).toBeLessThan(0.01);
    expect(beforeSurface.zoomSpeed).toBeGreaterThan(afterSurface.zoomSpeed);
    expect(Math.abs(beforeSurface.zoomSpeed - afterSurface.zoomSpeed)).toBeLessThan(0.01);
    expect(beforeOrbit.rotateSpeed).toBeGreaterThan(afterSurface.rotateSpeed);
  });

  it('按距离跨度限制过渡时间，并用平滑进度插值对数距离', () => {
    expect(computeCameraTransitionDurationMilliseconds(10, 10)).toBe(420);
    expect(computeCameraTransitionDurationMilliseconds(30, 1e-7)).toBe(960);
    expect(easeCameraTransitionProgress(0)).toBe(0);
    expect(easeCameraTransitionProgress(0.5)).toBe(0.5);
    expect(easeCameraTransitionProgress(1)).toBe(1);
    expect(interpolateCameraDistance(100, 1, 0.5)).toBeCloseTo(10, 12);
    expect(() => interpolateCameraDistance(1, 2, -0.1)).toThrow(RangeError);
  });
});
