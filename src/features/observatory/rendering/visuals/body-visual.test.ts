import { Scene, Texture } from 'three';
import { describe, expect, it, vi } from 'vitest';

import type { BodyAppearanceProfile } from '../appearance/body-appearance';
import { resolveBodyAssetPlan } from '../assets/body-asset-plan';
import type { LoadedTextureResource, TextureAssetLoader } from '../assets/browser-texture-loader';
import { TextureAssetCache } from '../assets/texture-cache';
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
  updateBodyVisualStellarVisibility,
} from './body-visual';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value): void {
      resolvePromise?.(value);
    },
  };
}

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
    expect(scene.children).toContain(visual.markerRing);
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
    expect(scene.children).not.toContain(visual.markerRing);
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

  it('恒星被遮挡时按可见比例压低非恒星地表明暗', () => {
    const scene = new Scene();
    const visual = createBodyVisual(
      scene,
      appearance({
        baseColor: 0x80a0c0,
        bodyId: 'planet',
        emissiveColor: 0,
        emissiveIntensity: 0,
        light: null,
        surfaceKind: 'rocky',
      }),
      'webgpu',
      false,
      'medium',
      false,
      STELLAR_LIGHT_REFERENCE_METERS_TO_SCENE_UNIT,
    );
    const fullLightRed = visual.mesh.material.color.r;

    updateBodyVisualStellarVisibility(visual, 0.25);
    expect(visual.stellarVisibility).toBe(0.25);
    expect(visual.mesh.material.color.r).toBeCloseTo(fullLightRed * 0.25, 8);
    updateBodyVisualStellarVisibility(visual, 1);
    expect(visual.mesh.material.color.r).toBeCloseTo(fullLightRed, 8);
    expect(() => {
      updateBodyVisualStellarVisibility(visual, -0.01);
    }).toThrow(RangeError);

    disposeBodyVisual(scene, visual);
  });

  it('异步绑定土星表面和实体环，并让 LOD 切换复用纹理租约', async () => {
    const scene = new Scene();
    const resources = new Map<
      string,
      LoadedTextureResource & { readonly dispose: ReturnType<typeof vi.fn<() => void>> }
    >();
    const loader = vi.fn<TextureAssetLoader>().mockImplementation((descriptor) => {
      const resource = { dispose: vi.fn<() => void>(), texture: new Texture() };
      resource.texture.userData.assetId = descriptor.id;
      resources.set(descriptor.id, resource);
      return Promise.resolve(resource);
    });
    const cache = new TextureAssetCache(loader);
    const visual = createBodyVisual(
      scene,
      appearance({
        bodyId: 'saturn',
        emissiveColor: 0,
        emissiveIntensity: 0,
        light: null,
        roughness: 0.72,
        structureKey: 'gas-giant:v1:3',
        structureSeed: 3,
        surfaceKind: 'gas-giant',
        temperatureKelvin: 134,
      }),
      'webgpu',
      false,
      'low',
      false,
      STELLAR_LIGHT_REFERENCE_METERS_TO_SCENE_UNIT,
      resolveBodyAssetPlan('saturn'),
      cache,
    );

    expect(visual.assetBinding?.diagnostics().surface.state).toBe('idle');
    expect(visual.planetaryRing).not.toBeNull();
    visual.assetBinding?.start();
    await visual.assetBinding?.whenSettled();
    expect(visual.assetBinding?.diagnostics()).toEqual({
      clouds: { assetId: null, bound: false, state: 'procedural' },
      ring: { assetId: 'saturn-ring-opacity', bound: true, state: 'ready' },
      surface: { assetId: 'saturn-surface', bound: true, state: 'ready' },
    });
    expect(visual.mesh.material.map?.userData.assetId).toBe('saturn-surface');
    expect(visual.planetaryRing?.mesh.material.alphaMap?.userData.assetId).toBe(
      'saturn-ring-opacity',
    );

    const surfaceTexture = visual.mesh.material.map;
    updateBodyVisualLod(visual, 'high', 'webgpu');
    expect(visual.mesh.material.map).toBe(surfaceTexture);
    expect(loader).toHaveBeenCalledTimes(2);

    disposeBodyVisual(scene, visual);
    expect(resources.get('saturn-surface')?.dispose).toHaveBeenCalledOnce();
    expect(resources.get('saturn-ring-opacity')?.dispose).toHaveBeenCalledOnce();
    cache.dispose();
  });

  it('加载期间删除天体会中断请求并释放迟到资源', async () => {
    const scene = new Scene();
    const pendingByAssetId = new Map<string, Deferred<LoadedTextureResource>>();
    const signals = new Map<string, AbortSignal>();
    const loader: TextureAssetLoader = (descriptor, signal) => {
      const pending = deferred<LoadedTextureResource>();
      pendingByAssetId.set(descriptor.id, pending);
      signals.set(descriptor.id, signal);
      return pending.promise;
    };
    const cache = new TextureAssetCache(loader);
    const visual = createBodyVisual(
      scene,
      appearance({
        bodyId: 'saturn',
        emissiveColor: 0,
        emissiveIntensity: 0,
        light: null,
        roughness: 0.72,
        structureKey: 'gas-giant:v1:3',
        structureSeed: 3,
        surfaceKind: 'gas-giant',
        temperatureKelvin: 134,
      }),
      'webgl2',
      false,
      'low',
      false,
      STELLAR_LIGHT_REFERENCE_METERS_TO_SCENE_UNIT,
      resolveBodyAssetPlan('saturn'),
      cache,
    );
    const surfaceMaterial = visual.mesh.material;
    const ringMaterial = visual.planetaryRing?.mesh.material;

    visual.assetBinding?.start();
    await Promise.resolve();
    disposeBodyVisual(scene, visual);
    await visual.assetBinding?.whenSettled();

    expect(signals.get('saturn-surface')?.aborted).toBe(true);
    expect(signals.get('saturn-ring-opacity')?.aborted).toBe(true);
    const surfaceResource = { dispose: vi.fn<() => void>(), texture: new Texture() };
    const ringResource = { dispose: vi.fn<() => void>(), texture: new Texture() };
    pendingByAssetId.get('saturn-surface')?.resolve(surfaceResource);
    pendingByAssetId.get('saturn-ring-opacity')?.resolve(ringResource);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(surfaceResource.dispose).toHaveBeenCalledOnce();
    expect(ringResource.dispose).toHaveBeenCalledOnce();
    expect(surfaceMaterial.map).not.toBe(surfaceResource.texture);
    expect(ringMaterial?.alphaMap).not.toBe(ringResource.texture);
    cache.dispose();
  });

  it('地球表面与云层共享缓存生命周期，并把云纹理同时绑定到云和云影', async () => {
    const scene = new Scene();
    const resources = new Map<
      string,
      LoadedTextureResource & { readonly dispose: ReturnType<typeof vi.fn<() => void>> }
    >();
    const loader = vi.fn<TextureAssetLoader>().mockImplementation((descriptor) => {
      const resource = { dispose: vi.fn<() => void>(), texture: new Texture() };
      resources.set(descriptor.id, resource);
      return Promise.resolve(resource);
    });
    const cache = new TextureAssetCache(loader);
    const visual = createBodyVisual(
      scene,
      appearance({
        bodyId: 'earth',
        emissiveColor: 0,
        emissiveIntensity: 0,
        light: null,
        roughness: 0.82,
        structureKey: 'rocky:v1:earth',
        structureSeed: 42,
        surfaceKind: 'rocky',
        temperatureKelvin: 288,
      }),
      'webgpu',
      false,
      'high',
      false,
      STELLAR_LIGHT_REFERENCE_METERS_TO_SCENE_UNIT,
      resolveBodyAssetPlan('earth'),
      cache,
    );

    visual.assetBinding?.start();
    await visual.assetBinding?.whenSettled();
    const clouds = visual.environment?.clouds;
    const cloudTexture = resources.get('earth-cloud-opacity')?.texture;
    expect(visual.assetBinding?.diagnostics().clouds).toEqual({
      assetId: 'earth-cloud-opacity',
      bound: true,
      state: 'ready',
    });
    expect(clouds?.cloudMesh.material.alphaMap).toBe(cloudTexture);
    expect(clouds?.shadowMesh.material.alphaMap).toBe(cloudTexture);
    expect(loader).toHaveBeenCalledTimes(2);

    disposeBodyVisual(scene, visual);
    expect(resources.get('earth-surface')?.dispose).toHaveBeenCalledOnce();
    expect(resources.get('earth-cloud-opacity')?.dispose).toHaveBeenCalledOnce();
    cache.dispose();
  });

  it('地球云资产失败时保留表面纹理和程序化云回退', async () => {
    const scene = new Scene();
    const surfaceResource = { dispose: vi.fn<() => void>(), texture: new Texture() };
    const loader = vi.fn<TextureAssetLoader>().mockImplementation((descriptor) => {
      return descriptor.role === 'cloud-opacity'
        ? Promise.reject(new Error('cloud unavailable'))
        : Promise.resolve(surfaceResource);
    });
    const cache = new TextureAssetCache(loader);
    const visual = createBodyVisual(
      scene,
      appearance({
        bodyId: 'earth',
        emissiveColor: 0,
        emissiveIntensity: 0,
        light: null,
        roughness: 0.82,
        structureKey: 'rocky:v1:earth',
        structureSeed: 42,
        surfaceKind: 'rocky',
        temperatureKelvin: 288,
      }),
      'webgl2',
      false,
      'high',
      false,
      STELLAR_LIGHT_REFERENCE_METERS_TO_SCENE_UNIT,
      resolveBodyAssetPlan('earth'),
      cache,
    );
    const fallback = visual.environment?.clouds?.fallbackAlphaMap;

    visual.assetBinding?.start();
    await visual.assetBinding?.whenSettled();
    expect(visual.assetBinding?.diagnostics()).toEqual({
      clouds: { assetId: 'earth-cloud-opacity', bound: false, state: 'fallback' },
      ring: { assetId: null, bound: false, state: 'procedural' },
      surface: { assetId: 'earth-surface', bound: true, state: 'ready' },
    });
    expect(visual.mesh.material.map).toBe(surfaceResource.texture);
    expect(visual.environment?.clouds?.cloudMesh.material.alphaMap).toBe(fallback);
    expect(visual.environment?.clouds?.shadowMesh.material.alphaMap).toBe(fallback);

    disposeBodyVisual(scene, visual);
    expect(surfaceResource.dispose).toHaveBeenCalledOnce();
    cache.dispose();
  });
});
