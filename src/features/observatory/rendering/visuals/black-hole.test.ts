import { describe, expect, it, vi } from 'vitest';

import { ISOLATED_BLACK_HOLE_PROFILE } from '../appearance/black-hole-appearance';
import {
  createBlackHoleTextureData,
  createBlackHoleVisual,
  disposeBlackHoleVisual,
  updateBlackHoleScale,
  updateBlackHoleVisibility,
} from './black-hole';

describe('black hole visual', () => {
  it('程序化纹理包含不透明暗核、冷白光子环和透明背景', () => {
    const data = createBlackHoleTextureData(ISOLATED_BLACK_HOLE_PROFILE, false, 64);
    const alphas = Array.from({ length: 64 * 64 }, (_, index) => data[index * 4 + 3] ?? 0);
    const centerOffset = (32 * 64 + 32) * 4;

    expect(data[centerOffset]).toBe(0);
    expect(data[centerOffset + 1]).toBe(0);
    expect(data[centerOffset + 2]).toBe(0);
    expect(data[centerOffset + 3]).toBeGreaterThan(240);
    expect(Math.max(...alphas)).toBeGreaterThan(250);
    expect(Math.min(...alphas)).toBe(0);
    expect(() => createBlackHoleTextureData(ISOLATED_BLACK_HOLE_PROFILE, false, 8)).toThrow(
      RangeError,
    );
  });

  it('WebGPU 增加透镜光晕，WebGL2 保留暗核和光子环回退', () => {
    const enhanced = createBlackHoleVisual(ISOLATED_BLACK_HOLE_PROFILE, 'webgpu');
    const fallback = createBlackHoleVisual(ISOLATED_BLACK_HOLE_PROFILE, 'webgl2');

    expect(enhanced.mode).toBe('webgpu-halo');
    expect(enhanced.haloSprite).not.toBeNull();
    expect(fallback.mode).toBe('webgl2-ring');
    expect(fallback.haloSprite).toBeNull();
    expect(enhanced.photonRingSprite.material.depthTest).toBe(true);
    expect(enhanced.photonRingSprite.renderOrder).toBeLessThan(3);
    expect(enhanced.haloSprite?.material.depthTest).toBe(true);
    expect(enhanced.haloSprite?.renderOrder ?? 3).toBeLessThan(3);

    updateBlackHoleScale(enhanced, 2);
    expect(enhanced.photonRingSprite.scale.x).toBeCloseTo(
      ISOLATED_BLACK_HOLE_PROFILE.observableOuterRadiusRatio * 4,
    );
    updateBlackHoleVisibility(enhanced, 3.99);
    expect(enhanced.group.visible).toBe(false);
    updateBlackHoleVisibility(enhanced, 4);
    expect(enhanced.group.visible).toBe(true);

    disposeBlackHoleVisual(enhanced);
    disposeBlackHoleVisual(fallback);
  });

  it('共享相同程序化纹理，并在最后一个引用离开时幂等释放', () => {
    const first = createBlackHoleVisual(ISOLATED_BLACK_HOLE_PROFILE, 'webgpu');
    const second = createBlackHoleVisual(ISOLATED_BLACK_HOLE_PROFILE, 'webgpu');
    const photonMaterialDispose = vi.fn();
    const photonTextureDispose = vi.fn();
    const haloMaterialDispose = vi.fn();
    const haloTextureDispose = vi.fn();
    expect(first.photonRingTexture).toBe(second.photonRingTexture);
    expect(first.haloTexture).toBe(second.haloTexture);
    first.photonRingSprite.material.addEventListener('dispose', photonMaterialDispose);
    first.photonRingTexture.addEventListener('dispose', photonTextureDispose);
    first.haloSprite?.material.addEventListener('dispose', haloMaterialDispose);
    first.haloTexture?.addEventListener('dispose', haloTextureDispose);

    disposeBlackHoleVisual(first);
    disposeBlackHoleVisual(first);

    expect(photonMaterialDispose).toHaveBeenCalledOnce();
    expect(haloMaterialDispose).toHaveBeenCalledOnce();
    expect(photonTextureDispose).not.toHaveBeenCalled();
    expect(haloTextureDispose).not.toHaveBeenCalled();

    disposeBlackHoleVisual(second);

    expect(photonTextureDispose).toHaveBeenCalledOnce();
    expect(haloTextureDispose).toHaveBeenCalledOnce();
  });
});
