import type { BodySurfaceKind } from './appearance/body-appearance';
import type { ObservatoryViewMode } from './camera-focus';
import { OBSERVATORY_TONE_MAPPING_EXPOSURE } from './create-renderer';

const MINIMUM_EXPOSURE = 0.62;
const MAXIMUM_EXPOSURE = 1.38;
const DARKENING_TIME_CONSTANT_SECONDS = 0.35;
const BRIGHTENING_TIME_CONSTANT_SECONDS = 1.4;
const MAXIMUM_FRAME_DELTA_SECONDS = 0.25;

export interface ExposureObservation {
  readonly illuminatedFraction: number;
  readonly stellarVisibility: number;
  readonly surfaceKind: BodySurfaceKind | null;
  readonly viewMode: ObservatoryViewMode;
}

export function computeTargetExposure(observation: ExposureObservation): number {
  if (observation.viewMode === 'overview' || observation.surfaceKind === null) {
    return OBSERVATORY_TONE_MAPPING_EXPOSURE;
  }
  if (observation.surfaceKind === 'star') {
    return 0.68;
  }
  if (observation.surfaceKind === 'black-hole') {
    return MAXIMUM_EXPOSURE;
  }
  const illuminatedFraction = clampUnitInterval(
    observation.illuminatedFraction,
    'illuminatedFraction',
  );
  const stellarVisibility = clampUnitInterval(observation.stellarVisibility, 'stellarVisibility');
  const visibleDaylight = illuminatedFraction * stellarVisibility;
  return clamp(1.02 + (1 - visibleDaylight) * 0.32, MINIMUM_EXPOSURE, MAXIMUM_EXPOSURE);
}

export function advanceAdaptiveExposure(
  current: number,
  target: number,
  deltaSeconds: number,
): number {
  assertPositiveFinite(current, 'current');
  assertPositiveFinite(target, 'target');
  if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
    throw new RangeError('deltaSeconds 必须是非负有限数');
  }
  if (deltaSeconds === 0 || current === target) {
    return current;
  }
  const timeConstant =
    target < current ? DARKENING_TIME_CONSTANT_SECONDS : BRIGHTENING_TIME_CONSTANT_SECONDS;
  const boundedDelta = Math.min(deltaSeconds, MAXIMUM_FRAME_DELTA_SECONDS);
  const blend = 1 - Math.exp(-boundedDelta / timeConstant);
  return current + (target - current) * blend;
}

function clampUnitInterval(value: number, name: string): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} 必须是有限数`);
  }
  return clamp(value, 0, 1);
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} 必须是正有限数`);
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
