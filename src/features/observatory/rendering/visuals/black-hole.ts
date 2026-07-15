import {
  AdditiveBlending,
  DataTexture,
  Group,
  LinearFilter,
  NoColorSpace,
  RGBAFormat,
  Sprite,
  SpriteMaterial,
  UnsignedByteType,
} from 'three';

import type { BlackHoleVisualProfile } from '../appearance/black-hole-appearance';
import type { RendererBackend } from '../create-renderer';

export type BlackHoleVisualMode = 'webgpu-halo' | 'webgl2-ring';

export interface BlackHoleVisual {
  readonly group: Group;
  readonly haloSprite: Sprite | null;
  readonly haloTexture: DataTexture | null;
  readonly mode: BlackHoleVisualMode;
  readonly photonRingSprite: Sprite;
  readonly photonRingTexture: DataTexture;
  readonly profile: BlackHoleVisualProfile;
}

const TEXTURE_SIZE = 256;
const disposedBlackHoleVisuals = new WeakSet<BlackHoleVisual>();
const sharedBlackHoleTextures = new Map<
  string,
  { references: number; readonly texture: DataTexture }
>();

export function createBlackHoleVisual(
  profile: BlackHoleVisualProfile,
  backend: RendererBackend,
): BlackHoleVisual {
  const group = new Group();
  group.name = 'black-hole-observable-boundary';
  const photonRingTexture = createBlackHoleTexture(profile, false);
  const photonRingSprite = new Sprite(
    new SpriteMaterial({
      depthTest: true,
      depthWrite: false,
      map: photonRingTexture,
      transparent: true,
    }),
  );
  photonRingSprite.name = 'black-hole-shadow-and-photon-ring';
  photonRingSprite.renderOrder = 2.8;
  group.add(photonRingSprite);

  const haloTexture = backend === 'webgpu' ? createBlackHoleTexture(profile, true) : null;
  const haloSprite =
    haloTexture === null
      ? null
      : new Sprite(
          new SpriteMaterial({
            blending: AdditiveBlending,
            depthTest: true,
            depthWrite: false,
            map: haloTexture,
            opacity: 0.55,
            transparent: true,
          }),
        );
  if (haloSprite !== null) {
    haloSprite.name = 'black-hole-lensing-halo';
    haloSprite.renderOrder = 2.7;
    group.add(haloSprite);
  }

  return {
    group,
    haloSprite,
    haloTexture,
    mode: backend === 'webgpu' ? 'webgpu-halo' : 'webgl2-ring',
    photonRingSprite,
    photonRingTexture,
    profile,
  };
}

export function updateBlackHoleScale(
  visual: BlackHoleVisual,
  eventHorizonRadiusSceneUnits: number,
): void {
  if (!Number.isFinite(eventHorizonRadiusSceneUnits) || eventHorizonRadiusSceneUnits < 0) {
    throw new RangeError('eventHorizonRadiusSceneUnits 必须是非负有限数');
  }
  const diameter = eventHorizonRadiusSceneUnits * visual.profile.observableOuterRadiusRatio * 2;
  visual.photonRingSprite.scale.set(diameter, diameter, 1);
  visual.haloSprite?.scale.set(diameter, diameter, 1);
}

export function updateBlackHoleVisibility(
  visual: BlackHoleVisual,
  observableProjectedRadiusPixels: number,
): void {
  if (!Number.isFinite(observableProjectedRadiusPixels) || observableProjectedRadiusPixels < 0) {
    throw new RangeError('observableProjectedRadiusPixels 必须是非负有限数');
  }
  visual.group.visible = observableProjectedRadiusPixels >= 4;
}

export function disposeBlackHoleVisual(visual: BlackHoleVisual): void {
  if (disposedBlackHoleVisuals.has(visual)) {
    return;
  }
  disposedBlackHoleVisuals.add(visual);
  visual.photonRingSprite.material.dispose();
  releaseBlackHoleTexture(visual.profile, false, visual.photonRingTexture);
  visual.haloSprite?.material.dispose();
  if (visual.haloTexture !== null) {
    releaseBlackHoleTexture(visual.profile, true, visual.haloTexture);
  }
  visual.group.clear();
}

