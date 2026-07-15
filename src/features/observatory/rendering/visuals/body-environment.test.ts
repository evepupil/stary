import { describe, expect, it, vi } from 'vitest';

import { resolveBodyEnvironmentProfile } from '../appearance/body-environment';
import {
  createBodyEnvironmentVisual,
  createProceduralCloudAlphaData,
  disposeBodyEnvironmentVisual,
  updateBodyEnvironmentLighting,
  updateBodyEnvironmentScale,
  updateBodyEnvironmentTime,
  updateBodyEnvironmentVisibility,
} from './body-environment';

describe('body environment visual', () => {
  it('程序化云图确定、包含透明与不透明结构并拒绝无效尺寸', () => {
    const first = createProceduralCloudAlphaData(42, 32, 16);
    const second = createProceduralCloudAlphaData(42, 32, 16);
    const different = createProceduralCloudAlphaData(43, 32, 16);
    const greenValues = Array.from({ length: 32 * 16 }, (_, index) => first[index * 4 + 1] ?? 0);

    expect(first).toEqual(second);
    expect(first).not.toEqual(different);
    expect(Math.min(...greenValues)).toBe(0);
    expect(Math.max(...greenValues)).toBeGreaterThan(200);
    expect(() => createProceduralCloudAlphaData(1, 1, 16)).toThrow(RangeError);
  });

  it('创建双层大气、云和云影，并按时间、尺度与光照更新后完整释放', () => {
    const profile = resolveBodyEnvironmentProfile('earth');
    if (profile === null) {
      throw new Error('地球缺少环境参数');
    }
    const visual = createBodyEnvironmentVisual(profile, 'webgpu', 42);
    const geometryDispose = vi.fn();
    const cloudTextureDispose = vi.fn();
    visual.geometry.addEventListener('dispose', geometryDispose);
    visual.clouds?.fallbackAlphaMap.addEventListener('dispose', cloudTextureDispose);

    updateBodyEnvironmentScale(visual, 2);
    updateBodyEnvironmentTime(visual, 3_600);
    updateBodyEnvironmentVisibility(visual, 100, true);
    updateBodyEnvironmentLighting(visual, 0.5, 1, { x: 1, y: 0, z: 0 });
    const firstShadowQuaternion = visual.clouds?.shadowMesh.quaternion.clone();
    if (firstShadowQuaternion === undefined) {
      throw new Error('地球缺少云影姿态');
    }

    expect(visual.atmosphereShells).toHaveLength(2);
    expect(visual.group.scale.x).toBe(2);
    expect(visual.clouds?.phaseRadians).toBeGreaterThan(0);
    expect(visual.clouds?.cloudMesh.visible).toBe(true);
    expect(visual.clouds?.shadowMesh.visible).toBe(true);
    expect(visual.atmosphereShells[0]?.mesh.material.opacity).toBeLessThan(
      profile.atmosphereLayers[0]?.opacity ?? 0,
    );

    updateBodyEnvironmentLighting(visual, 0.5, 1, { x: -1, y: 0, z: 0 });
    expect(visual.clouds?.shadowMesh.quaternion.equals(firstShadowQuaternion)).toBe(false);
    updateBodyEnvironmentLighting(visual, 0, 1, { x: -1, y: 0, z: 0 });
    expect(visual.clouds?.shadowMesh.visible).toBe(false);
    expect(visual.clouds?.shadowMesh.material.opacity).toBe(0);

    updateBodyEnvironmentVisibility(visual, 4, true);
    expect(visual.atmosphereShells.every((shell) => !shell.mesh.visible)).toBe(true);
    expect(visual.clouds?.cloudMesh.visible).toBe(false);

    disposeBodyEnvironmentVisual(visual);
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(cloudTextureDispose).toHaveBeenCalledOnce();
  });

  it('拒绝无效云影光照方向', () => {
    const profile = resolveBodyEnvironmentProfile('earth');
    if (profile === null) {
      throw new Error('地球缺少环境参数');
    }
    const visual = createBodyEnvironmentVisual(profile, 'webgl2', 42);
    expect(() => {
      updateBodyEnvironmentLighting(visual, 1, 1, { x: 0, y: 0, z: 0 });
    }).toThrow(RangeError);
    disposeBodyEnvironmentVisual(visual);
  });
});
