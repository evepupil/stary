import {
  BufferAttribute,
  ClampToEdgeWrapping,
  DataTexture,
  DoubleSide,
  LinearFilter,
  Mesh,
  MeshStandardMaterial,
  NoColorSpace,
  RGBAFormat,
  RingGeometry,
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

  return {
    axialTiltDegrees: plan.axialTiltDegrees,
    fallbackAlphaMap,
    innerRadiusRatio: plan.innerRadiusRatio,
    mesh,
    outerRadiusRatio: plan.outerRadiusRatio,
  };
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
