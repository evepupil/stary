import {
  AdditiveBlending,
  BufferAttribute,
  Color,
  DataTexture,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PointLight,
  RingGeometry,
  RGBAFormat,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  LinearFilter,
  UnsignedByteType,
} from 'three';

import type { BodyAppearanceProfile, BodySurfaceKind } from '../appearance/body-appearance';
import { resolveBodyEnvironmentProfile } from '../appearance/body-environment';
import { resolveBlackHoleVisualProfile } from '../appearance/black-hole-appearance';
import type { BodyAssetPlan } from '../assets/body-asset-plan';
import type { TextureAssetCache } from '../assets/texture-cache';
import type { RendererBackend } from '../create-renderer';
import { STELLAR_LIGHT_DISTANCE_DECAY, computeScaledStellarLightIntensity } from '../light-scale';
import { getSphereSegments, type BodyLod } from '../render-scale';
import { BodyVisualAssetBinding } from './body-visual-assets';
import { createBlackHoleVisual, disposeBlackHoleVisual, type BlackHoleVisual } from './black-hole';
import {
  createBodyEnvironmentVisual,
  disposeBodyEnvironmentVisual,
  type BodyEnvironmentVisual,
} from './body-environment';
import {
  createPlanetaryRingVisual,
  disposePlanetaryRingVisual,
  type PlanetaryRingVisual,
} from './planetary-ring';

type BodySurfaceMaterial = MeshBasicMaterial | MeshStandardMaterial;

export interface BodyVisual {
  appearance: BodyAppearanceProfile;
  appearanceSignature: string;
  readonly assetBinding: BodyVisualAssetBinding | null;
  readonly blackHole: BlackHoleVisual | null;
  readonly bodyId: string;
  readonly environment: BodyEnvironmentVisual | null;
  readonly halo: Sprite | null;
  readonly light: PointLight | null;
  readonly lightActive: boolean;
  readonly markerRing: Mesh<RingGeometry, MeshBasicMaterial>;
  readonly mesh: Mesh<SphereGeometry, BodySurfaceMaterial>;
  readonly planetaryRing: PlanetaryRingVisual | null;
  readonly root: Group;
  readonly structureKey: string;
  readonly surfaceKind: BodySurfaceKind;
  isPrimary: boolean;
  lod: BodyLod;
  observableProjectedRadiusPixels: number;
  physicalRadiusSceneUnits: number;
  projectedRadiusPixels: number;
  stellarVisibility: number;
}

export function createBodyVisual(
  scene: Scene,
  appearance: BodyAppearanceProfile,
  backend: RendererBackend,
  isPrimary: boolean,
  lod: BodyLod,
  lightActive: boolean,
  metersToSceneUnit: number,
  assetPlan?: BodyAssetPlan,
  textureCache?: TextureAssetCache,
): BodyVisual {
  if (
    assetPlan !== undefined &&
    (assetPlan.surface !== null || assetPlan.ring !== null || assetPlan.clouds !== null) &&
    textureCache === undefined
  ) {
    throw new Error('带纹理计划的天体缺少纹理缓存');
  }
  const geometry = createSphereGeometry(lod, backend);
  applySurfaceVertexColors(geometry, appearance);
  const material = createSurfaceMaterial(appearance);
  const mesh = new Mesh(geometry, material);
  mesh.userData.bodyId = appearance.bodyId;
  mesh.renderOrder = 2;

  const root = new Group();
  root.userData.bodyId = appearance.bodyId;
  root.add(mesh);

  const environmentProfile = resolveBodyEnvironmentProfile(appearance.bodyId);
  const environment =
    environmentProfile === null
      ? null
      : createBodyEnvironmentVisual(environmentProfile, backend, appearance.structureSeed);
  if (environment !== null) {
    root.add(environment.group);
  }

  const blackHoleProfile = resolveBlackHoleVisualProfile(appearance.surfaceKind);
  const blackHole =
    blackHoleProfile === null ? null : createBlackHoleVisual(blackHoleProfile, backend);
  if (blackHole !== null) {
    root.add(blackHole.group);
  }

  const planetaryRing =
    assetPlan?.ring === null || assetPlan?.ring === undefined
      ? null
      : createPlanetaryRingVisual(assetPlan.ring, backend);
  if (planetaryRing !== null) {
    root.add(planetaryRing.shadowMesh, planetaryRing.mesh);
  }

  const halo = createStarHalo(appearance);
  if (halo !== null) {
    root.add(halo);
  }

  const light =
    lightActive && appearance.light !== null
      ? createStellarLight(appearance, metersToSceneUnit)
      : null;
  if (light !== null) {
    root.add(light);
  }
  scene.add(root);

  const markerRingMaterial = new MeshBasicMaterial({
    blending: AdditiveBlending,
    color: 0x4cc9b0,
    depthTest: false,
    depthWrite: false,
    opacity: 0.22,
    side: DoubleSide,
    transparent: true,
  });
  const markerRing = new Mesh(new RingGeometry(0.78, 1, 64), markerRingMaterial);
  markerRing.userData.bodyId = appearance.bodyId;
  markerRing.renderOrder = 3;
  scene.add(markerRing);

  const assetBinding =
    assetPlan === undefined || textureCache === undefined
      ? null
      : new BodyVisualAssetBinding(material, environment, planetaryRing, assetPlan, textureCache);

  return {
    appearance,
    appearanceSignature: getAppearanceSignature(appearance),
    assetBinding,
    blackHole,
    bodyId: appearance.bodyId,
    environment,
    halo,
    light,
    lightActive,
    isPrimary,
    lod,
    markerRing,
    mesh,
    observableProjectedRadiusPixels: 0,
    physicalRadiusSceneUnits: 0,
    planetaryRing,
    projectedRadiusPixels: 0,
    root,
    stellarVisibility: 1,
    structureKey: appearance.structureKey,
    surfaceKind: appearance.surfaceKind,
  };
}

