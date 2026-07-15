import type { RendererBackend } from './create-renderer';

export type RenderScaleTier = 'system' | 'orbit' | 'surface';
export type BodyLod = 'low' | 'medium' | 'high';

export interface SphereSegments {
  readonly height: number;
  readonly width: number;
}

export const RENDER_SCALE_THRESHOLDS = {
  orbit: {
    enterPixels: 14,
    exitPixels: 10,
    defaultPixels: 12,
  },
  surface: {
    enterPixels: 144,
    exitPixels: 96,
    defaultPixels: 120,
  },
} as const;

export const BODY_LOD_THRESHOLDS = {
  medium: {
    enterPixels: 7,
    exitPixels: 5,
    defaultPixels: 6,
  },
  high: {
    enterPixels: 96,
    exitPixels: 64,
    defaultPixels: 80,
  },
} as const;

const SPHERE_SEGMENTS = {
  webgpu: {
    low: { width: 24, height: 16 },
    medium: { width: 48, height: 32 },
    high: { width: 96, height: 64 },
  },
  webgl2: {
    low: { width: 20, height: 12 },
    medium: { width: 36, height: 24 },
    high: { width: 64, height: 40 },
  },
} as const satisfies Record<RendererBackend, Record<BodyLod, SphereSegments>>;

export function computeProjectedRadiusPixels(
  radiusSceneUnits: number,
  cameraDistanceSceneUnits: number,
  verticalFieldOfViewDegrees: number,
  viewportHeightPixels: number,
): number {
  assertPositiveFinite(radiusSceneUnits, 'radiusSceneUnits');
  assertPositiveFinite(cameraDistanceSceneUnits, 'cameraDistanceSceneUnits');
  assertPositiveFinite(viewportHeightPixels, 'viewportHeightPixels');
  assertPositiveFinite(verticalFieldOfViewDegrees, 'verticalFieldOfViewDegrees');
  if (verticalFieldOfViewDegrees >= 180) {
    throw new RangeError('verticalFieldOfViewDegrees 必须小于 180');
  }

  const focalLengthPixels =
    viewportHeightPixels / (2 * Math.tan((verticalFieldOfViewDegrees * Math.PI) / 360));
  return (radiusSceneUnits * focalLengthPixels) / cameraDistanceSceneUnits;
}

export function selectRenderScaleTier(
  projectedRadiusPixels: number,
  previousTier?: RenderScaleTier,
): RenderScaleTier {
  assertPositiveFinite(projectedRadiusPixels, 'projectedRadiusPixels');

  if (previousTier === undefined) {
    return selectDefaultRenderScaleTier(projectedRadiusPixels);
  }

  switch (previousTier) {
    case 'system':
      if (projectedRadiusPixels < RENDER_SCALE_THRESHOLDS.orbit.enterPixels) {
        return 'system';
      }
      return projectedRadiusPixels >= RENDER_SCALE_THRESHOLDS.surface.enterPixels
        ? 'surface'
        : 'orbit';
    case 'orbit':
      if (projectedRadiusPixels < RENDER_SCALE_THRESHOLDS.orbit.exitPixels) {
        return 'system';
      }
      return projectedRadiusPixels >= RENDER_SCALE_THRESHOLDS.surface.enterPixels
        ? 'surface'
        : 'orbit';
    case 'surface':
      if (projectedRadiusPixels >= RENDER_SCALE_THRESHOLDS.surface.exitPixels) {
        return 'surface';
      }
      return projectedRadiusPixels < RENDER_SCALE_THRESHOLDS.orbit.exitPixels ? 'system' : 'orbit';
  }
}

export function selectBodyLod(projectedRadiusPixels: number, previousLod?: BodyLod): BodyLod {
  assertPositiveFinite(projectedRadiusPixels, 'projectedRadiusPixels');

  if (previousLod === undefined) {
    return selectDefaultBodyLod(projectedRadiusPixels);
  }

  switch (previousLod) {
    case 'low':
      if (projectedRadiusPixels < BODY_LOD_THRESHOLDS.medium.enterPixels) {
        return 'low';
      }
      return projectedRadiusPixels >= BODY_LOD_THRESHOLDS.high.enterPixels ? 'high' : 'medium';
    case 'medium':
      if (projectedRadiusPixels < BODY_LOD_THRESHOLDS.medium.exitPixels) {
        return 'low';
      }
      return projectedRadiusPixels >= BODY_LOD_THRESHOLDS.high.enterPixels ? 'high' : 'medium';
    case 'high':
      if (projectedRadiusPixels >= BODY_LOD_THRESHOLDS.high.exitPixels) {
        return 'high';
      }
      return projectedRadiusPixels < BODY_LOD_THRESHOLDS.medium.exitPixels ? 'low' : 'medium';
  }
}

export function getSphereSegments(lod: BodyLod, backend: RendererBackend): SphereSegments {
  return SPHERE_SEGMENTS[backend][lod];
}

function selectDefaultRenderScaleTier(projectedRadiusPixels: number): RenderScaleTier {
  if (projectedRadiusPixels >= RENDER_SCALE_THRESHOLDS.surface.defaultPixels) {
    return 'surface';
  }
  if (projectedRadiusPixels >= RENDER_SCALE_THRESHOLDS.orbit.defaultPixels) {
    return 'orbit';
  }
  return 'system';
}

function selectDefaultBodyLod(projectedRadiusPixels: number): BodyLod {
  if (projectedRadiusPixels >= BODY_LOD_THRESHOLDS.high.defaultPixels) {
    return 'high';
  }
  if (projectedRadiusPixels >= BODY_LOD_THRESHOLDS.medium.defaultPixels) {
    return 'medium';
  }
  return 'low';
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} 必须是正有限数`);
  }
}
