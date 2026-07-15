import {
  AdditiveBlending,
  BackSide,
  ClampToEdgeWrapping,
  DataTexture,
  FrontSide,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NoColorSpace,
  Quaternion,
  RepeatWrapping,
  RGBAFormat,
  SphereGeometry,
  UnsignedByteType,
  Vector3,
} from 'three';

import {
  computeCloudPhaseRadians,
  type BodyEnvironmentProfile,
  type CloudLayerProfile,
} from '../appearance/body-environment';
import type { RendererBackend } from '../create-renderer';
import { getSphereSegments } from '../render-scale';

export interface CloudLayerVisual {
  readonly cloudMesh: Mesh<SphereGeometry, MeshStandardMaterial>;
  readonly fallbackAlphaMap: DataTexture;
  readonly profile: CloudLayerProfile;
  readonly shadowMesh: Mesh<SphereGeometry, MeshBasicMaterial>;
  phaseRadians: number;
  shadowLighting: number;
  shadowLightDirection: { readonly x: number; readonly y: number; readonly z: number } | null;
  shadowRequested: boolean;
}

interface AtmosphereShellVisual {
  readonly baseOpacity: number;
  readonly mesh: Mesh<SphereGeometry, MeshBasicMaterial>;
}

export interface BodyEnvironmentVisual {
  readonly atmosphereShells: readonly AtmosphereShellVisual[];
  readonly clouds: CloudLayerVisual | null;
  readonly geometry: SphereGeometry;
  readonly group: Group;
  readonly profile: BodyEnvironmentProfile;
}

export function createBodyEnvironmentVisual(
  profile: BodyEnvironmentProfile,
  backend: RendererBackend,
  structureSeed: number,
): BodyEnvironmentVisual {
  const segments = getSphereSegments('medium', backend);
  const geometry = new SphereGeometry(1, segments.width, segments.height);
  const group = new Group();
  group.name = 'body-environment';
  const atmosphereShells = profile.atmosphereLayers.map((layer, index) => {
    const material = new MeshBasicMaterial({
      blending: AdditiveBlending,
      color: layer.color,
      depthTest: true,
      depthWrite: false,
      opacity: layer.opacity,
      side: BackSide,
      transparent: true,
    });
    const mesh = new Mesh(geometry, material);
    mesh.name = `atmosphere-shell-${String(index + 1)}`;
    mesh.renderOrder = 4 + index * 0.01;
    mesh.scale.setScalar(layer.radiusRatio);
    group.add(mesh);
    return { baseOpacity: layer.opacity, mesh };
  });

  const clouds =
    profile.clouds === null
      ? null
      : createCloudLayerVisual(geometry, profile.clouds, structureSeed, group);

  return { atmosphereShells, clouds, geometry, group, profile };
}

export function updateBodyEnvironmentScale(
  environment: BodyEnvironmentVisual,
  physicalRadiusSceneUnits: number,
): void {
  environment.group.scale.setScalar(physicalRadiusSceneUnits);
}

export function updateBodyEnvironmentTime(
  environment: BodyEnvironmentVisual,
  simulationTimeSeconds: number,
): void {
  const clouds = environment.clouds;
  if (clouds === null) {
    return;
  }
  const phaseRadians = computeCloudPhaseRadians(clouds.profile, simulationTimeSeconds);
  clouds.phaseRadians = phaseRadians;
  clouds.cloudMesh.rotation.y = phaseRadians;
  applyCloudShadowTransform(clouds);
}

export function updateBodyEnvironmentVisibility(
  environment: BodyEnvironmentVisual,
  projectedRadiusPixels: number,
  cloudShadowsEnabled: boolean,
): void {
  const atmosphereVisible = projectedRadiusPixels >= 5;
  for (const shell of environment.atmosphereShells) {
    shell.mesh.visible = atmosphereVisible;
  }
  if (environment.clouds !== null) {
    const cloudsVisible = projectedRadiusPixels >= 12;
    environment.clouds.cloudMesh.visible = cloudsVisible;
    environment.clouds.shadowRequested = cloudsVisible && cloudShadowsEnabled;
    updateCloudShadowVisibility(environment.clouds);
  }
}

export function updateBodyEnvironmentLighting(
  environment: BodyEnvironmentVisual,
  illuminatedFraction: number,
  stellarVisibility: number,
  lightDirection: { readonly x: number; readonly y: number; readonly z: number } | null = null,
): void {
  const lighting = clamp(0.28 + illuminatedFraction * stellarVisibility * 0.72, 0.28, 1);
  for (const shell of environment.atmosphereShells) {
    shell.mesh.material.opacity = shell.baseOpacity * lighting;
  }
  if (environment.clouds !== null) {
    const lightLength =
      lightDirection === null
        ? 0
        : Math.hypot(lightDirection.x, lightDirection.y, lightDirection.z);
    if (lightDirection !== null && (!Number.isFinite(lightLength) || lightLength <= 0)) {
      throw new RangeError('云影光照方向必须是非零有限向量');
    }
    environment.clouds.shadowLighting = clamp(illuminatedFraction * stellarVisibility, 0, 1);
    environment.clouds.shadowLightDirection =
      lightDirection === null
        ? null
        : {
            x: lightDirection.x / lightLength,
            y: lightDirection.y / lightLength,
            z: lightDirection.z / lightLength,
          };
    environment.clouds.shadowMesh.material.opacity =
      environment.clouds.profile.shadowOpacity * environment.clouds.shadowLighting;
    applyCloudShadowTransform(environment.clouds);
    updateCloudShadowVisibility(environment.clouds);
  }
}

