import {
  BufferAttribute,
  ClampToEdgeWrapping,
  DataTexture,
  DoubleSide,
  FrontSide,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NoColorSpace,
  RGBAFormat,
  RingGeometry,
  SphereGeometry,
  UnsignedByteType,
} from 'three';

import type { PlanetaryRingPlan } from '../assets/body-asset-plan';
import type { RendererBackend } from '../create-renderer';

export interface PlanetaryRingVisual {
  readonly axialTiltDegrees: number;
  readonly fallbackAlphaMap: DataTexture;
  readonly innerRadiusRatio: number;
  readonly mesh: Mesh<RingGeometry, MeshStandardMaterial>;
  readonly outerRadiusRatio: number;
  readonly shadowMap: DataTexture;
  readonly shadowMesh: Mesh<SphereGeometry, MeshBasicMaterial>;
  shadowLatitudeOffset: number;
}

export function createPlanetaryRingVisual(
  plan: PlanetaryRingPlan,
  backend: RendererBackend,
): PlanetaryRingVisual {
  const geometry = new RingGeometry(
    plan.innerRadiusRatio,
    plan.outerRadiusRatio,
    backend === 'webgpu' ? 256 : 160,
    1,
  );
  applyRadialRingUvs(geometry, plan.innerRadiusRatio, plan.outerRadiusRatio);
  const fallbackAlphaMap = createFallbackRingAlphaMap();
  const material = new MeshStandardMaterial({
    alphaMap: fallbackAlphaMap,
    alphaTest: 0.025,
    color: 0xd8c89f,
    depthWrite: true,
    metalness: 0,
    opacity: 0.94,
    roughness: 0.88,
    side: DoubleSide,
    transparent: true,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'saturn-planetary-ring';
  mesh.renderOrder = 2;
  mesh.rotation.x = (plan.axialTiltDegrees * Math.PI) / 180;
  mesh.userData.planetaryRing = true;
  const shadowMap = createRingShadowMap();
  const shadowMaterial = new MeshBasicMaterial({
    alphaMap: shadowMap,
    alphaTest: 0.02,
    color: 0x111418,
    depthTest: true,
    depthWrite: false,
    opacity: 0,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    side: FrontSide,
    transparent: true,
  });
  const shadowMesh = new Mesh(
    new SphereGeometry(1, backend === 'webgpu' ? 72 : 48, backend === 'webgpu' ? 48 : 32),
    shadowMaterial,
  );
  shadowMesh.name = 'saturn-ring-shadow';
  shadowMesh.renderOrder = 3.2;
  shadowMesh.rotation.x = mesh.rotation.x;
  shadowMesh.visible = false;

  return {
    axialTiltDegrees: plan.axialTiltDegrees,
    fallbackAlphaMap,
    innerRadiusRatio: plan.innerRadiusRatio,
    mesh,
    outerRadiusRatio: plan.outerRadiusRatio,
    shadowMap,
    shadowLatitudeOffset: 0,
    shadowMesh,
  };
}

export function updatePlanetaryRingShadow(
  visual: PlanetaryRingVisual,
  lightDirection: { readonly x: number; readonly y: number; readonly z: number } | null,
): void {
  if (lightDirection === null) {
    visual.shadowLatitudeOffset = 0;
    visual.shadowMap.offset.y = 0;
    visual.shadowMesh.material.opacity = 0;
    visual.shadowMesh.visible = false;
    return;
  }
  const length = Math.hypot(lightDirection.x, lightDirection.y, lightDirection.z);
  if (!Number.isFinite(length) || length <= 0) {
    throw new RangeError('行星环光照方向必须是非零有限向量');
  }
  const tilt = (visual.axialTiltDegrees * Math.PI) / 180;
  const normal = { x: 0, y: -Math.sin(tilt), z: Math.cos(tilt) };
  const incidence = Math.abs(
    (normal.x * lightDirection.x + normal.y * lightDirection.y + normal.z * lightDirection.z) /
      length,
  );
  const signedIncidence =
    (normal.x * lightDirection.x + normal.y * lightDirection.y + normal.z * lightDirection.z) /
    length;
  const maximumShadowIncidence = Math.min(1, 1 / visual.innerRadiusRatio);
  const normalizedShadowIncidence = Math.min(1, incidence / maximumShadowIncidence);
  const shadowStrength =
    incidence >= maximumShadowIncidence ? 0 : Math.sin(normalizedShadowIncidence * Math.PI);
  visual.shadowLatitudeOffset = signedIncidence * 0.075;
  visual.shadowMap.offset.y = visual.shadowLatitudeOffset;
  visual.shadowMesh.material.opacity = shadowStrength * 0.32;
  visual.shadowMesh.visible = shadowStrength > 0.02;
}

export function applyRadialRingUvs(
  geometry: RingGeometry,
  innerRadiusRatio: number,
  outerRadiusRatio: number,
): void {
  if (
    !Number.isFinite(innerRadiusRatio) ||
    !Number.isFinite(outerRadiusRatio) ||
    innerRadiusRatio <= 0 ||
    outerRadiusRatio <= innerRadiusRatio
  ) {
    throw new RangeError('行星环半径比例无效');
  }

  const positions = geometry.getAttribute('position');
  const uvs = new Float32Array(positions.count * 2);
  const radialSpan = outerRadiusRatio - innerRadiusRatio;
  for (let index = 0; index < positions.count; index += 1) {
    const radius = Math.hypot(positions.getX(index), positions.getY(index));
    uvs[index * 2] = Math.min(1, Math.max(0, (radius - innerRadiusRatio) / radialSpan));
    uvs[index * 2 + 1] = 0.5;
  }
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
}

export function disposePlanetaryRingVisual(visual: PlanetaryRingVisual): void {
  visual.mesh.geometry.dispose();
  visual.mesh.material.dispose();
  visual.fallbackAlphaMap.dispose();
  visual.shadowMesh.geometry.dispose();
  visual.shadowMesh.material.dispose();
  visual.shadowMap.dispose();
}

function createFallbackRingAlphaMap(): DataTexture {
  const width = 256;
  const height = 4;
  const data = new Uint8Array(width * height * 4);
  for (let x = 0; x < width; x += 1) {
    const radius = x / (width - 1);
    const bands =
      0.54 + Math.sin(radius * Math.PI * 18) * 0.13 + Math.sin(radius * Math.PI * 53) * 0.07;
    const cassiniDivision = Math.exp(-((radius - 0.63) ** 2) / 0.0007);
    const edgeFade = Math.min(1, radius * 10, (1 - radius) * 12);
    const alpha = Math.round(255 * Math.max(0.04, bands - cassiniDivision * 0.5) * edgeFade);
    for (let y = 0; y < height; y += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = alpha;
      data[offset + 1] = alpha;
      data[offset + 2] = alpha;
      data[offset + 3] = 255;
    }
  }
  const texture = new DataTexture(data, width, height, RGBAFormat, UnsignedByteType);
  texture.name = 'saturn-ring-procedural-fallback';
  texture.colorSpace = NoColorSpace;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function createRingShadowMap(): DataTexture {
  const width = 256;
  const height = 128;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const latitude = Math.abs(y / (height - 1) - 0.5);
    const core = Math.exp(-((latitude / 0.034) ** 2));
    const division = Math.exp(-(((latitude - 0.018) / 0.0045) ** 2));
    const alpha = Math.round(255 * Math.max(0, core - division * 0.42));
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = alpha;
      data[offset + 1] = alpha;
      data[offset + 2] = alpha;
      data[offset + 3] = 255;
    }
  }
  const texture = new DataTexture(data, width, height, RGBAFormat, UnsignedByteType);
  texture.name = 'saturn-ring-shadow-opacity';
  texture.colorSpace = NoColorSpace;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
