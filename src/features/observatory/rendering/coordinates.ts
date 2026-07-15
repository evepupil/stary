import type { BodyState, PositionMeters } from '../../../physics/protocol/schemas';

export const DEFAULT_SCENE_EXTENT = 10;

export interface ScenePosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface SceneReprojectionOptions {
  readonly nextMetersToSceneUnit: number;
  readonly nextOriginMeters: PositionMeters;
  readonly originTracksSameBody: boolean;
  readonly previousMetersToSceneUnit: number;
  readonly previousOriginMeters: PositionMeters;
}

export function computeScenePhysicalExtentMeters(bodies: readonly BodyState[]): number {
  let furthestDistanceMeters = 0;
  let largestRadiusMeters = 0;

  for (const body of bodies) {
    const { x, y, z } = body.positionMeters;
    furthestDistanceMeters = Math.max(furthestDistanceMeters, Math.hypot(x, y, z));
    largestRadiusMeters = Math.max(largestRadiusMeters, body.radiusMeters);
  }

  return Math.max(furthestDistanceMeters, largestRadiusMeters);
}

export function computeMetersToSceneUnit(
  bodies: readonly BodyState[],
  sceneExtent = DEFAULT_SCENE_EXTENT,
): number {
  if (!Number.isFinite(sceneExtent) || sceneExtent <= 0) {
    throw new RangeError('sceneExtent 必须是正有限数');
  }

  const physicalExtentMeters = computeScenePhysicalExtentMeters(bodies);
  return physicalExtentMeters > 0 ? sceneExtent / physicalExtentMeters : 1;
}

export function shouldRecomputeSceneScale(
  previousExtentMeters: number,
  nextExtentMeters: number,
): boolean {
  if (!Number.isFinite(previousExtentMeters) || previousExtentMeters < 0) {
    throw new RangeError('previousExtentMeters 必须是非负有限数');
  }
  if (!Number.isFinite(nextExtentMeters) || nextExtentMeters < 0) {
    throw new RangeError('nextExtentMeters 必须是非负有限数');
  }
  if (previousExtentMeters === 0 || nextExtentMeters === 0) {
    return previousExtentMeters !== nextExtentMeters;
  }

  return (
    nextExtentMeters > previousExtentMeters * 1.05 || nextExtentMeters < previousExtentMeters * 0.5
  );
}

export function positionMetersToScene(
  positionMeters: PositionMeters,
  metersToSceneUnit: number,
  originMeters: PositionMeters = { x: 0, y: 0, z: 0 },
): ScenePosition {
  assertPositiveFiniteScale(metersToSceneUnit);
  assertFinitePosition(originMeters, 'originMeters');

  return {
    x: (positionMeters.x - originMeters.x) * metersToSceneUnit,
    y: (positionMeters.y - originMeters.y) * metersToSceneUnit,
    z: (positionMeters.z - originMeters.z) * metersToSceneUnit,
  };
}

export function reprojectScenePosition(
  position: ScenePosition,
  options: SceneReprojectionOptions,
): ScenePosition {
  assertFinitePosition(position, 'position');
  assertPositiveFiniteScale(options.previousMetersToSceneUnit);
  assertPositiveFiniteScale(options.nextMetersToSceneUnit);
  assertFinitePosition(options.previousOriginMeters, 'previousOriginMeters');
  assertFinitePosition(options.nextOriginMeters, 'nextOriginMeters');

  const scaleRatio = options.nextMetersToSceneUnit / options.previousMetersToSceneUnit;
  if (options.originTracksSameBody) {
    return {
      x: position.x * scaleRatio,
      y: position.y * scaleRatio,
      z: position.z * scaleRatio,
    };
  }

  return {
    x:
      (position.x / options.previousMetersToSceneUnit +
        options.previousOriginMeters.x -
        options.nextOriginMeters.x) *
      options.nextMetersToSceneUnit,
    y:
      (position.y / options.previousMetersToSceneUnit +
        options.previousOriginMeters.y -
        options.nextOriginMeters.y) *
      options.nextMetersToSceneUnit,
    z:
      (position.z / options.previousMetersToSceneUnit +
        options.previousOriginMeters.z -
        options.nextOriginMeters.z) *
      options.nextMetersToSceneUnit,
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

function assertFinitePosition(position: PositionMeters, name: string): void {
  if (![position.x, position.y, position.z].every(Number.isFinite)) {
    throw new RangeError(`${name} 必须包含有限坐标`);
  }
}
