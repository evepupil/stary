import { getTextureAssetDescriptor, type TextureAssetDescriptor } from './texture-asset-manifest';

export interface PlanetaryRingPlan {
  readonly axialTiltDegrees: number;
  readonly innerRadiusRatio: number;
  readonly outerRadiusRatio: number;
  readonly opacityAsset: TextureAssetDescriptor;
}

export interface BodyAssetPlan {
  readonly ring: PlanetaryRingPlan | null;
  readonly surface: TextureAssetDescriptor | null;
}

const FIXED_SURFACE_ASSET_IDS: Readonly<Record<string, string>> = {
  sun: 'sun-surface',
  mercury: 'mercury-surface',
  venus: 'venus-surface',
  earth: 'earth-surface',
  moon: 'moon-surface',
  mars: 'mars-surface',
  jupiter: 'jupiter-surface',
  saturn: 'saturn-surface',
  uranus: 'uranus-surface',
  neptune: 'neptune-surface',
};

export function resolveBodyAssetPlan(bodyId: string): BodyAssetPlan {
  const surfaceAssetId = FIXED_SURFACE_ASSET_IDS[bodyId];
  return {
    ring:
      bodyId === 'saturn'
        ? {
            axialTiltDegrees: 26.73,
            innerRadiusRatio: 1.24,
            opacityAsset: getTextureAssetDescriptor('saturn-ring-opacity'),
            outerRadiusRatio: 2.27,
          }
        : null,
    surface: surfaceAssetId === undefined ? null : getTextureAssetDescriptor(surfaceAssetId),
  };
}
