import { describe, expect, it } from 'vitest';

import {
  BODY_LOD_THRESHOLDS,
  RENDER_SCALE_THRESHOLDS,
  computeProjectedRadiusPixels,
  getSphereSegments,
  selectBodyLod,
  selectRenderScaleTier,
  type BodyLod,
  type RenderScaleTier,
} from './render-scale';

describe('render scale projection', () => {
  it('按透视相机参数计算投影像素半径', () => {
    expect(computeProjectedRadiusPixels(1, 10, 90, 1000)).toBeCloseTo(50);
    expect(computeProjectedRadiusPixels(2, 10, 90, 1000)).toBeCloseTo(100);
    expect(computeProjectedRadiusPixels(1, 20, 90, 1000)).toBeCloseTo(25);
  });

  it('随半径和视口增大而增大，随距离和视场角增大而减小', () => {
    const baseline = computeProjectedRadiusPixels(1, 10, 60, 800);

    expect(computeProjectedRadiusPixels(2, 10, 60, 800)).toBeGreaterThan(baseline);
    expect(computeProjectedRadiusPixels(1, 10, 60, 1600)).toBeGreaterThan(baseline);
    expect(computeProjectedRadiusPixels(1, 20, 60, 800)).toBeLessThan(baseline);
    expect(computeProjectedRadiusPixels(1, 10, 90, 800)).toBeLessThan(baseline);
  });

  it.each([
    [0, 10, 60, 800, 'radiusSceneUnits'],
    [1, Number.NaN, 60, 800, 'cameraDistanceSceneUnits'],
    [1, 10, 0, 800, 'verticalFieldOfViewDegrees'],
    [1, 10, 180, 800, 'verticalFieldOfViewDegrees'],
    [1, 10, 60, Number.POSITIVE_INFINITY, 'viewportHeightPixels'],
  ])('拒绝非法投影输入 %#', (radius, distance, fov, viewportHeight, fieldName) => {
    expect(() => computeProjectedRadiusPixels(radius, distance, fov, viewportHeight)).toThrow(
      fieldName,
    );
  });
});

describe('render scale tier selection', () => {
  it('在默认阈值边界选择 system、orbit 和 surface', () => {
    expect(selectRenderScaleTier(RENDER_SCALE_THRESHOLDS.orbit.defaultPixels - 0.01)).toBe(
      'system',
    );
    expect(selectRenderScaleTier(RENDER_SCALE_THRESHOLDS.orbit.defaultPixels)).toBe('orbit');
    expect(selectRenderScaleTier(RENDER_SCALE_THRESHOLDS.surface.defaultPixels - 0.01)).toBe(
      'orbit',
    );
    expect(selectRenderScaleTier(RENDER_SCALE_THRESHOLDS.surface.defaultPixels)).toBe('surface');
  });

  it('只允许投影半径增大时提升尺度层级', () => {
    const rank: Record<RenderScaleTier, number> = { system: 0, orbit: 1, surface: 2 };
    const samples = [1, 11.99, 12, 50, 119.99, 120, 500].map((pixels) =>
      selectRenderScaleTier(pixels),
    );

    expect(samples.map((tier) => rank[tier])).toEqual([0, 0, 1, 1, 1, 2, 2]);
  });

  it('在尺度边界附近保留上一层级，越过退出边界才降级', () => {
    expect(selectRenderScaleTier(13, 'system')).toBe('system');
    expect(selectRenderScaleTier(14, 'system')).toBe('orbit');
    expect(selectRenderScaleTier(11, 'orbit')).toBe('orbit');
    expect(selectRenderScaleTier(9.99, 'orbit')).toBe('system');

    expect(selectRenderScaleTier(143, 'orbit')).toBe('orbit');
    expect(selectRenderScaleTier(144, 'orbit')).toBe('surface');
    expect(selectRenderScaleTier(100, 'surface')).toBe('surface');
    expect(selectRenderScaleTier(95.99, 'surface')).toBe('orbit');
  });

  it('拒绝非正或非有限的投影半径', () => {
    expect(() => selectRenderScaleTier(0)).toThrow('projectedRadiusPixels');
    expect(() => selectRenderScaleTier(Number.NaN)).toThrow('projectedRadiusPixels');
    expect(() => selectRenderScaleTier(Number.POSITIVE_INFINITY)).toThrow('projectedRadiusPixels');
  });
});

describe('body LOD selection', () => {
  it('在默认阈值边界选择 low、medium 和 high', () => {
    expect(selectBodyLod(BODY_LOD_THRESHOLDS.medium.defaultPixels - 0.01)).toBe('low');
    expect(selectBodyLod(BODY_LOD_THRESHOLDS.medium.defaultPixels)).toBe('medium');
    expect(selectBodyLod(BODY_LOD_THRESHOLDS.high.defaultPixels - 0.01)).toBe('medium');
    expect(selectBodyLod(BODY_LOD_THRESHOLDS.high.defaultPixels)).toBe('high');
  });

  it('LOD 随投影半径单调提升', () => {
    const rank: Record<BodyLod, number> = { low: 0, medium: 1, high: 2 };
    const samples = [1, 5.99, 6, 40, 79.99, 80, 500].map((pixels) => selectBodyLod(pixels));

    expect(samples.map((lod) => rank[lod])).toEqual([0, 0, 1, 1, 1, 2, 2]);
  });

  it('在 LOD 边界附近应用进入和退出滞回', () => {
    expect(selectBodyLod(6.5, 'low')).toBe('low');
    expect(selectBodyLod(7, 'low')).toBe('medium');
    expect(selectBodyLod(5.5, 'medium')).toBe('medium');
    expect(selectBodyLod(4.99, 'medium')).toBe('low');

    expect(selectBodyLod(95, 'medium')).toBe('medium');
    expect(selectBodyLod(96, 'medium')).toBe('high');
    expect(selectBodyLod(70, 'high')).toBe('high');
    expect(selectBodyLod(63.99, 'high')).toBe('medium');
  });

  it('拒绝非法投影半径', () => {
    expect(() => selectBodyLod(-1)).toThrow('projectedRadiusPixels');
    expect(() => selectBodyLod(Number.NaN, 'low')).toThrow('projectedRadiusPixels');
  });

  it('为双后端提供信息一致且随 LOD 增长的球体分段', () => {
    const webGpu = ['low', 'medium', 'high'].map((lod) =>
      getSphereSegments(lod as BodyLod, 'webgpu'),
    );
    const webGl2 = ['low', 'medium', 'high'].map((lod) =>
      getSphereSegments(lod as BodyLod, 'webgl2'),
    );

    for (const segments of [webGpu, webGl2]) {
      expect(segments[0]?.width).toBeLessThan(segments[1]?.width ?? 0);
      expect(segments[1]?.width).toBeLessThan(segments[2]?.width ?? 0);
      expect(segments[0]?.height).toBeLessThan(segments[1]?.height ?? 0);
      expect(segments[1]?.height).toBeLessThan(segments[2]?.height ?? 0);
    }

    expect(webGl2[2]?.width).toBeLessThan(webGpu[2]?.width ?? 0);
    expect(webGl2[2]?.height).toBeLessThan(webGpu[2]?.height ?? 0);
  });
});
