import type { BodyState, PositionMeters } from '../../../physics/protocol/schemas';

export const DEFAULT_SCENE_EXTENT = 10;

export interface ScenePosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export function computeMetersToSceneUnit(
  bodies: readonly BodyState[],
  sceneExtent = DEFAULT_SCENE_EXTENT,
): number {
  if (!Number.isFinite(sceneExtent) || sceneExtent <= 0) {
    throw new RangeError('sceneExtent 必须是正有限数');
  }

  let furthestDistanceMeters = 0;
  let largestRadiusMeters = 0;

  for (const body of bodies) {
    const { x, y, z } = body.positionMeters;
    furthestDistanceMeters = Math.max(furthestDistanceMeters, Math.hypot(x, y, z));
    largestRadiusMeters = Math.max(largestRadiusMeters, body.radiusMeters);
  }

  const physicalExtentMeters = Math.max(furthestDistanceMeters, largestRadiusMeters);
  return physicalExtentMeters > 0 ? sceneExtent / physicalExtentMeters : 1;
}

export function positionMetersToScene(
  positionMeters: PositionMeters,
  metersToSceneUnit: number,
): ScenePosition {
  assertPositiveFiniteScale(metersToSceneUnit);

  return {
    x: positionMeters.x * metersToSceneUnit,
    y: positionMeters.y * metersToSceneUnit,
    z: positionMeters.z * metersToSceneUnit,
  };
}

export function physicalRadiusToSceneUnits(
  radiusMeters: number,
  metersToSceneUnit: number,
): number {
  if (!Number.isFinite(radiusMeters) || radiusMeters < 0) {
    throw new RangeError('radiusMeters 必须是非负有限数');
  }
  assertPositiveFiniteScale(metersToSceneUnit);

  return radiusMeters * metersToSceneUnit;
}

export function computePositionRingRadius(
  physicalRadiusSceneUnits: number,
  minimumRingRadiusSceneUnits: number,
): number {
  if (!Number.isFinite(physicalRadiusSceneUnits) || physicalRadiusSceneUnits < 0) {
    throw new RangeError('physicalRadiusSceneUnits 必须是非负有限数');
  }
  if (!Number.isFinite(minimumRingRadiusSceneUnits) || minimumRingRadiusSceneUnits < 0) {
    throw new RangeError('minimumRingRadiusSceneUnits 必须是非负有限数');
  }

  return Math.max(physicalRadiusSceneUnits * 1.65, minimumRingRadiusSceneUnits);
}

function assertPositiveFiniteScale(metersToSceneUnit: number): void {
  if (!Number.isFinite(metersToSceneUnit) || metersToSceneUnit <= 0) {
    throw new RangeError('metersToSceneUnit 必须是正有限数');
  }
}