export function isBodyVisualCompatible(
  visual: BodyVisual,
  appearance: BodyAppearanceProfile,
  lightActive: boolean,
): boolean {
  return visual.structureKey === appearance.structureKey && visual.lightActive === lightActive;
}

export function updateBodyVisualAppearance(
  visual: BodyVisual,
  appearance: BodyAppearanceProfile,
  metersToSceneUnit: number,
): void {
  const appearanceSignature = getAppearanceSignature(appearance);
  visual.appearance = appearance;
  if (appearanceSignature !== visual.appearanceSignature) {
    applySurfaceVertexColors(visual.mesh.geometry, appearance);
    visual.appearanceSignature = appearanceSignature;
  }
  applyBodySurfaceColor(visual);
  if (visual.mesh.material instanceof MeshStandardMaterial) {
    visual.mesh.material.roughness = appearance.roughness;
    visual.mesh.material.emissive.setHex(appearance.emissiveColor);
    visual.mesh.material.emissiveIntensity = appearance.emissiveIntensity;
  }
  if (visual.halo !== null) {
    visual.halo.material.color.setHex(appearance.emissiveColor);
    visual.halo.material.opacity = Math.min(0.52, 0.24 + appearance.emissiveIntensity * 0.06);
  }
  if (visual.light !== null && appearance.light !== null) {
    visual.light.color.setHex(appearance.light.color);
    visual.light.intensity = computeScaledStellarLightIntensity(
      appearance.light.intensity,
      metersToSceneUnit,
    );
  }
}

export function updateBodyVisualStellarVisibility(
  visual: BodyVisual,
  stellarVisibility: number,
): void {
  if (!Number.isFinite(stellarVisibility) || stellarVisibility < 0 || stellarVisibility > 1) {
    throw new RangeError('stellarVisibility 必须在 0 到 1 之间');
  }
  visual.stellarVisibility = stellarVisibility;
  applyBodySurfaceColor(visual);
}

export function updateBodyVisualLod(
  visual: BodyVisual,
  lod: BodyLod,
  backend: RendererBackend,
): void {
  if (visual.lod === lod) {
    return;
  }

  const previousGeometry = visual.mesh.geometry;
  const nextGeometry = createSphereGeometry(lod, backend);
  applySurfaceVertexColors(nextGeometry, visual.appearance);
  visual.mesh.geometry = nextGeometry;
  visual.lod = lod;
  previousGeometry.dispose();
}

export function disposeBodyVisual(scene: Scene, visual: BodyVisual): void {
  visual.assetBinding?.dispose();
  scene.remove(visual.root, visual.markerRing);
  visual.mesh.geometry.dispose();
  visual.mesh.material.dispose();
  visual.halo?.material.map?.dispose();
  visual.halo?.material.dispose();
  if (visual.environment !== null) {
    disposeBodyEnvironmentVisual(visual.environment);
  }
  if (visual.blackHole !== null) {
    disposeBlackHoleVisual(visual.blackHole);
  }
  if (visual.planetaryRing !== null) {
    disposePlanetaryRingVisual(visual.planetaryRing);
  }
  visual.markerRing.geometry.dispose();
  visual.markerRing.material.dispose();
  visual.light?.dispose();
  visual.root.clear();
}