export function disposeBodyEnvironmentVisual(environment: BodyEnvironmentVisual): void {
  for (const shell of environment.atmosphereShells) {
    shell.mesh.material.dispose();
  }
  if (environment.clouds !== null) {
    environment.clouds.cloudMesh.material.dispose();
    environment.clouds.shadowMesh.material.dispose();
    environment.clouds.fallbackAlphaMap.dispose();
  }
  environment.geometry.dispose();
  environment.group.clear();
}

function createCloudLayerVisual(
  geometry: SphereGeometry,
  profile: CloudLayerProfile,
  structureSeed: number,
  group: Group,
): CloudLayerVisual {
  const fallbackAlphaMap = createProceduralCloudAlphaMap(structureSeed);
  const cloudMaterial = new MeshStandardMaterial({
    alphaMap: fallbackAlphaMap,
    alphaTest: 0.035,
    color: 0xffffff,
    depthTest: true,
    depthWrite: false,
    metalness: 0,
    opacity: profile.opacity,
    roughness: 1,
    side: FrontSide,
    transparent: true,
  });
  const cloudMesh = new Mesh(geometry, cloudMaterial);
  cloudMesh.name = 'cloud-layer';
  cloudMesh.renderOrder = 5;
  cloudMesh.scale.setScalar(profile.radiusRatio);

  const shadowMaterial = new MeshBasicMaterial({
    alphaMap: fallbackAlphaMap,
    alphaTest: 0.035,
    color: 0x101820,
    depthTest: true,
    depthWrite: false,
    opacity: profile.shadowOpacity,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    side: FrontSide,
    transparent: true,
  });
  const shadowMesh = new Mesh(geometry, shadowMaterial);
  shadowMesh.name = 'cloud-shadow-layer';
  shadowMesh.renderOrder = 3;
  shadowMesh.scale.setScalar(profile.shadowRadiusRatio);

  group.add(shadowMesh, cloudMesh);
  return {
    cloudMesh,
    fallbackAlphaMap,
    phaseRadians: 0,
    profile,
    shadowLighting: 0,
    shadowLightDirection: null,
    shadowMesh,
    shadowRequested: false,
  };
}

function applyCloudShadowTransform(clouds: CloudLayerVisual): void {
  const phaseRotation = new Quaternion().setFromAxisAngle(
    new Vector3(0, 1, 0),
    clouds.phaseRadians,
  );
  clouds.shadowMesh.quaternion.copy(phaseRotation);
  const lightDirection = clouds.shadowLightDirection;
  if (lightDirection === null) {
    return;
  }
  const direction = new Vector3(lightDirection.x, lightDirection.y, lightDirection.z);
  const axis = new Vector3(0, 1, 0).cross(direction);
  if (axis.lengthSq() <= Number.EPSILON) {
    axis.set(lightDirection.y >= 0 ? 1 : -1, 0, 0);
  } else {
    axis.normalize();
  }
  const directionalOffset = new Quaternion().setFromAxisAngle(
    axis,
    clouds.profile.shadowOffsetRadians,
  );
  clouds.shadowMesh.quaternion.premultiply(directionalOffset);
}

function updateCloudShadowVisibility(clouds: CloudLayerVisual): void {
  clouds.shadowMesh.visible =
    clouds.shadowRequested && clouds.shadowLightDirection !== null && clouds.shadowLighting > 0.02;
}

export function createProceduralCloudAlphaData(
  structureSeed: number,
  width = 256,
  height = 128,
): Uint8Array {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 2 || height < 2) {
    throw new RangeError('云纹理尺寸必须是至少 2 的安全整数');
  }
  const data = new Uint8Array(width * height * 4);
  const phase = (structureSeed % 65_521) / 65_521;
  for (let y = 0; y < height; y += 1) {
    const latitude = (y / (height - 1) - 0.5) * Math.PI;
    const polarFade = Math.cos(latitude) ** 0.35;
    for (let x = 0; x < width; x += 1) {
      const longitude = (x / width) * Math.PI * 2;
      const broad =
        Math.sin(longitude * 3 + Math.sin(latitude * 4) + phase * Math.PI * 2) * 0.32 +
        Math.sin(longitude * 7 - latitude * 5 + phase * 9) * 0.2;
      const detail =
        Math.sin(longitude * 17 + latitude * 11 + phase * 21) * 0.12 +
        Math.cos(longitude * 29 - latitude * 19 + phase * 37) * 0.08;
      const density = clamp((broad + detail + 0.24) * polarFade, 0, 1);
      const alpha = Math.round(255 * smoothstep(0.18, 0.58, density));
      const offset = (y * width + x) * 4;
      data[offset] = alpha;
      data[offset + 1] = alpha;
      data[offset + 2] = alpha;
      data[offset + 3] = 255;
    }
  }
  return data;
}

function createProceduralCloudAlphaMap(structureSeed: number): DataTexture {
  const width = 256;
  const height = 128;
  const texture = new DataTexture(
    createProceduralCloudAlphaData(structureSeed, width, height),
    width,
    height,
    RGBAFormat,
    UnsignedByteType,
  );
  texture.name = 'procedural-cloud-opacity';
  texture.colorSpace = NoColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const normalized = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return normalized * normalized * (3 - 2 * normalized);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
