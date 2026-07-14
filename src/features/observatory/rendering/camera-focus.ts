import type { BodyState } from '../../../physics/protocol/schemas';
import {
  DEFAULT_SCENE_EXTENT,
  physicalRadiusToSceneUnits,
  positionMetersToScene,
} from './coordinates';
import { computeCameraFitDistance } from './camera-fit';
import type { ScenePosition } from './coordinates';

const MINIMUM_FOCUS_HALF_EXTENT = 0.001;
const FOCUS_PAIR_PADDING = 1.32;

export type ObservatoryViewMode = 'overview' | 'focus';

export interface ObservatoryCameraFrame {
  readonly target: ScenePosition;
  readonly halfExtent: number;
  readonly distance: number;
}

export function computeOverviewCameraFrame(
  aspect: number,
  sceneHalfExtent = DEFAULT_SCENE_EXTENT,
): ObservatoryCameraFrame {
  return {
    target: { x: 0, y: 0, z: 0 },
    halfExtent: sceneHalfExtent,
    distance: computeCameraFitDistance(sceneHalfExtent, aspect),
  };
}

export function computeFocusCameraFrame(
  body: BodyState,
  parent: BodyState | null,
  metersToSceneUnit: number,
  aspect: number,
): ObservatoryCameraFrame {
  const bodyPosition = positionMetersToScene(body.positionMeters, metersToSceneUnit);
  const bodyRadius = physicalRadiusToSceneUnits(body.radiusMeters, metersToSceneUnit);

  if (parent === null) {
    const halfExtent = Math.max(MINIMUM_FOCUS_HALF_EXTENT, bodyRadius * 2.4);
    return {
      target: bodyPosition,
      halfExtent,
      distance: computeCameraFitDistance(halfExtent, aspect),
    };
  }

  const parentPosition = positionMetersToScene(parent.positionMeters, metersToSceneUnit);
  const parentRadius = physicalRadiusToSceneUnits(parent.radiusMeters, metersToSceneUnit);
  const target = {
    x: (bodyPosition.x + parentPosition.x) / 2,
    y: (bodyPosition.y + parentPosition.y) / 2,
    z: (bodyPosition.z + parentPosition.z) / 2,
  };
  const separation = Math.hypot(
    bodyPosition.x - parentPosition.x,
    bodyPosition.y - parentPosition.y,
    bodyPosition.z - parentPosition.z,
  );
  const radialExtent = Math.max(
    distance(target, bodyPosition) + bodyRadius,
    distance(target, parentPosition) + parentRadius,
  );
  const halfExtent = Math.max(
    MINIMUM_FOCUS_HALF_EXTENT,
    radialExtent * FOCUS_PAIR_PADDING,
    separation * 0.55,
  );

  return {
    target,
    halfExtent,
    distance: computeCameraFitDistance(halfExtent, aspect),
  };
}

function distance(left: ScenePosition, right: ScenePosition): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}
