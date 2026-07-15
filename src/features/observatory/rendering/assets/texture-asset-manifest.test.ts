import { describe, expect, it } from 'vitest';

import { resolveBodyAssetPlan } from './body-asset-plan';
import {
  getTextureAssetDescriptor,
  PLANETARY_TEXTURE_ASSET_MANIFEST,
} from './texture-asset-manifest';

const FIXED_SOLAR_SYSTEM_BODY_IDS = [
  'sun',
  'mercury',
  'venus',
  'earth',
  'moon',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
] as const;

describe('planetary texture asset manifest', () => {
  it('为太阳系 10 体提供本地表面资产，并只给土星配置实体环', () => {
    for (const bodyId of FIXED_SOLAR_SYSTEM_BODY_IDS) {
      expect(resolveBodyAssetPlan(bodyId).surface?.bodyId).toBe(bodyId);
    }
    const saturn = resolveBodyAssetPlan('saturn');
    expect(saturn.ring).toMatchObject({
      axialTiltDegrees: 26.73,
      innerRadiusRatio: 1.24,
      outerRadiusRatio: 2.27,
    });
    expect(saturn.ring?.opacityAsset.role).toBe('ring-opacity');
    expect(resolveBodyAssetPlan('earth').ring).toBeNull();
    expect(resolveBodyAssetPlan('earth').clouds?.opacityAsset).toMatchObject({
      id: 'earth-cloud-opacity',
      role: 'cloud-opacity',
    });
  });

  it('让动态和未知天体继续使用确定性程序化回退', () => {
    expect(resolveBodyAssetPlan('created:rocky-planet:1')).toEqual({
      clouds: null,
      ring: null,
      surface: null,
    });
    expect(resolveBodyAssetPlan('unknown')).toEqual({ clouds: null, ring: null, surface: null });
  });

  it('清单使用单一 CC BY 4.0 来源并锁定 12 个唯一文件', () => {
    expect(PLANETARY_TEXTURE_ASSET_MANIFEST.license.id).toBe('CC-BY-4.0');
    expect(PLANETARY_TEXTURE_ASSET_MANIFEST.assets).toHaveLength(12);
    expect(new Set(PLANETARY_TEXTURE_ASSET_MANIFEST.assets.map((asset) => asset.file)).size).toBe(
      12,
    );
    expect(getTextureAssetDescriptor('earth-surface').url).toBe('/assets/planetary/earth.webp');
    expect(() => getTextureAssetDescriptor('missing')).toThrow('未知纹理资产');
  });
});