export function createBlackHoleTextureData(
  profile: BlackHoleVisualProfile,
  haloOnly: boolean,
  size = TEXTURE_SIZE,
): Uint8Array {
  if (!Number.isSafeInteger(size) || size < 16) {
    throw new RangeError('黑洞纹理尺寸必须是至少 16 的安全整数');
  }
  const data = new Uint8Array(size * size * 4);
  const center = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - center) / center;
      const dy = (y - center) / center;
      const radiusRatio = Math.hypot(dx, dy) * profile.observableOuterRadiusRatio;
      const angle = Math.atan2(dy, dx);
      const offset = (y * size + x) * 4;
      if (haloOnly) {
        const haloRadius = profile.shadowRadiusRatio * 1.16;
        const halo = gaussian(radiusRatio, haloRadius, 0.22);
        const arcs = 0.35 + 0.65 * Math.max(0, Math.cos(angle * 2 - 0.55));
        const alpha = Math.round(255 * halo * arcs * 0.5);
        data[offset] = 105;
        data[offset + 1] = 165;
        data[offset + 2] = 214;
        data[offset + 3] = alpha;
        continue;
      }

      const photonRing = gaussian(radiusRatio, profile.photonRingRadiusRatio, 0.075);
      const insideShadow = radiusRatio <= profile.shadowRadiusRatio;
      if (photonRing > 0.02) {
        const dopplerBias = 0.72 + 0.28 * Math.max(0, Math.cos(angle - 0.35));
        data[offset] = Math.round(170 + 70 * photonRing * dopplerBias);
        data[offset + 1] = Math.round(202 + 48 * photonRing * dopplerBias);
        data[offset + 2] = 255;
        data[offset + 3] = Math.round(255 * Math.max(photonRing, insideShadow ? 0.98 : 0));
      } else if (insideShadow) {
        data[offset] = 0;
        data[offset + 1] = 0;
        data[offset + 2] = 0;
        data[offset + 3] = 252;
      }
    }
  }
  return data;
}

function createBlackHoleTexture(profile: BlackHoleVisualProfile, haloOnly: boolean): DataTexture {
  const key = blackHoleTextureKey(profile, haloOnly);
  const existing = sharedBlackHoleTextures.get(key);
  if (existing !== undefined) {
    existing.references += 1;
    return existing.texture;
  }
  const texture = new DataTexture(
    createBlackHoleTextureData(profile, haloOnly),
    TEXTURE_SIZE,
    TEXTURE_SIZE,
    RGBAFormat,
    UnsignedByteType,
  );
  texture.name = haloOnly ? 'black-hole-lensing-halo' : 'black-hole-shadow-photon-ring';
  texture.colorSpace = NoColorSpace;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  sharedBlackHoleTextures.set(key, { references: 1, texture });
  return texture;
}

function releaseBlackHoleTexture(
  profile: BlackHoleVisualProfile,
  haloOnly: boolean,
  texture: DataTexture,
): void {
  const key = blackHoleTextureKey(profile, haloOnly);
  const entry = sharedBlackHoleTextures.get(key);
  if (entry?.texture !== texture) {
    throw new Error('黑洞共享纹理引用不一致');
  }
  entry.references -= 1;
  if (entry.references === 0) {
    sharedBlackHoleTextures.delete(key);
    entry.texture.dispose();
  }
}

function blackHoleTextureKey(profile: BlackHoleVisualProfile, haloOnly: boolean): string {
  return [
    haloOnly ? 'halo' : 'ring',
    profile.eventHorizonRadiusRatio,
    profile.observableOuterRadiusRatio,
    profile.photonRingRadiusRatio,
    profile.photonSphereRadiusRatio,
    profile.shadowRadiusRatio,
  ].join(':');
}

function gaussian(value: number, center: number, width: number): number {
  return Math.exp(-(((value - center) / width) ** 2));
}
