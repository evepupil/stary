import { Scene } from 'three';
import { describe, expect, it, vi } from 'vitest';

import type { BodyAppearanceProfile } from '../appearance/body-appearance';
import {
  STELLAR_LIGHT_DISTANCE_DECAY,
  STELLAR_LIGHT_REFERENCE_METERS_TO_SCENE_UNIT,
} from '../light-scale';
import {
  createBodyVisual,
  disposeBodyVisual,
  isBodyVisualCompatible,
  updateBodyVisualAppearance,
  updateBodyVisualLod,
} from './body-visual';

function appearance(overrides: Partial<BodyAppearanceProfile> = {}): BodyAppearanceProfile {
  return {
    baseColor: 0xffcc88,
    bodyId: 'star-a',
    emissiveColor: 0xffcc88,
    emissiveIntensity: 1.4,
    light: {
      color: 0xffcc88,
      intensity: 3.2,
      luminositySolar: 1,
      luminosityWatts: 3.828e26,
    },
    roughness: 1,
    structureKey: 'star:v1:1',
    structureSeed: 1,
    surfaceKind: 'star',
    temperatureKelvin: 5_772,
    ...overrides,
  };
}

describe('body visual resources', () => {
  it('创建恒星表面、光晕和受限灯光，并在删除时释放场景对象', () => {
    const scene = new Scene();
    const visual = createBodyVisual(
      scene,
      appearance(),
      'webgpu',
      true,
      'low',
      true,
      STELLAR_LIGHT_REFERENCE_METERS_TO_SCENE_UNIT,
    );

    expect(scene.children).toContain(visual.root);
    expect(scene.children).toContain(visual.ring);
    expect(visual.halo).not.toBeNull();
    expect(visual.halo?.material.map).not.toBeNull();
    expect(visual.light?.intensity).toBe(3.2);
    expect(visual.isPrimary).toBe(true);
    expect(visual.mesh.geometry.getAttribute('color').count).toBeGreaterThan(0);

    const geometryDispose = vi.fn();
    const haloTextureDispose = vi.fn();
    const materialDispose = vi.fn();
    visual.mesh.geometry.addEventListener('dispose', geometryDispose);
    visual.halo?.material.map?.addEventListener('dispose', haloTextureDispose);
    visual.mesh.material.addEventListener('dispose', materialDispose);
    disposeBodyVisual(scene, visual);

    expect(scene.children).not.toContain(visual.root);
    expect(scene.children).not.toContain(visual.ring);
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(haloTextureDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
  });

  it('只在结构或灯光所有权变化时要求重建，并原位更新外观参数', () => {
    const scene = new Scene();
    const initial = appearance();
    const visual = createBodyVisual(
      scene,
      initial,
      'webgl2',
      false,
      'low',
      true,
      STELLAR_LIGHT_REFERENCE_METERS_TO_SCENE_UNIT,
    );
    const updated = appearance({
      baseColor: 0xaabbff,
      emissiveColor: 0xaabbff,
      emissiveIntensity: 2,
      light: {
        color: 0xaabbff,
        intensity: 5,
        luminositySolar: 2,
        luminosityWatts: 7.656e26,
      },
    });
    const originalLight = visual.light;

    expect(isBodyVisualCompatible(visual, updated, true)).toBe(true);
    expect(isBodyVisualCompatible(visual, updated, false)).toBe(false);
    expect(isBodyVisualCompatible(visual, appearance({ structureKey: 'star:v2:1' }), true)).toBe(
      false,
    );

    updateBodyVisualAppearance(visual, updated, STELLAR_LIGHT_REFERENCE_METERS_TO_SCENE_UNIT / 10);
    expect(visual.mesh.material.color.getHex()).toBe(0xffffff);
    expect(visual.appearance.baseColor).toBe(0xaabbff);
    expect(visual.light).toBe(originalLight);
    expect(visual.light?.decay).toBe(STELLAR_LIGHT_DISTANCE_DECAY);
    expect(visual.light?.intensity).toBeCloseTo(0.05, 12);
    disposeBodyVisual(scene, visual);
  });

  it('LOD 变化时替换球体几何并释放旧几何', () => {
    const scene = new Scene();
    const visual = createBodyVisual(
      scene,
      appearance(),
      'webgpu',
      true,
      'low',
      true,
      STELLAR_LIGHT_REFERENCE_METERS_TO_SCENE_UNIT,
    );
    const previousGeometry = visual.mesh.geometry;
    const dispose = vi.fn();
    previousGeometry.addEventListener('dispose', dispose);

    updateBodyVisualLod(visual, 'high', 'webgpu');

    expect(visual.lod).toBe('high');
    expect(visual.mesh.geometry).not.toBe(previousGeometry);
    expect(visual.mesh.geometry.getAttribute('color').count).toBeGreaterThan(0);
    expect(dispose).toHaveBeenCalledOnce();
    disposeBodyVisual(scene, visual);
  });

  it('非恒星保持无光晕和无灯光', () => {
    const scene = new Scene();
    const visual = createBodyVisual(
      scene,
      appearance({
        bodyId: 'earth',
        emissiveColor: 0,
        emissiveIntensity: 0,
        light: null,
        roughness: 0.82,
        structureKey: 'rocky:v1:2',
        surfaceKind: 'rocky',
        temperatureKelvin: 288,
      }),
      'webgl2',
      false,
      'medium',
      false,
      STELLAR_LIGHT_REFERENCE_METERS_TO_SCENE_UNIT,
    );

    expect(visual.halo).toBeNull();
    expect(visual.light).toBeNull();
    disposeBodyVisual(scene, visual);
  });
});
