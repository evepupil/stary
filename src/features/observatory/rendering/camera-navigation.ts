import type { ObservatoryCameraFrame } from './camera-focus';
import { RENDER_SCALE_THRESHOLDS, type RenderScaleTier } from './render-scale';

export interface CameraNavigationSettings {
  readonly dampingFactor: number;
  readonly far: number;
  readonly maxDistance: number;
  readonly minDistance: number;
  readonly near: number;
  readonly rotateSpeed: number;
  readonly zoomSpeed: number;
}

const INTERACTION_BY_TIER = {
  system: { dampingFactor: 0.06, rotateSpeed: 0.55, zoomSpeed: 0.8 },
  orbit: { dampingFactor: 0.07, rotateSpeed: 0.42, zoomSpeed: 0.62 },
  surface: { dampingFactor: 0.085, rotateSpeed: 0.28, zoomSpeed: 0.38 },
} as const satisfies Record<
  RenderScaleTier,
  Pick<CameraNavigationSettings, 'dampingFactor' | 'rotateSpeed' | 'zoomSpeed'>
>;

const INTERACTION_PROJECTED_RADIUS_ANCHORS = {
  system: RENDER_SCALE_THRESHOLDS.orbit.exitPixels / 2,
  orbit: Math.sqrt(
    RENDER_SCALE_THRESHOLDS.orbit.enterPixels * RENDER_SCALE_THRESHOLDS.surface.exitPixels,
  ),
  surface: RENDER_SCALE_THRESHOLDS.surface.enterPixels * 2,
} as const satisfies Record<RenderScaleTier, number>;

export function computeCameraNavigationSettings(
  tier: RenderScaleTier,
  currentDistance: number,
  frame: ObservatoryCameraFrame,
  overviewDistance: number,
  projectedRadiusPixels = INTERACTION_PROJECTED_RADIUS_ANCHORS[tier],
): CameraNavigationSettings {
  assertPositiveFinite(currentDistance, 'currentDistance');
  assertPositiveFinite(overviewDistance, 'overviewDistance');
  assertPositiveFinite(projectedRadiusPixels, 'projectedRadiusPixels');
  const interaction = computeInteractionSettings(projectedRadiusPixels);
  const minDistance = frame.minimumDistance;
  const maxDistance = Math.max(
    minDistance * 2,
    frame.distance * 4,
    overviewDistance * (tier === 'system' ? 2 : 1.35),
  );
  const nearestVisibleDistance = Math.max(
    currentDistance - minDistance / 1.03,
    currentDistance * 1e-6,
  );
  const near = Math.max(1e-12, Math.min(currentDistance * 1e-3, nearestVisibleDistance * 0.25));
  const far =
    tier === 'surface'
      ? Math.max(currentDistance * 12, frame.halfExtent * 96)
      : tier === 'orbit'
        ? Math.max(currentDistance * 16, frame.halfExtent * 128, overviewDistance * 4)
        : Math.max(320, currentDistance * 16, overviewDistance * 12);

  return { ...interaction, far, maxDistance, minDistance, near };
}

function computeInteractionSettings(
  projectedRadiusPixels: number,
): Pick<CameraNavigationSettings, 'dampingFactor' | 'rotateSpeed' | 'zoomSpeed'> {
  if (projectedRadiusPixels <= INTERACTION_PROJECTED_RADIUS_ANCHORS.orbit) {
    const progress = logarithmicProgress(
      projectedRadiusPixels,
      INTERACTION_PROJECTED_RADIUS_ANCHORS.system,
      INTERACTION_PROJECTED_RADIUS_ANCHORS.orbit,
    );
    return interpolateInteraction(INTERACTION_BY_TIER.system, INTERACTION_BY_TIER.orbit, progress);
  }
  const progress = logarithmicProgress(
    projectedRadiusPixels,
    INTERACTION_PROJECTED_RADIUS_ANCHORS.orbit,
    INTERACTION_PROJECTED_RADIUS_ANCHORS.surface,
  );
  return interpolateInteraction(INTERACTION_BY_TIER.orbit, INTERACTION_BY_TIER.surface, progress);
}

function interpolateInteraction(
  start: Pick<CameraNavigationSettings, 'dampingFactor' | 'rotateSpeed' | 'zoomSpeed'>,
  end: Pick<CameraNavigationSettings, 'dampingFactor' | 'rotateSpeed' | 'zoomSpeed'>,
  progress: number,
): Pick<CameraNavigationSettings, 'dampingFactor' | 'rotateSpeed' | 'zoomSpeed'> {
  const eased = progress * progress * (3 - 2 * progress);
  return {
    dampingFactor: interpolate(start.dampingFactor, end.dampingFactor, eased),
    rotateSpeed: interpolate(start.rotateSpeed, end.rotateSpeed, eased),
    zoomSpeed: interpolate(start.zoomSpeed, end.zoomSpeed, eased),
  };
}

function logarithmicProgress(value: number, start: number, end: number): number {
  return clamp((Math.log(value) - Math.log(start)) / (Math.log(end) - Math.log(start)), 0, 1);
}

function interpolate(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

export function computeCameraTransitionDurationMilliseconds(
  startDistance: number,
  endDistance: number,
): number {
  assertPositiveFinite(startDistance, 'startDistance');
  assertPositiveFinite(endDistance, 'endDistance');
  const logarithmicSpan = Math.abs(Math.log(endDistance / startDistance));
  return clamp(420 + logarithmicSpan * 42, 420, 960);
}

export function easeCameraTransitionProgress(progress: number): number {
  if (!Number.isFinite(progress)) {
    throw new RangeError('progress 必须是有限数');
  }
  const bounded = clamp(progress, 0, 1);
  return bounded * bounded * (3 - 2 * bounded);
}

export function interpolateCameraDistance(
  startDistance: number,
  endDistance: number,
  progress: number,
): number {
  assertPositiveFinite(startDistance, 'startDistance');
  assertPositiveFinite(endDistance, 'endDistance');
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
    throw new RangeError('progress 必须在 0 到 1 之间');
  }
  return Math.exp(
    Math.log(startDistance) + (Math.log(endDistance) - Math.log(startDistance)) * progress,
  );
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} 必须是正有限数`);
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