function createSphereGeometry(lod: BodyLod, backend: RendererBackend): SphereGeometry {
  const segments = getSphereSegments(lod, backend);
  return new SphereGeometry(1, segments.width, segments.height);
}

function createSurfaceMaterial(appearance: BodyAppearanceProfile): BodySurfaceMaterial {
  if (appearance.surfaceKind === 'star') {
    return new MeshBasicMaterial({ color: 0xffffff, vertexColors: true });
  }
  if (appearance.surfaceKind === 'black-hole') {
    return new MeshBasicMaterial({ color: appearance.baseColor });
  }

  return new MeshStandardMaterial({
    color: appearance.baseColor,
    emissive: appearance.emissiveColor,
    emissiveIntensity: appearance.emissiveIntensity,
    metalness: 0,
    roughness: appearance.roughness,
  });
}

function applyBodySurfaceColor(visual: BodyVisual): void {
  const baseColor =
    visual.appearance.surfaceKind === 'star' || visual.assetBinding?.hasSurfaceTexture() === true
      ? 0xffffff
      : visual.appearance.baseColor;
  visual.mesh.material.color.setHex(baseColor);
  if (visual.mesh.material instanceof MeshStandardMaterial) {
    visual.mesh.material.color.multiplyScalar(visual.stellarVisibility);
  }
}

function getAppearanceSignature(appearance: BodyAppearanceProfile): string {
  return [
    appearance.baseColor,
    appearance.emissiveColor,
    appearance.emissiveIntensity,
    appearance.structureSeed,
    appearance.surfaceKind,
  ].join(':');
}

function applySurfaceVertexColors(
  geometry: SphereGeometry,
  appearance: BodyAppearanceProfile,
): void {
  if (appearance.surfaceKind !== 'star') {
    geometry.deleteAttribute('color');
    return;
  }

  const positions = geometry.getAttribute('position');
  const colors = new Float32Array(positions.count * 3);
  const baseColor = new Color(appearance.baseColor);
  const seedPhase = (appearance.structureSeed % 10_000) / 10_000;
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const cells =
      Math.sin((x + seedPhase) * 21) *
      Math.sin((y - seedPhase) * 29) *
      Math.sin((z + seedPhase * 0.5) * 17);
    const broadBand = Math.sin((y + seedPhase) * 8) * 0.5;
    const brightness = 0.82 + cells * 0.12 + broadBand * 0.06;
    colors[index * 3] = Math.min(1, baseColor.r * brightness);
    colors[index * 3 + 1] = Math.min(1, baseColor.g * brightness);
    colors[index * 3 + 2] = Math.min(1, baseColor.b * brightness);
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
}

function createStarHalo(appearance: BodyAppearanceProfile): Sprite | null {
  if (appearance.surfaceKind !== 'star') {
    return null;
  }

  const material = new SpriteMaterial({
    blending: AdditiveBlending,
    color: appearance.emissiveColor,
    depthWrite: false,
    map: createRadialHaloTexture(),
    opacity: Math.min(0.52, 0.24 + appearance.emissiveIntensity * 0.06),
    transparent: true,
  });
  const halo = new Sprite(material);
  halo.renderOrder = 1;
  return halo;
}

function createRadialHaloTexture(): DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  const center = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const radialDistance = Math.hypot(x - center, y - center) / center;
      const falloff = Math.max(0, 1 - radialDistance);
      const alpha = Math.round(255 * falloff * falloff * (3 - 2 * falloff));
      const offset = (y * size + x) * 4;
      data[offset] = 255;
      data[offset + 1] = 255;
      data[offset + 2] = 255;
      data[offset + 3] = alpha;
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function createStellarLight(
  appearance: BodyAppearanceProfile,
  metersToSceneUnit: number,
): PointLight {
  const light = appearance.light;
  if (light === null) {
    throw new Error('发光天体缺少恒星灯光参数');
  }
  return new PointLight(
    light.color,
    computeScaledStellarLightIntensity(light.intensity, metersToSceneUnit),
    0,
    STELLAR_LIGHT_DISTANCE_DECAY,
  );
}
