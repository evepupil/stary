import type { BodyState, PositionMeters } from '../../../physics/protocol/schemas';
import {
  DEFAULT_SCENE_EXTENT,
  physicalRadiusToSceneUnits,
  positionMetersToScene,
} from './coordinates';
import { computeCameraFitDistance } from './camera-fit';
import type { ScenePosition } from './coordinates';
import type { RenderScaleTier } from './render-scale';

const MINIMUM_FOCUS_HALF_EXTENT = 0.001;
const FOCUS_PAIR_PADDING = 1.32;

export type ObservatoryViewMode = 'overview' | 'focus';

export interface ObservatoryCameraFrame {
  readonly target: ScenePosition;
  readonly halfExtent: number;
  readonly distance: number;
  readonly minimumDistance: number;
  readonly tier: RenderScaleTier;
}

export function computeOverviewCameraFrame(
  aspect: number,
  sceneHalfExtent = DEFAULT_SCENE_EXTENT,
): ObservatoryCameraFrame {
  return {
    target: { x: 0, y: 0, z: 0 },
    halfExtent: sceneHalfExtent,
    distance: computeCameraFitDistance(sceneHalfExtent, aspect),
    minimumDistance: Math.max(1e-5, sceneHalfExtent * 0.05),
    tier: 'system',
  };
}

export function computeFocusCameraFrame(
  body: BodyState,
  parent: BodyState | null,
  metersToSceneUnit: number,
  aspect: number,
  originMeters: PositionMeters = { x: 0, y: 0, z: 0 },
): ObservatoryCameraFrame {
  const bodyPosition = positionMetersToScene(body.positionMeters, metersToSceneUnit, originMeters);
  const bodyRadius = physicalRadiusToSceneUnits(body.radiusMeters, metersToSceneUnit);

  if (parent === null) {
    const halfExtent = Math.max(MINIMUM_FOCUS_HALF_EXTENT, bodyRadius * 2.4);
    return {
      target: bodyPosition,
      halfExtent,
      distance: computeCameraFitDistance(halfExtent, aspect),
      minimumDistance: Math.max(1e-9, bodyRadius * 1.03),
      tier: 'orbit',
    };
  }

  const parentPosition = positionMetersToScene(
    parent.positionMeters,
    metersToSceneUnit,
    originMeters,
  );
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
    minimumDistance: Math.max(1e-9, Math.max(bodyRadius, parentRadius) * 1.03),
    tier: 'orbit',
  };
}

export function computeBodyInspectionCameraFrame(
  body: BodyState,
  metersToSceneUnit: number,
  aspect: number,
  outerRadiusRatio = 1,
  originMeters: PositionMeters = { x: 0, y: 0, z: 0 },
): ObservatoryCameraFrame {
  if (!Number.isFinite(outerRadiusRatio) || outerRadiusRatio <= 0) {
    throw new RangeError('outerRadiusRatio 必须是正有限数');
  }
  const target = positionMetersToScene(body.positionMeters, metersToSceneUnit, originMeters);
  const bodyRadius = physicalRadiusToSceneUnits(body.radiusMeters, metersToSceneUnit);
  const observableRadius = bodyRadius * outerRadiusRatio;
  const halfExtent = Math.max(1e-12, observableRadius * 2.1);
  return {
    target,
    halfExtent,
    distance: computeCameraFitDistance(halfExtent, aspect),
    minimumDistance: Math.max(1e-12, observableRadius * 1.03),
    tier: 'surface',
  };
}

function distance(left: ScenePosition, right: ScenePosition): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}
