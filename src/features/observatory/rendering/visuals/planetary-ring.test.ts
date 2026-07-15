import { describe, expect, it, vi } from 'vitest';

import { resolveBodyAssetPlan } from '../assets/body-asset-plan';
import {
  applyRadialRingUvs,
  createPlanetaryRingVisual,
  disposePlanetaryRingVisual,
} from './planetary-ring';

describe('planetary ring visual', () => {
  const ringPlan = resolveBodyAssetPlan('saturn').ring;

  it('建立真实半径比例、轴倾角和径向纹理坐标', () => {
    if (ringPlan === null) {
      throw new Error('土星缺少行星环计划');
    }
    const visual = createPlanetaryRingVisual(ringPlan, 'webgpu');
    const uvs = visual.mesh.geometry.getAttribute('uv');
    const uValues = Array.from({ length: uvs.count }, (_, index) => uvs.getX(index));
    const vValues = Array.from({ length: uvs.count }, (_, index) => uvs.getY(index));

    expect(Math.min(...uValues)).toBeCloseTo(0, 5);
    expect(Math.max(...uValues)).toBeCloseTo(1, 5);
    expect(new Set(vValues)).toEqual(new Set([0.5]));
    expect(visual.mesh.rotation.x).toBeCloseTo((26.73 * Math.PI) / 180, 8);
    expect(visual.innerRadiusRatio).toBe(1.24);
    expect(visual.outerRadiusRatio).toBe(2.27);
    disposePlanetaryRingVisual(visual);
  });

  it('拒绝无效半径并释放自有几何、材质和回退纹理', () => {
    if (ringPlan === null) {
      throw new Error('土星缺少行星环计划');
    }
    const visual = createPlanetaryRingVisual(ringPlan, 'webgl2');
    const geometryDispose = vi.fn();
    const materialDispose = vi.fn();
    const textureDispose = vi.fn();
    visual.mesh.geometry.addEventListener('dispose', geometryDispose);
    visual.mesh.material.addEventListener('dispose', materialDispose);
    visual.fallbackAlphaMap.addEventListener('dispose', textureDispose);

    expect(() => {
      applyRadialRingUvs(visual.mesh.geometry, 2, 1);
    }).toThrow(RangeError);
    disposePlanetaryRingVisual(visual);
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
    expect(textureDispose).toHaveBeenCalledOnce();
  });
});
